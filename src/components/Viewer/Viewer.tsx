import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import { useAppStore, StructureMode, CameraPreset } from '../../state/store';
import { Cube } from './Cube';
import { StructureOverlay } from './StructureOverlay';
import { WiringPathOverlay } from './WiringPathOverlay';
import { ErrorBoundary } from '../ErrorBoundary';
import {
  CAM_PRESETS,
  DEFAULT_CAM,
  TWEEN_DURATION,
  easeOutCubic,
} from './cameraPresets';

const PRESET_BUTTONS: { key: CameraPreset; label: string }[] = [
  { key: 'front', label: 'Front' },
  { key: 'side', label: 'Side' },
  { key: 'top', label: 'Top' },
  { key: 'iso', label: 'Iso' },
];

const MODES: { key: StructureMode; label: string }[] = [
  { key: 'clean', label: 'Clean' },
  { key: 'ghost', label: 'Ghost' },
  { key: 'full', label: 'Full' },
];

type TweenState = {
  t: number;
  duration: number;
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
  startTarget: THREE.Vector3;
  endTarget: THREE.Vector3;
};

function CameraController() {
  const preset = useAppStore((s) => s.cameraPreset);
  const setPreset = useAppStore((s) => s.setCameraPreset);
  const { camera } = useThree();
  // OrbitControls.target is typed through three-stdlib; `any` avoids the
  // re-export churn — this is the same shortcut Orbiter uses.
  const controlsRef = useRef<any>(null);
  const tween = useRef<TweenState | null>(null);

  useEffect(() => {
    if (preset === 'orbit') return;
    const view = CAM_PRESETS[preset];
    if (!view || !controlsRef.current) return;
    tween.current = {
      t: 0,
      duration: TWEEN_DURATION,
      startPos: camera.position.clone(),
      endPos: new THREE.Vector3(...view.pos),
      startTarget: controlsRef.current.target.clone(),
      endTarget: new THREE.Vector3(...view.target),
    };
  }, [preset, camera]);

  useFrame((_, delta) => {
    const t = tween.current;
    if (!t) return;
    t.t = Math.min(1, t.t + delta / t.duration);
    const e = easeOutCubic(t.t);
    camera.position.lerpVectors(t.startPos, t.endPos, e);
    controlsRef.current?.target.lerpVectors(t.startTarget, t.endTarget, e);
    controlsRef.current?.update();
    if (t.t >= 1) {
      tween.current = null;
      // Drop back to 'orbit' so clicking the same preset again re-tweens.
      setPreset('orbit');
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      target={[0, 0, 0]}
      enableDamping
      dampingFactor={0.08}
      minDistance={0.3}
      maxDistance={20}
    />
  );
}

function Toolbar() {
  const setPreset = useAppStore((s) => s.setCameraPreset);
  return (
    <div className="viewer-toolbar">
      {PRESET_BUTTONS.map((p) => (
        <button key={p.key} onClick={() => setPreset(p.key)}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

function ModeToggle() {
  const mode = useAppStore((s) => s.structureMode);
  const setMode = useAppStore((s) => s.setStructureMode);
  return (
    <div className="viewer-bottom-left">
      {MODES.map((m) => (
        <button
          key={m.key}
          className={mode === m.key ? 'active' : ''}
          onClick={() => setMode(m.key)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

export function Viewer() {
  return (
    <div className="viewer">
      <Toolbar />
      <div className="viewer-hint">Shift+drag to orbit</div>
      <ModeToggle />
      <div className="viewer-canvas-wrap">
        <ErrorBoundary
          fallback={(err, reset) => (
            <div className="viewer-error">
              <div className="viewer-error-title">Viewer crashed</div>
              <pre className="viewer-error-msg">{err.message}</pre>
              <button onClick={reset}>Reset viewer</button>
            </div>
          )}
        >
          <Canvas
            camera={{ position: DEFAULT_CAM.pos, fov: 50, near: 0.05, far: 200 }}
            gl={{ antialias: true, alpha: false }}
            dpr={[1, 2]}
          >
            <color attach="background" args={['#000']} />
            <CameraController />
            <Cube />
            <StructureOverlay />
            <WiringPathOverlay />
            <EffectComposer>
              <Bloom
                intensity={1.2}
                luminanceThreshold={0.2}
                luminanceSmoothing={0.4}
                mipmapBlur
              />
              <Vignette offset={0.3} darkness={0.6} />
            </EffectComposer>
          </Canvas>
        </ErrorBoundary>
      </div>
    </div>
  );
}
