// Geometry for the Nx × Ny × Nz voxel grid.
//
// Y is up. The physical build stacks 2D panels along Z, so adding more
// panels grows Nz. Nx/Ny are the per-panel grid. All three axes may
// differ — a single rig might be 10×10×3 while another is 8×16×8.
//
// Logical voxel index = x*Ny*Nz + y*Nz + z (x-major, then y, then z).
// The address map in wiring.ts maps logical→stream for the wire; this
// file only deals with visual positions, so the ordering we pick here
// is whatever is convenient for patterns + the R3F primitive.
//
// Pattern code sees xyz = {x, y, z, u, v, w, cx, cy, cz, i} for each LED.
// Position in meters, using a single pitch (physical LED-to-LED spacing):
//   pos.x = (x - (Nx-1)/2) * pitch
//   pos.y = (y - (Ny-1)/2) * pitch
//   pos.z = (z - (Nz-1)/2) * pitch

export type CubeSpec = {
  Nx: number;
  Ny: number;
  Nz: number;
  pitchMeters: number;
};

export const DEFAULT_CUBE: CubeSpec = {
  Nx: 10,
  Ny: 10,
  Nz: 10,
  pitchMeters: 0.1016, // 4 inches — matches the old 0.9144 m / 9 spacing
};

export function ledCount(spec: CubeSpec): number {
  return spec.Nx * spec.Ny * spec.Nz;
}

/** Physical LED-to-LED spacing in meters (uniform across axes). */
export function spacing(spec: CubeSpec): number {
  return spec.pitchMeters;
}

/** Per-axis edge lengths in meters, for the structure overlay box. */
export function edges(spec: CubeSpec): { x: number; y: number; z: number } {
  return {
    x: Math.max(0, spec.Nx - 1) * spec.pitchMeters,
    y: Math.max(0, spec.Ny - 1) * spec.pitchMeters,
    z: Math.max(0, spec.Nz - 1) * spec.pitchMeters,
  };
}

/**
 * Canonical logical index for voxel (x, y, z).
 * Must match the order patterns iterate in and the buffer indexing used
 * by colorPipeline + transports.
 */
export function voxelIndex(x: number, y: number, z: number, Ny: number, Nz: number): number {
  return x * Ny * Nz + y * Nz + z;
}

/**
 * Per-voxel normalized + centered coords, plus world-space positions.
 * Parallel Float32Arrays stay allocation-free in the per-frame hot path.
 */
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
  cxs: Float32Array;        // centered [-1,1] per axis
  cys: Float32Array;
  czs: Float32Array;
};

/**
 * Build all per-voxel buffers in logical-index order in one pass.
 */
export function buildCoords(spec: CubeSpec): VoxelCoords {
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
        positions[i * 3 + 2] = z * p - halfZ;
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
