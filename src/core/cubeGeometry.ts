// Geometry for the LED layout. Two top-level shapes covered by a tagged
// union so the rest of the engine can stay agnostic:
//
//   - 'lattice'   : the original Nx × Ny × Nz integer voxel grid.
//   - 'fibonacci' : a Vogel-spiral disc (no central hot spot) with K LEDs
//                   hanging straight down from each disc node. Logical
//                   index = n*K + k, stream order = same. Wiring is
//                   "down each strand, jump to the top of the next" —
//                   identical topology to the lattice column-mode, just
//                   reordered by spiral index instead of grid (X,Z).
//
// Pattern code sees xyz = {x, y, z, u, v, w, cx, cy, cz, i} for each LED
// regardless of layout. cx/cy/cz are world-position-derived in [-1, 1]
// per axis, so spatial patterns (metaballs, expanding-spheres, harmonic-
// blob, …) work on either shape.
//
// In Fibonacci mode we expose synthetic grid dims so RenderContext stays
// shaped {Nx, Ny, Nz}: Nx = N (spiral nodes), Ny = K (strand length),
// Nz = 1. Patterns that rely on integer x/y/z lattice semantics (Life3D,
// Tetris3D, Pong3D, Hilbert) are tagged lattice-only and disabled in
// Fibonacci mode rather than silently looking wrong.

export type LatticeSpec = {
  kind: 'lattice';
  Nx: number;
  Ny: number;
  Nz: number;
  pitchMeters: number;
};

export type FibonacciSpec = {
  kind: 'fibonacci';
  /** Number of nodes in the disc (Vogel spiral, n=0 at center). */
  spiralCount: number;
  /** LEDs per hanging strand (= effective Y dim). */
  strandLength: number;
  /** Vogel `c` constant in meters: r = c·√n. Sets the radial pitch. */
  minSpacing: number;
  /** Vertical pitch within a strand (meters). */
  strandSpacing: number;
};

export type CubeSpec = LatticeSpec | FibonacciSpec;

export const DEFAULT_LATTICE_CUBE: LatticeSpec = {
  kind: 'lattice',
  Nx: 10,
  Ny: 10,
  Nz: 10,
  pitchMeters: 0.1016, // 4 inches — matches the old 0.9144 m / 9 spacing
};

export const DEFAULT_FIBONACCI_CUBE: FibonacciSpec = {
  kind: 'fibonacci',
  spiralCount: 60,        // ~ a single dense disc, like the user's reference photo
  strandLength: 20,       // hanging strand of 20 LEDs per node
  minSpacing: 0.04,       // 4 cm Vogel constant — disc radius ≈ 0.04·√59 ≈ 0.31 m
  strandSpacing: 0.05,    // 5 cm vertical pitch within a strand
};

export const DEFAULT_CUBE: CubeSpec = DEFAULT_LATTICE_CUBE;

/**
 * Synthetic grid dims exposed to patterns and the engine regardless of
 * which shape is active. Lattice → (Nx, Ny, Nz). Fibonacci → (N, K, 1).
 */
export function gridDims(spec: CubeSpec): { Nx: number; Ny: number; Nz: number } {
  if (spec.kind === 'fibonacci') {
    return { Nx: spec.spiralCount, Ny: spec.strandLength, Nz: 1 };
  }
  return { Nx: spec.Nx, Ny: spec.Ny, Nz: spec.Nz };
}

export function ledCount(spec: CubeSpec): number {
  const { Nx, Ny, Nz } = gridDims(spec);
  return Nx * Ny * Nz;
}

/**
 * Representative LED-to-LED spacing. Drives billboard size and overlay
 * geometry. Lattice = uniform pitch; Fibonacci = the smaller of the disc
 * Vogel constant and the strand pitch (so billboards never overlap).
 */
export function spacing(spec: CubeSpec): number {
  if (spec.kind === 'fibonacci') {
    return Math.min(spec.minSpacing, spec.strandSpacing);
  }
  return spec.pitchMeters;
}

/** Outer disc radius for Fibonacci mode in meters. */
export function discRadius(spec: FibonacciSpec): number {
  return spec.spiralCount > 1 ? spec.minSpacing * Math.sqrt(spec.spiralCount - 1) : 0;
}

/** Per-axis edge lengths in meters, for the structure overlay box. */
export function edges(spec: CubeSpec): { x: number; y: number; z: number } {
  if (spec.kind === 'fibonacci') {
    const r = discRadius(spec);
    const h = Math.max(0, spec.strandLength - 1) * spec.strandSpacing;
    return { x: 2 * r, y: h, z: 2 * r };
  }
  return {
    x: Math.max(0, spec.Nx - 1) * spec.pitchMeters,
    y: Math.max(0, spec.Ny - 1) * spec.pitchMeters,
    z: Math.max(0, spec.Nz - 1) * spec.pitchMeters,
  };
}

/**
 * Canonical logical index for voxel (x, y, z). In Fibonacci mode this
 * means (spiral_n, strand_y, 0) → n*K + (K-1-k_top), preserving stream
 * order via the existing column-major linearisation.
 */
export function voxelIndex(x: number, y: number, z: number, Ny: number, Nz: number): number {
  return x * Ny * Nz + y * Nz + z;
}

