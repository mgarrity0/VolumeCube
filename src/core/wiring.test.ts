import { describe, it, expect } from 'vitest';
import { buildAddressMap, defaultWiringConfig, type WiringConfig } from './wiring';

// The address map is the heart of the wiring config — it has to be a
// bijection over [0, N³) for every valid config. A duplicate stream index
// would mean two LEDs get the same byte; a gap would mean bytes fall off
// the end. Both are silent-death bugs in the field, so this test iterates
// a grid of configs rather than just the default.

function assertBijection(map: Uint32Array, N: number) {
  expect(map.length).toBe(N * N * N);
  const seen = new Uint8Array(N * N * N);
  for (let i = 0; i < map.length; i++) {
    const v = map[i];
    expect(v, `stream index at logical ${i} out of range`).toBeGreaterThanOrEqual(0);
    expect(v, `stream index at logical ${i} out of range`).toBeLessThan(N * N * N);
    expect(seen[v], `duplicate stream index ${v}`).toBe(0);
    seen[v] = 1;
  }
}

describe('buildAddressMap', () => {
  it('default config is a bijection for N=10', () => {
    const map = buildAddressMap(defaultWiringConfig, 10);
    assertBijection(map, 10);
  });

  it('is a bijection for every permutation of layer/row/start toggles (N=4)', () => {
    const N = 4;
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
                layerOrder,
                layerStart,
                rowDirection,
                serpentine,
                layerSerpentine,
              };
              const map = buildAddressMap(cfg, N);
              assertBijection(map, N);
            }
          }
        }
      }
    }
  });

  it('handles N=1 trivially (one LED at stream 0)', () => {
    const map = buildAddressMap(defaultWiringConfig, 1);
    expect(map.length).toBe(1);
    expect(map[0]).toBe(0);
  });
});
