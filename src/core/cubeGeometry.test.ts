import { describe, it, expect } from 'vitest';
import {
  buildCoords,
  ledCount,
  edges,
  gridDims,
  discRadius,
  DEFAULT_LATTICE_CUBE,
  DEFAULT_FIBONACCI_CUBE,
  type FibonacciSpec,
} from './cubeGeometry';

// Lattice mode is exhaustively covered by wiring.test.ts via the address
// map bijection sweeps — this file focuses on Fibonacci, where the ways
// to silently break things (off-by-one in stream order, wrong centering,
// non-uniform density) all show up in geometry rather than wiring.

describe('lattice geometry (sanity)', () => {
  it('default lattice has the expected total LED count', () => {
    expect(ledCount(DEFAULT_LATTICE_CUBE)).toBe(10 * 10 * 10);
  });

  it('z=0 maps to the front (+world Z) face', () => {
    // z=0 should sit at +halfZ, NOT -halfZ. Regression guard for the
    // Z-flip convention I shipped a few commits back.
    const coords = buildCoords(DEFAULT_LATTICE_CUBE);
    // Find a voxel at x=0, y=0, z=0. Logical index = 0*Ny*Nz + 0*Nz + 0 = 0.
    const z0Position = coords.positions[2];
    expect(z0Position).toBeGreaterThan(0);
    // And z=Nz-1 should be at -halfZ.
    const lastIdx = (DEFAULT_LATTICE_CUBE.Nz - 1);
    expect(coords.positions[lastIdx * 3 + 2]).toBeLessThan(0);
  });
});

