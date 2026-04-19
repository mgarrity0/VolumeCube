import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useAppStore } from '../../state/store';
import { buildCoords, ledCount, spacing } from '../../core/cubeGeometry';
import type { RenderContext } from '../../core/patternApi';
import { patternUtils } from '../../core/utils';
import { buildGammaLut, computeDuty, bakeFrame } from '../../core/colorPipeline';
import { estimatePower } from '../../core/power';
import { audioEngine } from '../../core/audio';
import { buildAddressMap } from '../../core/wiring';
import { transportManager } from '../../core/transports';
import { renderPatternFrame } from '../../core/patternRender';
import { createLedPointsMaterial } from './ledPointsMaterial';

// Points primitive + per-frame pattern rendering.
//
// Per-frame pipeline:
//   1. audioEngine.update() — fresh FFT bins + beat flag for ctx.audio
//   2. Run the active pattern into patternBuf (Uint8, 0..255).
//   3. computeDuty → dutyBuf (brightness-scaled) for power estimate.
//   4. estimatePower → pre-ABL amps + scale factor.
//   5. bakeFrame — brightness + gamma + ABL + color-order shuffle written
//      into the Float32 color attribute and, if a transport is live,
//      also into the stream-ordered byte buffer in the same pass.
//
// Hot state is read once per frame via a single getState() snapshot so
// unrelated UI changes don't force this component to re-render mid-stream.

// How often to push powerLive into Zustand (every Nth frame). Updates
// the panel readouts at ~7.5 Hz at 60 fps.
const POWER_PUSH_INTERVAL = 8;

// LED billboard diameter as a fraction of inter-LED spacing. A value
// < 1 leaves visible gaps between LEDs (reads as a grid) while > 1
// lets halos overlap (reads as a continuous volume).
const LED_SIZE_FACTOR = 0.55;

