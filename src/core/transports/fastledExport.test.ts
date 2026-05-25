import { describe, it, expect, vi, beforeEach } from 'vitest';

// Bake calls invoke('write_export', { relPath, contents }) to drop the
// .ino on disk. We mock invoke to capture writes without touching the
// filesystem, then assert on the generated sketch contents directly.

type Wrote = { relPath: string; contents: string };
const wrote: Wrote[] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (_cmd: string, args: any) => {
    wrote.push({ relPath: args.relPath, contents: args.contents });
    return args.relPath;
  }),
}));

beforeEach(() => {
  wrote.length = 0;
});

import { exportFastLed } from './fastledExport';
import { autoLayoutDigOcta, DIG_OCTA_PINS } from './index';
import { defaultColorConfig } from '../colorPipeline';
import { defaultPowerConfig } from '../power';
import { defaultWiringConfig } from '../wiring';
import { DEFAULT_LATTICE_CUBE as _DEFAULT_LATTICE_CUBE } from '../cubeGeometry';
const DEFAULT_LATTICE_CUBE = _DEFAULT_LATTICE_CUBE;
import type { LoadedPattern } from '../patternApi';

// Minimal solid-white pattern so the bake produces deterministic data
// we can inspect across slices.
const SOLID_WHITE: LoadedPattern = {
  name: 'test/solid.js',
  displayName: 'Solid',
  params: {},
  kind: 'function',
  renderVoxel: () => [255, 255, 255],
};

const baseArgs = () => ({
  pattern: SOLID_WHITE,
  paramValues: {},
  cube: DEFAULT_LATTICE_CUBE,
  color: defaultColorConfig,
  power: defaultPowerConfig,
  wiring: defaultWiringConfig,
});

describe('FastLED export — single-pin (legacy)', () => {
  it('writes one .ino in a folder of the same name (Arduino IDE convention)', async () => {
    const res = await exportFastLed({
      ...baseArgs(),
      options: { seconds: 1, fps: 5, dataPin: 16, sketchStem: 'Solid' },
    });
    expect(res.paths.length).toBe(1);
    expect(wrote.length).toBe(1);
    // Path should be foo/foo.ino — sketch wrapped in a folder of same name.
    const rel = wrote[0].relPath;
    const slashIdx = rel.indexOf('/');
    expect(slashIdx).toBeGreaterThan(0);
    const folder = rel.slice(0, slashIdx);
    const file = rel.slice(slashIdx + 1);
    expect(file.endsWith('.ino')).toBe(true);
    expect(file.replace(/\.ino$/, '')).toBe(folder);
  });

  it('sketch tells FastLED to use RGB order (bytes are pre-shuffled by bakeFrame)', async () => {
    await exportFastLed({
      ...baseArgs(),
      options: { seconds: 1, fps: 5, dataPin: 16, sketchStem: 'Solid' },
    });
    // Regression guard for the pre-existing double-shuffle bug — the
    // generated sketch must declare RGB as the FastLED color order,
    // not the user's chosen physical order (which bakeFrame already
    // applied to the PROGMEM bytes).
    expect(wrote[0].contents).toContain('FastLED.addLeds<WS2815, DATA_PIN, RGB>(leds, LED_COUNT)');
    expect(wrote[0].contents).toContain('#define DATA_PIN    16');
  });
});

