import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture both write_export (text) and write_export_bytes (binary) so
// we can verify the SD-card folder layout AND the per-pattern .bin
// frame data without touching disk.

type Wrote = { relPath: string; contents?: string; bytes?: Uint8Array };
const wrote: Wrote[] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    if (cmd === 'write_export') {
      wrote.push({ relPath: args.relPath, contents: args.contents });
      return args.relPath;
    }
    if (cmd === 'write_export_bytes') {
      wrote.push({ relPath: args.relPath, bytes: new Uint8Array(args.bytes) });
      return args.relPath;
    }
    // patternRuntime.loadPattern hits read_pattern + URL.createObjectURL;
    // we'll mock loadPattern itself below so the patternRuntime
    // commands never get called.
    throw new Error(`unexpected invoke command in test: ${cmd}`);
  }),
}));

// Mock the pattern loader so the SD bake gets a known pure-RGB pattern
// without needing the Blob URL machinery / patterns dir.
vi.mock('../patternRuntime', () => ({
  loadPattern: vi.fn(async (name: string) => ({
    ok: true,
    pattern: {
      name,
      displayName: name.split('/').pop()!.replace(/\.js$/, ''),
      params: {},
      kind: 'function' as const,
      renderVoxel: () => [10, 20, 30] as [number, number, number], // distinguishable RGB
    },
    source: '',
  })),
}));

beforeEach(() => {
  wrote.length = 0;
});

import { bakeForSdCard, BIN_MAGIC, BIN_VERSION, BIN_HEADER_LEN } from './sdCardExport';
import { autoLayoutDigOcta } from './index';
import { defaultColorConfig } from '../colorPipeline';
import { defaultPowerConfig } from '../power';
import { defaultWiringConfig } from '../wiring';
import { DEFAULT_LATTICE_CUBE } from '../cubeGeometry';

const baseArgs = () => ({
  cube: DEFAULT_LATTICE_CUBE,
  wiring: defaultWiringConfig,
  color: defaultColorConfig,
  power: defaultPowerConfig,
  boards: autoLayoutDigOcta(1000, 2, 5),
  paramValues: {},
  seconds: 1,
  fps: 5,
});

describe('SD-card bake — file structure', () => {
  it('writes a config.json per board and a .bin per pattern × board', async () => {
    const res = await bakeForSdCard({
      ...baseArgs(),
      patternNames: ['classics/foo.js', 'classics/bar.js'],
    });
    expect(res.errors).toEqual([]);
    expect(res.patternsBaked).toBe(2);
    // 2 boards × (1 config + 2 patterns) = 6 files written.
    expect(wrote.length).toBe(6);
    const paths = wrote.map((w) => w.relPath);
    expect(paths.some((p) => /BoardA\/config\.json$/.test(p))).toBe(true);
    expect(paths.some((p) => /BoardB\/config\.json$/.test(p))).toBe(true);
    expect(paths.filter((p) => /\/animations\/.+\.bin$/.test(p)).length).toBe(4);
  });

  it('config.json contains the board id, totalLeds, and output pin map', async () => {
    await bakeForSdCard({
      ...baseArgs(),
      patternNames: ['classics/foo.js'],
    });
    const boardAConfig = wrote.find((w) => w.relPath.endsWith('BoardA/config.json'));
    expect(boardAConfig?.contents).toBeDefined();
    const parsed = JSON.parse(boardAConfig!.contents!);
    expect(parsed.boardId).toBe('A');
    expect(parsed.totalLeds).toBe(500);
    expect(parsed.outputs.length).toBe(5);
    // First 5 Dig-Octa pins: 0, 1, 2, 3, 4
    expect(parsed.outputs.map((o: any) => o.pin)).toEqual([0, 1, 2, 3, 4]);
    expect(parsed.outputs[0]).toMatchObject({ ledStart: 0, ledCount: 100, label: 'LED1' });
  });
});

