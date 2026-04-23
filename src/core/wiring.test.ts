import { describe, it, expect } from 'vitest';
import { buildAddressMap, defaultWiringConfig, type WiringConfig } from './wiring';

// The address map is the heart of the wiring config — it has to be a
// bijection over [0, Nx*Ny*Nz) for every valid config. A duplicate stream
// index would mean two LEDs get the same byte; a gap would mean bytes fall
// off the end. Both are silent-death bugs in the field, so this test
// iterates a grid of configs and shapes rather than just the default.

function assertBijection(map: Uint32Array, Nx: number, Ny: number, Nz: number) {
  const total = Nx * Ny * Nz;
  expect(map.length).toBe(total);
  const seen = new Uint8Array(total);
  for (let i = 0; i < map.length; i++) {
    const v = map[i];
    expect(v, `stream index at logical ${i} out of range`).toBeGreaterThanOrEqual(0);
    expect(v, `stream index at logical ${i} out of range`).toBeLessThan(total);
    expect(seen[v], `duplicate stream index ${v}`).toBe(0);
    seen[v] = 1;
  }
}

describe('buildAddressMap', () => {
  it('default config is a bijection for 10×10×10', () => {
    const map = buildAddressMap(defaultWiringConfig, 10, 10, 10);
    assertBijection(map, 10, 10, 10);
  });

  it('default config is a bijection for 10×10×3 (user hardware)', () => {
    const map = buildAddressMap(defaultWiringConfig, 10, 10, 3);
    assertBijection(map, 10, 10, 3);
  });

  it('is a bijection for every permutation of toggles (cubic 4×4×4)', () => {
    const layerOrders: WiringConfig['layerOrder'][] = ['bottom-up', 'top-down'];
    const starts: WiringConfig['layerStart'][] = [
      'corner-00', 'corner-N0', 'corner-0N', 'corner-NN',
    ];
    const rowDirs: WiringConfig['rowDirection'][] = ['x-major', 'z-major'];
    for (const layerOrder of layerOrders) {
      for (const layerStart of starts) {
        for (const rowDirection of rowDirs) {
          for (const serpentine of [false, true]) {
            for (const layerSerpentine of [false, true]) {
              const cfg: WiringConfig = {
                layerOrder, layerStart, rowDirection, serpentine, layerSerpentine,
              };
              const map = buildAddressMap(cfg, 4, 4, 4);
              assertBijection(map, 4, 4, 4);
            }
          }
        }
      }
    }
  });

  it('is a bijection for non-cubic shapes under every toggle permutation', () => {
    const shapes: Array<[number, number, number]> = [
      [10, 10, 3],  // user's current hardware
      [10, 10, 5],
      [8, 4, 6],
      [3, 5, 7],    // all-distinct, all-prime
      [2, 2, 8],
    ];
    const layerOrders: WiringConfig['layerOrder'][] = ['bottom-up', 'top-down'];
    const starts: WiringConfig['layerStart'][] = [
      'corner-00', 'corner-N0', 'corner-0N', 'corner-NN',
    ];
    const rowDirs: WiringConfig['rowDirection'][] = ['x-major', 'z-major'];
    for (const [Nx, Ny, Nz] of shapes) {
      for (const layerOrder of layerOrders) {
        for (const layerStart of starts) {
          for (const rowDirection of rowDirs) {
            for (const serpentine of [false, true]) {
              for (const layerSerpentine of [false, true]) {
                const cfg: WiringConfig = {
                  layerOrder, layerStart, rowDirection, serpentine, layerSerpentine,
                };
                const map = buildAddressMap(cfg, Nx, Ny, Nz);
                assertBijection(map, Nx, Ny, Nz);
              }
            }
          }
        }
      }
    }
  });

  it('handles 1×1×1 trivially (one LED at stream 0)', () => {
    const map = buildAddressMap(defaultWiringConfig, 1, 1, 1);
    expect(map.length).toBe(1);
    expect(map[0]).toBe(0);
  });

  it('handles a single-layer shape (Ny=1)', () => {
    const map = buildAddressMap(defaultWiringConfig, 10, 1, 10);
    assertBijection(map, 10, 1, 10);
  });
});