describe('Fibonacci geometry', () => {
  it('default Fibonacci has spiralCount × strandLength LEDs', () => {
    expect(ledCount(DEFAULT_FIBONACCI_CUBE)).toBe(
      DEFAULT_FIBONACCI_CUBE.spiralCount * DEFAULT_FIBONACCI_CUBE.strandLength,
    );
  });

  it('gridDims exposes (N, K, 1) so RenderContext stays uniform', () => {
    const d = gridDims(DEFAULT_FIBONACCI_CUBE);
    expect(d.Nx).toBe(DEFAULT_FIBONACCI_CUBE.spiralCount);
    expect(d.Ny).toBe(DEFAULT_FIBONACCI_CUBE.strandLength);
    expect(d.Nz).toBe(1);
  });

  it('disc node n=0 collapses to the origin (no central hot spot)', () => {
    // The Vogel formula r = c·√n gives r=0 at n=0, so strand 0 is the
    // center vertical axis. Logical index 0 is the BOTTOM of that
    // strand (lattice convention: y=0 = bottom).
    const coords = buildCoords(DEFAULT_FIBONACCI_CUBE);
    expect(coords.positions[0]).toBeCloseTo(0, 6);     // x
    expect(coords.positions[2]).toBeCloseTo(0, 6);     // z
    const halfY = ((DEFAULT_FIBONACCI_CUBE.strandLength - 1) / 2) * DEFAULT_FIBONACCI_CUBE.strandSpacing;
    // y=0 logical sits at -halfY (bottom).
    expect(coords.positions[1]).toBeCloseTo(-halfY, 6);
  });

  it('logical index walks each strand bottom → top (lattice convention)', () => {
    const cube = DEFAULT_FIBONACCI_CUBE;
    const coords = buildCoords(cube);
    const K = cube.strandLength;
    let prevY = -Infinity;
    for (let k = 0; k < K; k++) {
      const y = coords.positions[k * 3 + 1];
      expect(y).toBeGreaterThan(prevY);
      prevY = y;
    }
  });

  it('strand n>0 sits at radius c·√n from the center axis', () => {
    const cube = DEFAULT_FIBONACCI_CUBE;
    const { spiralCount: N, strandLength: K, minSpacing: c } = cube;
    const coords = buildCoords(cube);
    for (let n = 1; n < N; n++) {
      const i = n * K; // bottom of strand n
      const x = coords.positions[i * 3 + 0];
      const z = coords.positions[i * 3 + 2];
      const r = Math.sqrt(x * x + z * z);
      expect(r).toBeCloseTo(c * Math.sqrt(n), 5);
    }
  });

  it('all LEDs in a strand share the same (x, z) — strands are vertical', () => {
    const cube: FibonacciSpec = { ...DEFAULT_FIBONACCI_CUBE, spiralCount: 12, strandLength: 5 };
    const coords = buildCoords(cube);
    const { spiralCount: N, strandLength: K } = cube;
    for (let n = 0; n < N; n++) {
      const baseIdx = n * K;
      const x0 = coords.positions[baseIdx * 3 + 0];
      const z0 = coords.positions[baseIdx * 3 + 2];
      for (let k = 1; k < K; k++) {
        const i = baseIdx + k;
        expect(coords.positions[i * 3 + 0]).toBeCloseTo(x0, 9);
        expect(coords.positions[i * 3 + 2]).toBeCloseTo(z0, 9);
      }
    }
  });

  it('cy goes from -1 (bottom) to +1 (top) along a strand', () => {
    const cube = DEFAULT_FIBONACCI_CUBE;
    const coords = buildCoords(cube);
    const K = cube.strandLength;
    expect(coords.cys[0]).toBeCloseTo(-1, 6);     // bottom
    expect(coords.cys[K - 1]).toBeCloseTo(1, 6);  // top
  });

  it('ys uses lattice convention (bottom = 0, top = K-1)', () => {
    const cube = DEFAULT_FIBONACCI_CUBE;
    const coords = buildCoords(cube);
    const K = cube.strandLength;
    expect(coords.ys[0]).toBe(0);
    expect(coords.ys[K - 1]).toBe(K - 1);
  });

  it('edges bounding box is 2·discRadius wide and (K-1)·strandSpacing tall', () => {
    const cube = DEFAULT_FIBONACCI_CUBE;
    const e = edges(cube);
    const r = discRadius(cube);
    expect(e.x).toBeCloseTo(2 * r, 6);
    expect(e.z).toBeCloseTo(2 * r, 6);
    expect(e.y).toBeCloseTo((cube.strandLength - 1) * cube.strandSpacing, 6);
  });

  it('handles degenerate K=1 (disc only) without divide-by-zero', () => {
    const cube: FibonacciSpec = { ...DEFAULT_FIBONACCI_CUBE, strandLength: 1 };
    const coords = buildCoords(cube);
    expect(coords.count).toBe(cube.spiralCount);
    // Every LED should sit at y=0 (no vertical extent).
    for (let i = 0; i < coords.count; i++) {
      expect(coords.positions[i * 3 + 1]).toBeCloseTo(0, 9);
      expect(coords.cys[i]).toBe(0);
    }
  });

  it('Fibonacci address map flips Y per strand (top-down stream order)', async () => {
    const { buildAddressMapForCube } = await import('./wiring');
    const { defaultWiringConfig } = await import('./wiring');
    const cube = DEFAULT_FIBONACCI_CUBE;
    const map = buildAddressMapForCube(cube, defaultWiringConfig);
    const K = cube.strandLength;
    const N = cube.spiralCount;

    // Strand 0, logical y=0 (bottom) → stream K-1 (last in strand 0).
    expect(map[0]).toBe(K - 1);
    // Strand 0, logical y=K-1 (top, where strip enters) → stream 0.
    expect(map[K - 1]).toBe(0);
    // Strand 1, logical y=0 → stream 2K-1; y=K-1 → stream K (top of strand 1).
    expect(map[K]).toBe(2 * K - 1);
    expect(map[K + (K - 1)]).toBe(K);

    // Bijection check.
    const seen = new Uint8Array(N * K);
    for (let i = 0; i < map.length; i++) {
      expect(seen[map[i]]).toBe(0);
      seen[map[i]] = 1;
    }
  });

  it('handles degenerate N=1 (single strand) without NaN', () => {
    const cube: FibonacciSpec = { ...DEFAULT_FIBONACCI_CUBE, spiralCount: 1 };
    const coords = buildCoords(cube);
    expect(coords.count).toBe(cube.strandLength);
    // The only strand is the center strand → every LED at x=z=0.
    for (let i = 0; i < coords.count; i++) {
      expect(coords.positions[i * 3 + 0]).toBeCloseTo(0, 9);
      expect(coords.positions[i * 3 + 2]).toBeCloseTo(0, 9);
      expect(Number.isFinite(coords.positions[i * 3 + 1])).toBe(true);
    }
  });
});
