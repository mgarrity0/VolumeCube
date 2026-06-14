import React, { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useAppStore } from '../../state/store';
import { buildCoords, spacing } from '../../core/cubeGeometry';
import { buildAddressMapForCube, buildStreamPath } from '../../core/wiring';

// Wiring overlay — built to answer one question fast: "which end is the
// start, and which way does the data flow?" Three unambiguous cues, no
// color-memorization required:
//
//   1. Floating TEXT labels: a green "▶ START · 0" tag at the first LED
//      and a red "■ END · N" tag at the last. The words remove all doubt.
//   2. A glowing COMET that continuously streaks along the wire in the
//      data-flow direction (start → end, then repeats). Direction reads
//      at a glance even in a still glance, and it's mesmerizing-not-noisy.
//   3. Labeled TICKS at each output boundary (pulled from the FastLED
//      multi-output bake layout) — e.g. "Q2 · 200" sits exactly where
//      output 2's chain begins, so you can map the physical strip to the
//      data order one output at a time.
//
// A faint red→blue gradient line still traces the full route underneath.

const START_MARKER_RATIO = 0.8;    // start sphere radius vs LED pitch
const END_MARKER_RATIO = 0.7;      // end sphere radius vs LED pitch
const TICK_MARKER_RATIO = 0.5;     // output-boundary tick radius vs pitch
const COMET_LEN = 14;              // head + tail segments
const COMET_SECONDS = 4.5;         // time for the comet to traverse the whole path

type Tick = { pos: [number, number, number]; label: string };

const labelBase: React.CSSProperties = {
  pointerEvents: 'none',
  userSelect: 'none',
  whiteSpace: 'nowrap',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  fontWeight: 700,
  padding: '2px 6px',
  borderRadius: 5,
  color: '#fff',
  transform: 'translateY(-1.4em)',   // float just above the marker sphere
  boxShadow: '0 1px 4px rgba(0,0,0,0.6)',
};