export type VoxelCoords = {
  Nx: number;
  Ny: number;
  Nz: number;
  count: number;
  positions: Float32Array;  // world-space (x,y,z) * count
  xs: Int16Array;           // integer lattice [0, Nx-1] etc.
  ys: Int16Array;
  zs: Int16Array;
  us: Float32Array;         // normalized [0,1] per axis
  vs: Float32Array;
  ws: Float32Array;
  cxs: Float32Array;        // centered [-1,1] per axis (world-derived)
  cys: Float32Array;
  czs: Float32Array;
};

export function buildCoords(spec: CubeSpec): VoxelCoords {
  if (spec.kind === 'fibonacci') return buildCoordsFibonacci(spec);
  return buildCoordsLattice(spec);
}

function buildCoordsLattice(spec: LatticeSpec): VoxelCoords {
  const { Nx, Ny, Nz, pitchMeters: p } = spec;
  const count = Nx * Ny * Nz;
  const halfX = ((Nx - 1) / 2) * p;
  const halfY = ((Ny - 1) / 2) * p;
  const halfZ = ((Nz - 1) / 2) * p;
  const positions = new Float32Array(count * 3);
  const xs = new Int16Array(count);
  const ys = new Int16Array(count);
  const zs = new Int16Array(count);
  const us = new Float32Array(count);
  const vs = new Float32Array(count);
  const ws = new Float32Array(count);
  const cxs = new Float32Array(count);
  const cys = new Float32Array(count);
  const czs = new Float32Array(count);
  const invX = Nx > 1 ? 1 / (Nx - 1) : 0;
  const invY = Ny > 1 ? 1 / (Ny - 1) : 0;
  const invZ = Nz > 1 ? 1 / (Nz - 1) : 0;
  let i = 0;
  for (let x = 0; x < Nx; x++) {
    for (let y = 0; y < Ny; y++) {
      for (let z = 0; z < Nz; z++) {
        positions[i * 3 + 0] = x * p - halfX;
        positions[i * 3 + 1] = y * p - halfY;
        positions[i * 3 + 2] = halfZ - z * p;  // z=0 lands on the front face (+Z)
        xs[i] = x;
        ys[i] = y;
        zs[i] = z;
        const u = x * invX;
        const v = y * invY;
        const w = z * invZ;
        us[i] = u;
        vs[i] = v;
        ws[i] = w;
        cxs[i] = u * 2 - 1;
        cys[i] = v * 2 - 1;
        czs[i] = w * 2 - 1;
        i++;
      }
    }
  }
  return { Nx, Ny, Nz, count, positions, xs, ys, zs, us, vs, ws, cxs, cys, czs };
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 137.508°

/**
 * Vogel spiral × hanging strand. The LOGICAL layout matches lattice
 * convention exactly so class-API patterns (which iterate the buffer
 * via x/y/z loops with y=0 at the bottom) render correctly without
 * special-casing:
 *
 *   logical i = n * K + y    (n = spiral index 0..N-1, center→edge)
 *                            (y = 0 at strand bottom, K-1 at strand top)
 *
 * The strip's physical traversal is top-to-bottom per strand (entering
 * at the disc), then jumps to the top of the next spiral node. That
 * top-down stream order is encoded in the ADDRESS MAP, not in the
 * logical layout — see buildAddressMapForCube in wiring.ts. This is the
 * same separation the lattice already uses (logical = x-major, stream =
 * whatever the wiring config dictates).
 */
function buildCoordsFibonacci(spec: FibonacciSpec): VoxelCoords {
  const { spiralCount: N, strandLength: K, minSpacing: c, strandSpacing: ps } = spec;
  const count = N * K;

  // Disc node 2D positions in the X-Z plane.
  const discX = new Float32Array(N);
  const discZ = new Float32Array(N);
  let maxR = 0;
  for (let n = 0; n < N; n++) {
    const r = c * Math.sqrt(n);
    const theta = n * GOLDEN_ANGLE;
    discX[n] = r * Math.cos(theta);
    discZ[n] = r * Math.sin(theta);
    if (r > maxR) maxR = r;
  }
  const halfY = ((K - 1) / 2) * ps;
  const halfXZ = Math.max(maxR, 1e-6);

  const positions = new Float32Array(count * 3);
  const xs = new Int16Array(count);
  const ys = new Int16Array(count);
  const zs = new Int16Array(count);
  const us = new Float32Array(count);
  const vs = new Float32Array(count);
  const ws = new Float32Array(count);
  const cxs = new Float32Array(count);
  const cys = new Float32Array(count);
  const czs = new Float32Array(count);

  const invN = N > 1 ? 1 / (N - 1) : 0;
  const invK = K > 1 ? 1 / (K - 1) : 0;

  for (let n = 0; n < N; n++) {
    const wx = discX[n];
    const wz = discZ[n];
    for (let y = 0; y < K; y++) {
      const i = n * K + y;            // logical index (lattice-convention y)
      const wy = -halfY + y * ps;     // y=0 at strand bottom, y=K-1 at top (disc)

      positions[i * 3 + 0] = wx;
      positions[i * 3 + 1] = wy;
      positions[i * 3 + 2] = wz;

      xs[i] = n;
      ys[i] = y;
      zs[i] = 0;

      us[i] = n * invN;
      vs[i] = y * invK;
      ws[i] = 0;

      cxs[i] = wx / halfXZ;
      cys[i] = K > 1 ? wy / halfY : 0;
      czs[i] = wz / halfXZ;
    }
  }

  return { Nx: N, Ny: K, Nz: 1, count, positions, xs, ys, zs, us, vs, ws, cxs, cys, czs };
}
