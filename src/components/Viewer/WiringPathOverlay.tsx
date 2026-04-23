import { useMemo } from 'react';
import * as THREE from 'three';
import { useAppStore } from '../../state/store';
import { buildCoords } from '../../core/cubeGeometry';
import { buildAddressMap, buildStreamPath } from '../../core/wiring';

// Thin polyline through all LEDs in stream order. Used to eyeball whether
// the wiring config in StructurePanel matches the real cube — if the line
// enters at the wrong corner or hops between layers on the wrong axis,
// the path will visibly not match the physical strip route.
//
// Color is an HSL sweep from red (start of stream) to blue (end), so the
// data-flow direction is visible at a glance. Rendered as a basic three.js
// <line> (1-pixel strokes) which is cheaper than drei's fat-line for the
// N³ = 1000 vertices we push through here.

export function WiringPathOverlay() {
  const show = useAppStore((s) => s.showWiringPath);
  const cube = useAppStore((s) => s.cube);
  const wiring = useAppStore((s) => s.wiring);

  const { positions, colors } = useMemo(() => {
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
    return { positions: streamPositions, colors: c };
  }, [cube, wiring]);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  }, [positions, colors]);

  if (!show) return null;

  return (
    // @ts-expect-error — R3F's three-line intrinsic clashes with SVG `line`
    // in the DOM JSX namespace; the actual target here is THREE.Line.
    <line geometry={geometry}>
      <lineBasicMaterial
        vertexColors
        transparent
        opacity={0.75}
        toneMapped={false}
        depthTest={false}
      />
    </line>
  );
}