export function WiringPathOverlay() {
  const show = useAppStore((s) => s.showWiringPath);
  const showComet = useAppStore((s) => s.showWiringComet);
  const cube = useAppStore((s) => s.cube);
  const wiring = useAppStore((s) => s.wiring);
  const output = useAppStore((s) => s.output);

  const { positions, colors, startPos, endPos, count, ticks } = useMemo(() => {
    const logical = buildCoords(cube).positions;
    const map = buildAddressMapForCube(cube, wiring);
    const streamPositions = buildStreamPath(map, logical);
    const count = streamPositions.length / 3;

    const c = new Float32Array(count * 3);
    const tmp = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0;
      // Red (start) → yellow → green → cyan → blue (end).
      tmp.setHSL(t * 0.7, 0.9, 0.55);
      c[i * 3 + 0] = tmp.r;
      c[i * 3 + 1] = tmp.g;
      c[i * 3 + 2] = tmp.b;
    }

    const at = (i: number): [number, number, number] => [
      streamPositions[i * 3 + 0],
      streamPositions[i * 3 + 1],
      streamPositions[i * 3 + 2],
    ];
    const startPos = count > 0 ? at(0) : [0, 0, 0] as [number, number, number];
    const endPos = count > 0 ? at(count - 1) : [0, 0, 0] as [number, number, number];

    // Output-boundary ticks from the multi-board bake layout. Each output
    // owns a contiguous slice of the global stream; its first LED's
    // physical position is where that output's chain begins.
    const ticks: Tick[] = [];
    const boards = output.exportBoards ?? [];
    for (const b of boards) {
      for (const o of b.outputs) {
        const globalStart = b.ledStart + o.ledStart;
        if (globalStart <= 0 || globalStart >= count) continue; // 0 == START already
        const label = o.label ? `${o.label} · ${globalStart}` : `· ${globalStart}`;
        ticks.push({ pos: at(globalStart), label });
      }
    }

    return { positions: streamPositions, colors: c, startPos, endPos, count, ticks };
  }, [cube, wiring, output.exportBoards]);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  }, [positions, colors]);

  const pitch = spacing(cube);
  const cometGeometry = useMemo(() => new THREE.SphereGeometry(1, 12, 12), []);
  const cometRef = useRef<THREE.InstancedMesh>(null);
  const head = useRef(0);
  // Scratch objects reused each frame (no per-frame allocation).
  const scratch = useMemo(
    () => ({ dummy: new THREE.Object3D(), col: new THREE.Color() }),
    [],
  );

  // The comet: a bright white head with a fading tail that crawls along
  // the stream path in data-flow order, looping start → end. This is the
  // primary "which way" cue — no need to decode the gradient.
  useFrame((_, dt) => {
    const mesh = cometRef.current;
    if (!mesh || count < 2 || !showComet) return;
    const { dummy, col } = scratch;
    const speed = count / COMET_SECONDS; // LEDs per second
    head.current = (head.current + dt * speed) % count;
    const h = head.current;
    const headSize = pitch * 0.75;

    for (let k = 0; k < COMET_LEN; k++) {
      const idx = Math.floor(h) - k;
      if (idx < 0) {
        // Tail would run past the start — park this segment invisibly
        // rather than wrap it round from the END (which would mislead).
        dummy.position.set(0, 0, 0);
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        mesh.setMatrixAt(k, dummy.matrix);
        continue;
      }
      const taper = 1 - k / COMET_LEN;        // 1 at head → ~0 at tail
      dummy.position.set(
        positions[idx * 3 + 0],
        positions[idx * 3 + 1],
        positions[idx * 3 + 2],
      );
      dummy.scale.setScalar(headSize * (0.35 + 0.65 * taper));
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
      // White-hot head (blooms) fading to dark down the tail.
      const b = 0.15 + taper * taper * 1.1;
      col.setRGB(b, b, b);
      mesh.setColorAt(k, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  if (!show) return null;

  const startRadius = pitch * START_MARKER_RATIO;
  const endRadius = pitch * END_MARKER_RATIO;
  const tickRadius = pitch * TICK_MARKER_RATIO;

  // R3F's `<line>` intrinsic resolves to the DOM SVGLineElement type in TS;
  // cast so we get THREE.Line. R3F builds the right object at runtime.
  const ThreeLine = 'line' as unknown as React.ElementType;

  return (
    <group>
      {/* Faint full-route gradient line. */}
      <ThreeLine geometry={geometry}>
        <lineBasicMaterial
          vertexColors
          transparent
          opacity={0.45}
          toneMapped={false}
          depthTest={false}
        />
      </ThreeLine>

      {/* Flow comet — bright head + fading tail, no per-instance vertex
          colors (InstancedMesh instanceColor is what we drive). Toggle
          off to read the static labels/ticks without the motion. */}
      {showComet && (
        <instancedMesh
          ref={cometRef}
          args={[cometGeometry, undefined, COMET_LEN]}
          frustumCulled={false}
        >
          <meshBasicMaterial toneMapped={false} transparent depthTest={false} />
        </instancedMesh>
      )}

      {/* START — green, labeled. */}
      <mesh position={startPos}>
        <sphereGeometry args={[startRadius, 20, 20]} />
        <meshBasicMaterial color="#28ff5a" toneMapped={false} transparent opacity={0.95} depthTest={false} />
      </mesh>
      <Html position={startPos} center zIndexRange={[100, 0]}>
        <div style={{ ...labelBase, background: '#0a7a2a', border: '1px solid #28ff5a' }}>
          ▶ START · 0
        </div>
      </Html>

      {/* END — red, labeled. */}
      <mesh position={endPos}>
        <sphereGeometry args={[endRadius, 18, 18]} />
        <meshBasicMaterial color="#ff2a2a" toneMapped={false} transparent opacity={0.95} depthTest={false} />
      </mesh>
      <Html position={endPos} center zIndexRange={[100, 0]}>
        <div style={{ ...labelBase, background: '#8a1010', border: '1px solid #ff5a5a' }}>
          ■ END · {Math.max(0, count - 1)}
        </div>
      </Html>

      {/* Output-boundary ticks — cyan dot + label at each output's first LED. */}
      {ticks.map((t, i) => (
        <group key={i}>
          <mesh position={t.pos}>
            <sphereGeometry args={[tickRadius, 12, 12]} />
            <meshBasicMaterial color="#30d0ff" toneMapped={false} transparent opacity={0.9} depthTest={false} />
          </mesh>
          <Html position={t.pos} center zIndexRange={[90, 0]}>
            <div style={{ ...labelBase, fontSize: 10, background: '#0a4a66', border: '1px solid #30d0ff' }}>
              {t.label}
            </div>
          </Html>
        </group>
      ))}
    </group>
  );
}