describe('SD-card bake — .bin file format', () => {
  it('writes a valid header with magic, version, fps, ledCount, frameCount', async () => {
    await bakeForSdCard({
      ...baseArgs(),
      patternNames: ['classics/solid.js'],
    });
    const bin = wrote.find((w) => w.relPath.endsWith('BoardA/animations/solid.bin'));
    expect(bin?.bytes).toBeDefined();
    const b = bin!.bytes!;
    expect(b[0]).toBe(BIN_MAGIC[0]);
    expect(b[1]).toBe(BIN_MAGIC[1]);
    expect(b[2]).toBe(BIN_MAGIC[2]);
    expect(b[3]).toBe(BIN_MAGIC[3]);
    expect(b[4]).toBe(BIN_VERSION);
    // fps = 5
    expect(b[6] | (b[7] << 8)).toBe(5);
    // ledCount = 500 (this board's slice, NOT the cube total of 1000)
    expect(b[8] | (b[9] << 8) | (b[10] << 16) | (b[11] << 24)).toBe(500);
    // frameCount = 1s × 5fps = 5
    expect(b[12] | (b[13] << 8) | (b[14] << 16) | (b[15] << 24)).toBe(5);
  });

  it('binary body is frames × ledCount × 3 bytes after the 16-byte header', async () => {
    const seconds = 2;
    const fps = 10;
    await bakeForSdCard({
      ...baseArgs(),
      seconds,
      fps,
      patternNames: ['classics/solid.js'],
    });
    const bin = wrote.find((w) => w.relPath.endsWith('BoardA/animations/solid.bin'));
    const b = bin!.bytes!;
    const expectedFrames = seconds * fps; // 20
    const expectedLedCount = 500;
    const expectedBodySize = expectedFrames * expectedLedCount * 3;
    expect(b.length).toBe(BIN_HEADER_LEN + expectedBodySize);
  });

  it('per-board .bin contains only the slice that board owns (not the whole cube)', async () => {
    await bakeForSdCard({
      ...baseArgs(),
      patternNames: ['classics/solid.js'],
    });
    const a = wrote.find((w) => w.relPath.endsWith('BoardA/animations/solid.bin'))!.bytes!;
    const bSlice = wrote.find((w) => w.relPath.endsWith('BoardB/animations/solid.bin'))!.bytes!;
    // Both boards should have the same header + body length (500 LEDs each).
    expect(a.length).toBe(bSlice.length);
    // Both contain identical bytes because the test pattern returns
    // a constant per-voxel color — but the WIDTH of each file is exactly
    // 500 LEDs of 3 bytes each, not 1000.
    expect(a.length - BIN_HEADER_LEN).toBe(500 * 3 * 5);
  });

  it('continues across patterns even if one fails to load', async () => {
    // Re-mock loadPattern to fail on one of the names.
    const { loadPattern } = await import('../patternRuntime');
    (loadPattern as any).mockImplementation(async (name: string) => {
      if (name.includes('broken')) {
        return { ok: false, error: 'simulated load failure' };
      }
      return {
        ok: true,
        pattern: {
          name,
          displayName: name.split('/').pop()!.replace(/\.js$/, ''),
          params: {},
          kind: 'function',
          renderVoxel: () => [10, 20, 30],
        },
        source: '',
      };
    });
    const res = await bakeForSdCard({
      ...baseArgs(),
      patternNames: ['classics/good.js', 'classics/broken.js', 'classics/other.js'],
    });
    expect(res.patternsBaked).toBe(2);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toContain('broken');
  });
});

describe('SD-card bake — filename length + collision (sync-name safety)', () => {
  // The firmware sync packet caps the name at 64 bytes incl ".bin", so the
  // stem must be clamped to 60 and stay unique across the bake or followers
  // could never match the master's broadcast name.
  beforeEach(async () => {
    const { loadPattern } = await import('../patternRuntime');
    (loadPattern as any).mockImplementation(async (name: string) => ({
      ok: true,
      pattern: {
        name,
        displayName: name.split('/').pop()!.replace(/\.js$/, ''),
        params: {},
        kind: 'function',
        renderVoxel: () => [10, 20, 30],
      },
      source: '',
    }));
  });

  function binNames(): string[] {
    return wrote
      .map((w) => w.relPath)
      .filter((p) => /BoardA\/animations\/.+\.bin$/.test(p))
      .map((p) => p.split('/').pop()!);
  }

  it('clamps an over-long pattern name so the wire name fits in 64 bytes', async () => {
    const long = 'a'.repeat(80);
    await bakeForSdCard({ ...baseArgs(), patternNames: [`classics/${long}.js`] });
    const names = binNames();
    expect(names.length).toBe(1);
    // ".bin" included, total must fit the firmware's SYNC_MAX_NAME (64).
    expect(names[0].length).toBeLessThanOrEqual(64);
    expect(names[0].endsWith('.bin')).toBe(true);
  });

  it('disambiguates two names that clamp to the same stem', async () => {
    // Both start with 61 identical chars → first-60 clamp collides.
    const a = 'b'.repeat(61);
    const b = 'b'.repeat(60) + 'c';
    await bakeForSdCard({ ...baseArgs(), patternNames: [`classics/${a}.js`, `classics/${b}.js`] });
    const names = binNames();
    expect(names.length).toBe(2);
    expect(new Set(names).size).toBe(2);          // no overwrite
    for (const n of names) expect(n.length).toBeLessThanOrEqual(64);
  });
});
