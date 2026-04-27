import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useAppStore } from '../../state/store';
import { buildCoords, spacing } from '../../core/cubeGeometry';
import { buildAddressMap, buildStreamPath } from '../../core/wiring';

// Wiring overlay: polyline through every LED in stream order, ~50
// arrowhead cones spaced along it pointing in the data-flow direction,
// plus distinct START and END markers. Used to verify that the wiring
// config in StructurePanel matches the real cube — if the line enters
// at the wrong corner or hops on the wrong axis, the overlay will
// visibly disagree with the strip route.
//
// Color: HSL sweep red (start) → blue (end) on both line and arrows so
// flow direction reads at a glance even before you see the cones. The
// START marker is a bright white-yellow sphere (large, blooms hard)
// and the END marker is a smaller dark sphere — unambiguous which end
// is which from any angle.

const TARGET_ARROW_COUNT = 48;
const ARROW_SIZE_RATIO = 0.6;      // arrow length as a fraction of LED pitch
const START_MARKER_RATIO = 0.85;   // start sphere radius vs pitch
const END_MARKER_RATIO = 0.55;     // end sphere radius vs pitch

type Arrow = {
  px: number; py: number; pz: number;
  dx: number; dy: number; dz: number;
  r: number; g: number; b: number;
};

export function WiringPathOverlay() {
  const show = useAppStore((s) => s.showWiringPath);
  const cube = useAppStore((s) => s.cube);
  const wiring = useAppStore((s) => s.wiring);

  const { positions, colors, arrows, startPos, endPos } = useMemo(() => {
    const logical = buildCoords(cube).positions;
    const map = buildAddressMap(wiring, cube.Nx, cube.Ny, cube.Nz);
    const streamPositions = buildStreamPath(map, logical);
    const count = streamPositions.length / 3;

    const c = new Float32Array(count * 3);
    const tmp = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0;
      // Red → yellow → green → cyan → blue as the stream progresses.
      tmp.setHSL(t * 0.7, 0.9, 0.55);
      c[i * 3 + 0] = tmp.r;
      c[i * 3 + 1] = tmp.g;
      c[i * 3 + 2] = tmp.b;
    }

    // Sample arrow positions evenly along the stream. Skip degenerate
    // segments (zero-length, in case of duplicate endpoints).
    const arrowList: Arrow[] = [];
    if (count >= 2) {
      const stride = Math.max(1, Math.floor((count - 1) / TARGET_ARROW_COUNT));
      for (let i = stride; i < count; i += stride) {
        const x0 = streamPositions[(i - 1) * 3 + 0];
        const y0 = streamPositions[(i - 1) * 3 + 1];
        const z0 = streamPositions[(i - 1) * 3 + 2];
        const x1 = streamPositions[i * 3 + 0];
        const y1 = streamPositions[i * 3 + 1];
        const z1 = streamPositions[i * 3 + 2];
        const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-6) continue;
        const t = i / (count - 1);
        // Arrows a touch brighter than the line so they read against bloom.
        tmp.setHSL(t * 0.7, 1.0, 0.65);
        arrowList.push({
          px: (x0 + x1) * 0.5,
          py: (y0 + y1) * 0.5,
          pz: (z0 + z1) * 0.5,
          dx: dx / len, dy: dy / len, dz: dz / len,
          r: tmp.r, g: tmp.g, b: tmp.b,
        });
      }
    }

    const startPos: [number, number, number] = count > 0
      ? [streamPositions[0], streamPositions[1], streamPositions[2]]
      : [0, 0, 0];
    const endPos: [number, number, number] = count > 0
      ? [
          streamPositions[(count - 1) * 3 + 0],
          streamPositions[(count - 1) * 3 + 1],
          streamPositions[(count - 1) * 3 + 2],
        ]
      : [0, 0, 0];

    return { positions: streamPositions, colors: c, arrows: arrowList, startPos, endPos };
  }, [cube, wiring]);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  }, [positions, colors]);

  // Cone tip is at +Z. For a regular Object3D (not a camera),
  // lookAt(target) orients the local +Z axis toward the target — the
  // opposite of the camera convention. ConeGeometry's default tip is
  // at +Y, so rotate +90° around X: that takes +Y → +Z.
  const arrowSize = spacing(cube) * ARROW_SIZE_RATIO;
  const arrowGeometry = useMemo(() => {
    const g = new THREE.ConeGeometry(arrowSize * 0.5, arrowSize, 10);
    g.rotateX(Math.PI / 2);
    return g;
  }, [arrowSize]);

  const instancedRef = useRef<THREE.InstancedMesh>(null);

  // Re-run when `show` flips so the freshly-mounted InstancedMesh gets
  // its per-instance matrices and colors set. Without `show` in the
  // deps, the effect would have run once when the mesh wasn't mounted
  // and never again until `arrows` changed.
  useEffect(() => {
    const mesh = instancedRef.current;
    if (!mesh) return;
    const dummy = new THREE.Object3D();
    const target = new THREE.Vector3();
    const tmpColor = new THREE.Color();
    for (let i = 0; i < arrows.length; i++) {
      const a = arrows[i];
      dummy.position.set(a.px, a.py, a.pz);
      target.set(a.px + a.dx, a.py + a.dy, a.pz + a.dz);
      dummy.lookAt(target);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      tmpColor.setRGB(a.r, a.g, a.b);
      mesh.setColorAt(i, tmpColor);
    }
    // Hide unused instances with a zero-scale matrix.
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = arrows.length; i < mesh.count; i++) {
      mesh.setMatrixAt(i, zero);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [arrows, show]);

  if (!show) return null;

  // InstancedMesh count is fixed (cap + slack) so the mesh isn't
  // recreated when arrow count fluctuates by one or two across re-memos.
  const instancedCount = TARGET_ARROW_COUNT + 8;
  const startRadius = spacing(cube) * START_MARKER_RATIO;
  const endRadius = spacing(cube) * END_MARKER_RATIO;

  // R3F's `<line>` intrinsic targets THREE.Line, but TS resolves <line>
  // against the DOM SVGLineElement type first. Bypass via cast — R3F
  // still constructs the right object at runtime.
  const ThreeLine = 'line' as unknown as React.ElementType;

  return (
    <group>
      <ThreeLine geometry={geometry}>
        <lineBasicMaterial
          vertexColors
          transparent
          opacity={0.75}
          toneMapped={false}
          depthTest={false}
        />
      </ThreeLine>
      {/* Arrows. NO `vertexColors` on the material — InstancedMesh's
          per-instance color attribute is what we want, and setting
          vertexColors makes three look at the geometry's color attribute
          instead (which we never write). */}
      <instancedMesh
        ref={instancedRef}
        args={[arrowGeometry, undefined, instancedCount]}
        frustumCulled={false}
      >
        <meshBasicMaterial
          toneMapped={false}
          transparent
          opacity={0.95}
          depthTest={false}
        />
      </instancedMesh>
      {/* START marker — bright white-yellow sphere, ~LED-sized × 0.85 in
          radius. Bloom picks it up hard so it's unmistakable. */}
      <mesh position={startPos}>
        <sphereGeometry args={[startRadius, 20, 20]} />
        <meshBasicMaterial
          color="#fff5b0"
          toneMapped={false}
          transparent
          opacity={0.95}
          depthTest={false}
        />
      </mesh>
      {/* END marker — smaller, dim purple. Unambiguously the other end. */}
      <mesh position={endPos}>
        <sphereGeometry args={[endRadius, 14, 14]} />
        <meshBasicMaterial
          color="#3030a0"
          toneMapped={false}
          transparent
          opacity={0.9}
          depthTest={false}
        />
      </mesh>
    </group>
  );
}