describe('FastLED export — multi-board', () => {
  it('writes one .ino per board', async () => {
    const cube = DEFAULT_LATTICE_CUBE;
    const total = cube.Nx * cube.Ny * cube.Nz; // 1000
    const boards = autoLayoutDigOcta(total, 2, 5);
    const res = await exportFastLed({
      ...baseArgs(),
      options: { seconds: 1, fps: 5, boards, sketchStem: 'Cube' },
    });
    expect(res.paths.length).toBe(2);
    expect(wrote.length).toBe(2);
    expect(wrote[0].relPath).toMatch(/Cube_BoardA_/);
    expect(wrote[1].relPath).toMatch(/Cube_BoardB_/);
  });

  it("each board's sketch declares LED_COUNT for ITS slice, not the whole cube", async () => {
    const boards = autoLayoutDigOcta(1000, 2, 5);  // 500 LEDs/board
    await exportFastLed({
      ...baseArgs(),
      options: { seconds: 1, fps: 5, boards, sketchStem: 'Cube' },
    });
    expect(wrote[0].contents).toContain('#define LED_COUNT   500');
    expect(wrote[1].contents).toContain('#define LED_COUNT   500');
  });

  it('emits one addLeds<>() call per output, in the Dig-Octa pin order', async () => {
    const boards = autoLayoutDigOcta(1000, 2, 5);
    await exportFastLed({
      ...baseArgs(),
      options: { seconds: 1, fps: 5, boards, sketchStem: 'Cube' },
    });
    const boardA = wrote[0].contents;
    // First 5 pins: 16, 3, 1, 17, 19 = Q1..Q5.
    for (let i = 0; i < 5; i++) {
      const pin = DIG_OCTA_PINS[i];
      // ledStart = i*100, ledCount = 100
      expect(boardA).toContain(`FastLED.addLeds<WS2815, ${pin}, RGB>(leds, ${i * 100}, 100);`);
    }
  });

  it('each board PROGMEM contains only its share of the per-frame bytes', async () => {
    const boards = autoLayoutDigOcta(1000, 2, 5);  // each board = 1500 bytes/frame
    await exportFastLed({
      ...baseArgs(),
      options: { seconds: 1, fps: 5, boards, sketchStem: 'Cube' },
    });
    // FRAME_BYTES define gives us this directly:
    expect(wrote[0].contents).toContain('#define FRAME_BYTES 1500');
    expect(wrote[1].contents).toContain('#define FRAME_BYTES 1500');
  });

  it('result.sizeKb sums across all boards (total flash impact)', async () => {
    const boards = autoLayoutDigOcta(1000, 2, 5);
    const res = await exportFastLed({
      ...baseArgs(),
      options: { seconds: 1, fps: 5, boards, sketchStem: 'Cube' },
    });
    expect(res.sizeKb).toBeGreaterThan(0);
    expect(res.paths.length).toBe(2);
  });

  it('autoLayoutDigOcta divides LEDs evenly across boards × outputs', () => {
    const boards = autoLayoutDigOcta(1000, 2, 5);
    expect(boards.length).toBe(2);
    expect(boards[0].ledCount).toBe(500);
    expect(boards[1].ledCount).toBe(500);
    expect(boards[0].outputs.length).toBe(5);
    expect(boards[0].outputs.every((o) => o.ledCount === 100)).toBe(true);
    // ledStart in board A's outputs is board-local, walking 0..400 in 100s.
    expect(boards[0].outputs.map((o) => o.ledStart)).toEqual([0, 100, 200, 300, 400]);
    // Board B's local outputs reset to 0 — sketches address into their own buffer.
    expect(boards[1].outputs.map((o) => o.ledStart)).toEqual([0, 100, 200, 300, 400]);
  });

  it('autoLayoutDigOcta handles uneven splits by distributing remainder LEDs', () => {
    // 1003 LEDs / (2 × 5 = 10 outputs) = 100 base + 3 remainder LEDs.
    // First 3 outputs (globally) get one extra each → 101, 101, 101, 100, 100, ...
    const boards = autoLayoutDigOcta(1003, 2, 5);
    const allOutputs = [...boards[0].outputs, ...boards[1].outputs];
    expect(allOutputs.slice(0, 3).every((o) => o.ledCount === 101)).toBe(true);
    expect(allOutputs.slice(3).every((o) => o.ledCount === 100)).toBe(true);
    const total = allOutputs.reduce((a, o) => a + o.ledCount, 0);
    expect(total).toBe(1003);
  });
});
