import { useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { useAppStore } from '../../state/store';
import { edges } from '../../core/cubeGeometry';

// Ghost mode: thin wireframe bounding box.
// Full mode: bounding box + Ny translucent XZ planes (one per mesh layer)
//            + vertical wires connecting the corners of each layer, meant
//            to suggest the data/power path running between layers.

const GHOST_COLOR = '#2a3a70';
const FULL_COLOR = '#3a4a88';

function boxEdges(ex: number, ey: number, ez: number): [number, number, number][][] {
  const hx = ex / 2, hy = ey / 2, hz = ez / 2;
  const c = [
    [-hx, -hy, -hz], [ hx, -hy, -hz], [ hx,  hy, -hz], [-hx,  hy, -hz],
    [-hx, -hy,  hz], [ hx, -hy,  hz], [ hx,  hy,  hz], [-hx,  hy,  hz],
  ] as [number, number, number][];
  const pairs: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  return pairs.map(([a, b]) => [c[a], c[b]]);
}

function BoundingBox({
  ex, ey, ez, color, opacity = 1,
}: { ex: number; ey: number; ez: number; color: string; opacity?: number }) {
  const edges = useMemo(() => boxEdges(ex, ey, ez), [ex, ey, ez]);
  return (
    <>
      {edges.map((pts, i) => (
        <Line
          key={i}
          points={pts}
          color={color}
          lineWidth={1}
          transparent={opacity < 1}
          opacity={opacity}
        />
      ))}
    </>
  );
}

function LayerPlanes({ Ny, ex, ey, ez }: { Ny: number; ex: number; ey: number; ez: number }) {
  const spacing = Ny > 1 ? ey / (Ny - 1) : 0;
  const halfY = ey / 2;
  const geom = useMemo(() => new THREE.PlaneGeometry(ex, ez), [ex, ez]);
  const mat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#0a1430',
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.06,
        depthWrite: false,
      }),
    [],
  );
  return (
    <>
      {Array.from({ length: Ny }, (_, y) => (
        <mesh
          key={y}
          geometry={geom}
          material={mat}
          position={[0, y * spacing - halfY, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
        />
      ))}
    </>
  );
}

function LayerColumns({ ex, ey, ez }: { ex: number; ey: number; ez: number }) {
  // Four thin vertical wires at the cube corners connecting all layers.
  const hx = ex / 2, hy = ey / 2, hz = ez / 2;
  const corners: [number, number][] = [
    [-hx, -hz], [ hx, -hz], [ hx,  hz], [-hx,  hz],
  ];
  return (
    <>
      {corners.map(([x, z], i) => (
        <Line
          key={i}
          points={[
            [x, -hy, z],
            [x,  hy, z],
          ]}
          color={FULL_COLOR}
          lineWidth={1}
          transparent
          opacity={0.4}
        />
      ))}
    </>
  );
}

export function StructureOverlay() {
  const mode = useAppStore((s) => s.structureMode);
  const cube = useAppStore((s) => s.cube);

  if (mode === 'clean') return null;

  const e = edges(cube);

  return (
    <>
      <BoundingBox ex={e.x} ey={e.y} ez={e.z} color={GHOST_COLOR} opacity={mode === 'ghost' ? 0.6 : 0.9} />
      {mode === 'full' && (
        <>
          <LayerPlanes Ny={cube.Ny} ex={e.x} ey={e.y} ez={e.z} />
          <LayerColumns ex={e.x} ey={e.y} ez={e.z} />
        </>
      )}
    </>
  );
}
