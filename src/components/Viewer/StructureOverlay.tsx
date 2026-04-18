import { useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { useAppStore } from '../../state/store';

// Ghost mode: thin wireframe bounding box.
// Full mode: bounding box + N translucent XZ planes (one per mesh layer) +
//            a vertical wire connecting the corners of each layer, meant
//            to suggest the data/power path running between layers.

const GHOST_COLOR = '#2a3a70';
const FULL_COLOR = '#3a4a88';

function boxEdges(edge: number): [number, number, number][][] {
  const h = edge / 2;
  const c = [
    [-h, -h, -h], [ h, -h, -h], [ h,  h, -h], [-h,  h, -h],
    [-h, -h,  h], [ h, -h,  h], [ h,  h,  h], [-h,  h,  h],
  ] as [number, number, number][];
  // 12 edges of a cube as pairs of corner indices.
  const pairs: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  return pairs.map(([a, b]) => [c[a], c[b]]);
}

function BoundingBox({ edge, color, opacity = 1 }: { edge: number; color: string; opacity?: number }) {
  const edges = useMemo(() => boxEdges(edge), [edge]);
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

function LayerPlanes({ N, edge }: { N: number; edge: number }) {
  const spacing = N > 1 ? edge / (N - 1) : 0;
  const half = edge / 2;
  const geom = useMemo(() => new THREE.PlaneGeometry(edge, edge), [edge]);
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
      {Array.from({ length: N }, (_, y) => (
        <mesh
          key={y}
          geometry={geom}
          material={mat}
          position={[0, y * spacing - half, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
        />
      ))}
    </>
  );
}

function LayerColumns({ edge }: { edge: number }) {
  // Four thin vertical wires at the cube corners connecting all N layers.
  const h = edge / 2;
  const corners: [number, number][] = [
    [-h, -h], [ h, -h], [ h,  h], [-h,  h],
  ];
  return (
    <>
      {corners.map(([x, z], i) => (
        <Line
          key={i}
          points={[
            [x, -h, z],
            [x,  h, z],
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

  return (
    <>
      <BoundingBox edge={cube.edgeMeters} color={GHOST_COLOR} opacity={mode === 'ghost' ? 0.6 : 0.9} />
      {mode === 'full' && (
        <>
          <LayerPlanes N={cube.N} edge={cube.edgeMeters} />
          <LayerColumns edge={cube.edgeMeters} />
        </>
      )}
    </>
  );
}