export function Cube() {
  const cube = useAppStore((s) => s.cube);
  const wiring = useAppStore((s) => s.wiring);
  const pointsRef = useRef<THREE.Points>(null);
  const { size, camera } = useThree();

  const coords = useMemo(() => buildCoords(cube), [cube]);
  const count = ledCount(cube);
  const sizeMeters = Math.max(0.005, spacing(cube) * LED_SIZE_FACTOR);

  const patternBuf = useMemo(() => new Uint8ClampedArray(count * 3), [count]);
  const dutyBuf = useMemo(() => new Uint8ClampedArray(count * 3), [count]);
  const streamBuf = useMemo(() => new Uint8Array(count * 3), [count]);
  const addressMap = useMemo(() => buildAddressMap(wiring, cube.N), [wiring, cube.N]);

  // Shader material + its uniforms live outside React so the per-frame
  // loop can touch them without causing re-renders. Rebuilt only on cube
  // rebuild so uSizeMeters tracks the new spacing.
  const material = useMemo(() => createLedPointsMaterial(sizeMeters), [sizeMeters]);

  // Geometry with position + color buffer attributes. Pre-allocated and
  // updated in place every frame — we never reallocate in the hot path.
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(coords.positions.slice(), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    return g;
  }, [coords, count]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  // Cached gamma LUT — rebuilt only when colorCfg.gamma changes.
  const gammaLutRef = useRef<{ gamma: number; lut: Float32Array }>({
    gamma: -1,
    lut: new Float32Array(256),
  });

  const clock = useRef({
    patternStart: 0,
    frame: 0,
    setupCookie: -1,
  });

  // Seed a warm-white default color on cube rebuild so the points are
  // visible before the first pattern frame runs.
  useEffect(() => {
    const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute;
    const arr = colorAttr.array as Float32Array;
    for (let i = 0; i < count; i++) {
      arr[i * 3 + 0] = 1.0;
      arr[i * 3 + 1] = 0.95;
      arr[i * 3 + 2] = 0.85;
    }
    colorAttr.needsUpdate = true;
    clock.current.setupCookie = -1;
  }, [geometry, count]);

  // Recompute uPxPerMeter whenever the viewport size or the camera FOV
  // changes. PerspectiveCamera.fov is in degrees; the formula is the
  // standard perspective projection ratio.
  useEffect(() => {
    const persp = camera as THREE.PerspectiveCamera;
    const fovRad = (persp.fov * Math.PI) / 180;
    const pxPerMeter = (size.height * 0.5) / Math.tan(fovRad * 0.5);
    material.uniforms.uPxPerMeter.value = pxPerMeter;
    material.uniforms.uSizeMeters.value = sizeMeters;
  }, [size.height, camera, material, sizeMeters]);

  useFrame((state, delta) => {
    const points = pointsRef.current;
    if (!points) return;
    const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute;

    const nowMs = performance.now();
    audioEngine.update(nowMs);

    const store = useAppStore.getState();
    const activePattern = store.pattern.active;
    if (!activePattern) return;

    const spec = store.cube;
    const colorCfg = store.color;
    const powerCfg = store.power;
    const paramValues = store.pattern.paramValues[activePattern.name] ?? {};
    const loadToken = store.pattern.loadToken;
    const lastPower = store.powerLive;
    const outputCfg = store.output;
    const now = state.clock.getElapsedTime();

    // Rebuild gamma LUT on demand.
    if (gammaLutRef.current.gamma !== colorCfg.gamma) {
      gammaLutRef.current.gamma = colorCfg.gamma;
      gammaLutRef.current.lut = buildGammaLut(colorCfg.gamma);
    }

    // Reset time base + run setup when a new pattern was activated.
    if (clock.current.setupCookie !== loadToken) {
      clock.current.setupCookie = loadToken;
      clock.current.patternStart = now;
      clock.current.frame = 0;
      if (activePattern.setup) {
        try {
          activePattern.setup({ N: spec.N, params: paramValues });
        } catch (e) {
          store.setPatternError(String(e));
          store.setActivePattern(null);
          return;
        }
      }
    }

    const ctx: RenderContext = {
      t: now - clock.current.patternStart,
      dt: delta,
      frame: clock.current.frame++,
      N: spec.N,
      params: paramValues,
      audio: {
        energy: audioEngine.energy,
        low: audioEngine.low,
        mid: audioEngine.mid,
        high: audioEngine.high,
        beat: audioEngine.beat,
      },
      power: {
        amps: lastPower.amps,
        watts: lastPower.watts,
        budgetAmps: powerCfg.budgetAmps,
        scale: lastPower.scale,
      },
      utils: patternUtils,
    };

    try {
      renderPatternFrame(activePattern, ctx, coords, patternBuf);
    } catch (e) {
      store.setPatternError(String(e));
      store.setActivePattern(null);
      return;
    }

    // Power estimate wants a brightness-scaled buffer; gamma is perceptual
    // so the LED dies see linear duty, not gamma-shaped.
    computeDuty(patternBuf, colorCfg.brightness, dutyBuf);
    const pre = estimatePower(dutyBuf, powerCfg);
    const ablScale = pre.scale;

    // One-pass bake: float output always, stream output only when a
    // transport is connected.
    const floatOut = colorAttr.array as Float32Array;
    const connected = transportManager.connected;
    bakeFrame(
      patternBuf,
      colorCfg,
      gammaLutRef.current.lut,
      ablScale,
      connected ? addressMap : null,
      floatOut,
      connected ? streamBuf : null,
    );
    colorAttr.needsUpdate = true;
    if (connected) transportManager.trySend(streamBuf, outputCfg);

    // Throttled power push — both pre-ABL (what the pattern wanted) and
    // post-ABL (what the strip actually pulls) so the panel can show the
    // delta the limiter absorbed.
    if ((clock.current.frame % POWER_PUSH_INTERVAL) === 0) {
      store.setPowerLive({
        amps: pre.amps * ablScale,
        watts: pre.watts * ablScale,
        rawAmps: pre.amps,
        rawWatts: pre.watts,
        scale: ablScale,
        overBudget: pre.overBudget,
      });
    }
  });

  return (
    <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} />
  );
}
