// Wiring and address map.
//
// The LED data stream hits the physical strip in whatever order the
// user wired their Ny stacked panels (each panel is an Nx × Nz grid).
// Logical index (x*Ny*Nz + y*Nz + z) is the coordinate system patterns
// use; stream index is "the nth RGB triple in the UART/UDP payload".
// This file builds a lookup table between the two so the transport
// layer can re-order frames.
//
// Config covers all the common mesh-wiring permutations:
//   layerOrder      — bottom-up vs top-down (which Y comes first)
//   layerStart      — which (x,z) corner the data enters each layer
//   rowDirection    — does each row of a layer run along X or Z
//   serpentine      — flip row direction every other row within a layer
//   layerSerpentine — flip the entry corner every other layer
//
// Phase 5 renders a thin polyline through the LEDs in stream order so
// the user can eyeball whether the config matches their real cube.

export type LayerOrder = 'bottom-up' | 'top-down';
export type LayerStart = 'corner-00' | 'corner-N0' | 'corner-0N' | 'corner-NN';
export type RowDirection = 'x-major' | 'z-major';

export type WiringConfig = {
  layerOrder: LayerOrder;
  layerStart: LayerStart;
  rowDirection: RowDirection;
  serpentine: boolean;
  layerSerpentine: boolean;
};

export const defaultWiringConfig: WiringConfig = {
  layerOrder: 'bottom-up',
  layerStart: 'corner-00',
  rowDirection: 'x-major',
  serpentine: true,
  layerSerpentine: false,
};

type CornerStart = { startX: number; startZ: number; stepX: 1 | -1; stepZ: 1 | -1 };

function cornerToStart(corner: LayerStart, Nx: number, Nz: number): CornerStart {
  switch (corner) {
    case 'corner-00': return { startX: 0,      startZ: 0,      stepX: 1,  stepZ: 1  };
    case 'corner-N0': return { startX: Nx - 1, startZ: 0,      stepX: -1, stepZ: 1  };
    case 'corner-0N': return { startX: 0,      startZ: Nz - 1, stepX: 1,  stepZ: -1 };
    case 'corner-NN': return { startX: Nx - 1, startZ: Nz - 1, stepX: -1, stepZ: -1 };
  }
}

function flipLayerStart(c: LayerStart): LayerStart {
  switch (c) {
    case 'corner-00': return 'corner-NN';
    case 'corner-NN': return 'corner-00';
    case 'corner-N0': return 'corner-0N';
    case 'corner-0N': return 'corner-N0';
  }
}

/**
 * Map logical voxel index → stream index.
 * Guaranteed to be a bijection over [0, Nx*Ny*Nz) when the config is valid.
 */
export function buildAddressMap(cfg: WiringConfig, Nx: number, Ny: number, Nz: number): Uint32Array {
  const total = Nx * Ny * Nz;
  const map = new Uint32Array(total);
  let streamIdx = 0;

  // rowDirection picks which axis is the inner (row-traversal) counter:
  //   x-major  → inner = X (length Nx), outer = Z (length Nz)
  //   z-major  → inner = Z (length Nz), outer = X (length Nx)
  const innerLen = cfg.rowDirection === 'x-major' ? Nx : Nz;
  const outerLen = cfg.rowDirection === 'x-major' ? Nz : Nx;

  for (let ly = 0; ly < Ny; ly++) {
    const y = cfg.layerOrder === 'bottom-up' ? ly : Ny - 1 - ly;

    let layerStart = cfg.layerStart;
    if (cfg.layerSerpentine && (ly & 1)) layerStart = flipLayerStart(layerStart);

    const { startX, startZ, stepX, stepZ } = cornerToStart(layerStart, Nx, Nz);

    for (let r = 0; r < outerLen; r++) {
      for (let c = 0; c < innerLen; c++) {
        // Serpentine reverses the inner counter on odd rows.
        const inner = (cfg.serpentine && (r & 1)) ? (innerLen - 1 - c) : c;

        let x: number, z: number;
        if (cfg.rowDirection === 'x-major') {
          x = startX + stepX * inner;
          z = startZ + stepZ * r;
        } else {
          x = startX + stepX * r;
          z = startZ + stepZ * inner;
        }

        const logical = x * Ny * Nz + y * Nz + z;
        map[logical] = streamIdx;
        streamIdx++;
      }
    }
  }
  return map;
}

/**
 * Build positions in stream order — used by the wiring-path overlay to
 * draw a continuous polyline through the LEDs in the order they're wired.
 * The `positions` argument is the logical-order position buffer produced
 * by cubeGeometry.buildCoords().
 */
export function buildStreamPath(
  addressMap: Uint32Array,
  logicalPositions: Float32Array,
): Float32Array {
  const count = addressMap.length;
  const out = new Float32Array(count * 3);
  for (let logical = 0; logical < count; logical++) {
    const stream = addressMap[logical];
    out[stream * 3 + 0] = logicalPositions[logical * 3 + 0];
    out[stream * 3 + 1] = logicalPositions[logical * 3 + 1];
    out[stream * 3 + 2] = logicalPositions[logical * 3 + 2];
  }
  return out;
}
