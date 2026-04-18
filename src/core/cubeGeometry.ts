// Geometry for the N × N × N voxel grid.
//
// Y is up; each 10×10 mesh layer is an XZ plane stacked along Y.
// Logical voxel index = z + y*N + x*N² (x-major layer, X outer). The address
// map in wiring.ts maps logical→stream for the wire; this file only deals
// with the *visual* positions, so the ordering we pick here is whatever is
// convenient for patterns + the R3F InstancedMesh.
//
// Pattern code sees xyz = {x, y, z, u, v, w, cx, cy, cz, i} for each LED.
// Position in meters:
//   spacing = edgeMeters / (N - 1)
//   pos = ((x - (N-1)/2) * spacing, (y - (N-1)/2) * spacing, (z - (N-1)/2) * spacing)

export type CubeSpec = {
  N: number;
  edgeMeters: number;
};

export const DEFAULT_CUBE: CubeSpec = {
  N: 10,
  edgeMeters: 0.9144, // 3 ft
};

export function ledCount(spec: CubeSpec): number {
  return spec.N * spec.N * spec.N;
}

export function spacing(spec: CubeSpec): number {
  return spec.N <= 1 ? 0 : spec.edgeMeters / (spec.N - 1);
}

/**
 * Canonical logical index for voxel (x, y, z).
 * Must match the order patterns iterate in and the buffer indexing used by
 * colorPipeline + transports.
 */
export function voxelIndex(x: number, y: number, z: number, N: number): number {
  return x * N * N + y * N + z;
}

/**
 * Compact centered Float32Array of length ledCount*3 — world-space positions
 * for each voxel in logical-index order. Used to seed InstancedMesh.
 */
export function buildPositions(spec: CubeSpec): Float32Array {
  const { N } = spec;
  const s = spacing(spec);
  const half = ((N - 1) / 2) * s;
  const out = new Float32Array(N * N * N * 3);
  let i = 0;
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) {
      for (let z = 0; z < N; z++) {
        out[i * 3 + 0] = x * s - half;
        out[i * 3 + 1] = y * s - half;
        out[i * 3 + 2] = z * s - half;
        i++;
      }
    }
  }
  return out;
}

/**
 * Per-voxel normalized + centered coords, handy for pattern authors.
 * Returned as parallel Float32Arrays to stay allocation-free per frame.
 */
export type VoxelCoords = {
  N: number;
  count: number;
  // integer lattice coords [0, N-1]
  xs: Int16Array;
  ys: Int16Array;
  zs: Int16Array;
  // normalized [0,1]
  us: Float32Array;
  vs: Float32Array;
  ws: Float32Array;
  // centered [-1,1]
  cxs: Float32Array;
  cys: Float32Array;
  czs: Float32Array;
};

export function buildCoords(spec: CubeSpec): VoxelCoords {
  const { N } = spec;
  const count = N * N * N;
  const xs = new Int16Array(count);
  const ys = new Int16Array(count);
  const zs = new Int16Array(count);
  const us = new Float32Array(count);
  const vs = new Float32Array(count);
  const ws = new Float32Array(count);
  const cxs = new Float32Array(count);
  const cys = new Float32Array(count);
  const czs = new Float32Array(count);
  const inv = N > 1 ? 1 / (N - 1) : 0;
  let i = 0;
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) {
      for (let z = 0; z < N; z++) {
        xs[i] = x;
        ys[i] = y;
        zs[i] = z;
        const u = x * inv;
        const v = y * inv;
        const w = z * inv;
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
  return { N, count, xs, ys, zs, us, vs, ws, cxs, cys, czs };
}
