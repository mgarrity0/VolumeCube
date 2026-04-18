import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
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

// InstancedMesh of all N³ LEDs + per-frame pattern rendering.
//
// Per-frame pipeline:
//   1. audioEngine.update() — fresh FFT bins + beat flag for ctx.audio
//   2. Run the active pattern into patternBuf (Uint8, 0..255).
//   3. computeDuty → dutyBuf (brightness-scaled) for power estimate.
//   4. estimatePower → pre-ABL amps + scale factor.
//   5. bakeFrame — brightness + gamma + ABL + color-order shuffle written
//      into the Float32 instanceColor buffer and, if a transport is live,
//      also into the stream-ordered byte buffer in the same pass.
//
// Hot state is read once per frame via a single getState() snapshot so
// unrelated UI changes don't force this component to re-render mid-stream.

const DUMMY = new THREE.Object3D();
const DUMMY_COLOR = new THREE.Color();

// How often to push powerLive into Zustand (every Nth frame). Updates
// the panel readouts at ~7.5 Hz at 60 fps.
const POWER_PUSH_INTERVAL = 8;

export function Cube() {
  const cube = useAppStore((s) => s.cube);
  const wiring = useAppStore((s) => s.wiring);
  const ref = useRef<THREE.InstancedMesh>(null);

  const coords = useMemo(() => buildCoords(cube), [cube]);
  const count = ledCount(cube);
  const radius = Math.max(0.005, spacing(cube) * 0.28);

  const patternBuf = useMemo(() => new Uint8ClampedArray(count * 3), [count]);
  const dutyBuf = useMemo(() => new Uint8ClampedArray(count * 3), [count]);
  const streamBuf = useMemo(() => new Uint8Array(count * 3), [count]);
  const addressMap = useMemo(() => buildAddressMap(wiring, cube.N), [wiring, cube.N]);

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

  // Seed positions + warm-white default when the cube rebuilds.
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const { positions } = coords;
    for (let i = 0; i < count; i++) {
      DUMMY.position.set(
        positions[i * 3 + 0],
        positions[i * 3 + 1],
        positions[i * 3 + 2],
      );
      DUMMY.updateMatrix();
      mesh.setMatrixAt(i, DUMMY.matrix);
      DUMMY_COLOR.setRGB(1.0, 0.95, 0.85);
      mesh.setColorAt(i, DUMMY_COLOR);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.count = count;
    clock.current.setupCookie = -1;
  }, [coords, count]);

  useFrame((state, delta) => {
    const mesh = ref.current;
    if (!mesh || !mesh.instanceColor) return;

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
    const ic = mesh.instanceColor;
    const floatOut = ic.array as Float32Array;
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
    ic.needsUpdate = true;
    if (connected) transportManager.trySend(streamBuf, outputCfg);

    // Throttled post-ABL power push.
    if ((clock.current.frame % POWER_PUSH_INTERVAL) === 0) {
      store.setPowerLive({
        amps: pre.amps * ablScale,
        watts: pre.watts * ablScale,
        scale: ablScale,
        overBudget: pre.overBudget,
      });
    }
  });

  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, count]}
      frustumCulled={false}
    >
      <sphereGeometry args={[radius, 8, 6]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}
