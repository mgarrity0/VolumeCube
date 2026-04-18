import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import {
  useAppStore,
  getCube,
  getActivePattern,
  getActiveParamValues,
  getColorConfig,
  getPowerConfig,
} from '../../state/store';
import { buildCoords, buildPositions, ledCount, spacing } from '../../core/cubeGeometry';
import type { RenderContext, VoxelCoord } from '../../core/patternApi';
import { patternUtils } from '../../core/utils';
import { buildGammaLut, bakeLinearFloats, bakeStreamBytes } from '../../core/colorPipeline';
import { estimatePower } from '../../core/power';
import { audioEngine } from '../../core/audio';
import { buildAddressMap } from '../../core/wiring';
import { transportManager } from '../../core/transports';

// InstancedMesh of all N³ LEDs + per-frame pattern rendering.
//
// Per-frame pipeline:
//   1. audioEngine.update() — fresh FFT bins + beat flag for ctx.audio
//   2. Run the active pattern into patternBuf (Uint8, 0..255).
//   3. Build duty buffer (brightness-scaled) for power estimation.
//   4. estimatePower → pre-ABL amps + scale factor.
//   5. bakeLinearFloats → brightness + gamma + ABL + color-order shuffle
//      written directly into the instanceColor Float32 buffer.
//   6. Throttled push of live power reading into Zustand.
//
// State is read via non-reactive getters so unrelated UI changes don't
// force this component to re-render mid-stream.

const DUMMY = new THREE.Object3D();
const DUMMY_COLOR = new THREE.Color();

// How often to push powerLive into Zustand (every Nth frame). Updates
// the panel readouts at ~7.5 Hz at 60 fps — smooth to read, cheap to
// render.
const POWER_PUSH_INTERVAL = 8;

export function Cube() {
  const cube = useAppStore((s) => s.cube);
  const wiring = useAppStore((s) => s.wiring);
  const ref = useRef<THREE.InstancedMesh>(null);

  const positions = useMemo(() => buildPositions(cube), [cube]);
  const coords = useMemo(() => buildCoords(cube), [cube]);
  const count = ledCount(cube);
  const radius = Math.max(0.005, spacing(cube) * 0.28);

  // Pattern output (0..255) and brightness-applied duty buffer for power.
  // Both resize only when N changes.
  const patternBuf = useMemo(() => new Uint8ClampedArray(count * 3), [count]);
  const dutyBuf = useMemo(() => new Uint8ClampedArray(count * 3), [count]);
  // Stream-ordered 8-bit output for transports. Only populated when a
  // transport is connected.
  const streamBuf = useMemo(() => new Uint8Array(count * 3), [count]);
  // Logical→stream lookup. Rebuilt only when wiring or N changes.
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
  }, [positions, count]);

  useFrame((state, delta) => {
    const mesh = ref.current;
    if (!mesh || !mesh.instanceColor) return;

    const nowMs = performance.now();
    audioEngine.update(nowMs);

    const activePattern = getActivePattern();
    const paramValues = getActiveParamValues();
    const spec = getCube();
    const colorCfg = getColorConfig();
    const powerCfg = getPowerConfig();
    const now = state.clock.getElapsedTime();

    // No active pattern → hold the seed frame and skip work.
    if (!activePattern) {
      return;
    }

    // Rebuild gamma LUT on demand.
    if (gammaLutRef.current.gamma !== colorCfg.gamma) {
      gammaLutRef.current.gamma = colorCfg.gamma;
      gammaLutRef.current.lut = buildGammaLut(colorCfg.gamma);
    }

    // Reset time base + run setup when a new pattern was activated.
    const loadToken = useAppStore.getState().pattern.loadToken;
    if (clock.current.setupCookie !== loadToken) {
      clock.current.setupCookie = loadToken;
      clock.current.patternStart = now;
      clock.current.frame = 0;
      if (activePattern.setup) {
        try {
          activePattern.setup({ N: spec.N, params: paramValues });
        } catch (e) {
          useAppStore.getState().setPatternError(String(e));
          useAppStore.getState().setActivePattern(null);
          return;
        }
      }
    }

    // Pattern ctx gets last frame's power reading — patterns that gate
    // on power see a one-frame-stale value which is fine for brightness
    // compensation effects.
    const lastPower = useAppStore.getState().powerLive;

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
      if (activePattern.kind === 'class' && activePattern.instance) {
        activePattern.instance.update?.(ctx);
        activePattern.instance.render(ctx, patternBuf);
      } else if (activePattern.kind === 'function' && activePattern.renderVoxel) {
        const xyz: VoxelCoord = {
          x: 0, y: 0, z: 0, u: 0, v: 0, w: 0, cx: 0, cy: 0, cz: 0, i: 0,
        };
        const { xs, ys, zs, us, vs, ws, cxs, cys, czs, count: n } = coords;
        for (let i = 0; i < n; i++) {
          xyz.x = xs[i]; xyz.y = ys[i]; xyz.z = zs[i];
          xyz.u = us[i]; xyz.v = vs[i]; xyz.w = ws[i];
          xyz.cx = cxs[i]; xyz.cy = cys[i]; xyz.cz = czs[i];
          xyz.i = i;
          const rgb = activePattern.renderVoxel(ctx, xyz);
          patternBuf[i * 3 + 0] = rgb[0];
          patternBuf[i * 3 + 1] = rgb[1];
          patternBuf[i * 3 + 2] = rgb[2];
        }
      }
    } catch (e) {
      useAppStore.getState().setPatternError(String(e));
      useAppStore.getState().setActivePattern(null);
      return;
    }

    // Build duty buffer (brightness-applied, pre-gamma) for power estimate.
    // This matches what the strip's LED dies actually PWM at.
    const brightness = colorCfg.brightness;
    const n3 = count * 3;
    for (let i = 0; i < n3; i++) {
      const v = patternBuf[i] * brightness;
      dutyBuf[i] = v > 255 ? 255 : v;
    }

    const pre = estimatePower(dutyBuf, powerCfg);
    const ablScale = pre.scale;

    // Bake the final floats in one pass (brightness + gamma + ABL + shuffle).
    const ic = mesh.instanceColor;
    const floatOut = ic.array as Float32Array;
    bakeLinearFloats(patternBuf, floatOut, colorCfg, gammaLutRef.current.lut, ablScale);
    ic.needsUpdate = true;

    // Hardware stream. Only produced + sent when a transport is live so
    // the simulator-only path stays cheap.
    if (transportManager.connected) {
      bakeStreamBytes(patternBuf, streamBuf, colorCfg, gammaLutRef.current.lut, ablScale, addressMap);
      transportManager.trySend(streamBuf, useAppStore.getState().output);
    }

    // Throttled live-power push. The values we report are post-ABL — what
    // the strip actually draws — so the readout matches reality when ABL
    // is limiting.
    if ((clock.current.frame % POWER_PUSH_INTERVAL) === 0) {
      useAppStore.getState().setPowerLive({
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
