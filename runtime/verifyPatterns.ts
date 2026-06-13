// Pattern verification harness.
//
// Loads every .js under patterns/, runs setup() + N frames through the
// real engine on a couple of cube shapes, and reports per-pattern:
//   • THROW    — setup or render threw
//   • NAN      — produced a NaN / Infinity / out-of-range byte
//   • BLACK    — every frame was entirely 0 (likely a dead pattern)
//   • STATIC   — output never changed across frames (frozen — usually a
//                bug for an animation, but some are legitimately static)
//   • OK       — animated, in-range, non-trivial
//
// This is the gate for the "make every pattern a show-stopper" rewrite:
// run it before to baseline, after to catch regressions. It does NOT
// judge aesthetics — only that a pattern runs, animates, and stays sane.
//
//   npx tsx runtime/verifyPatterns.ts            # all patterns
//   npx tsx runtime/verifyPatterns.ts fire fire  # filter by substring

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPatternFromDisk, listPatternsOnDisk } from './loadPattern';
import { buildCoords, gridDims, type CubeSpec } from '../src/core/cubeGeometry';
import { renderPatternFrame } from '../src/core/patternRender';
import { patternUtils } from '../src/core/utils';
import { mergeParamValues, type RenderContext, type SetupContext } from '../src/core/patternApi';

const PATTERNS_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../patterns');

const SHAPES: Array<{ label: string; cube: CubeSpec }> = [
  { label: '10x10x10', cube: { kind: 'lattice', Nx: 10, Ny: 10, Nz: 10, pitchMeters: 0.1016 } },
  { label: '10x10x3',  cube: { kind: 'lattice', Nx: 10, Ny: 10, Nz: 3,  pitchMeters: 0.1016 } },
];

const FRAMES = 45;     // ~1.5 s at 30 fps — enough to catch motion + late spawns
const FPS = 30;

type Verdict = 'OK' | 'THROW' | 'NAN' | 'BLACK' | 'STATIC';
type Result = {
  name: string;
  verdict: Verdict;
  detail: string;
  litFracMax: number;     // peak fraction of voxels lit across frames
  meanBrightness: number; // 0..255 averaged over lit voxels at peak
};

async function verifyOne(name: string): Promise<Result> {
  let pattern;
  try {
    pattern = await loadPatternFromDisk(PATTERNS_ROOT, name);
  } catch (e: any) {
    return { name, verdict: 'THROW', detail: `load: ${e?.message ?? e}`, litFracMax: 0, meanBrightness: 0 };
  }

  // Run on the first shape for the verdict; the second shape is a
  // crash-only smoke test (non-cubic shapes break naive patterns).
  let worst: Result | null = null;
  for (const { label, cube } of SHAPES) {
    const r = runShape(pattern, name, cube, label);
    if (!worst || severity(r.verdict) > severity(worst.verdict)) worst = r;
    if (r.verdict === 'THROW' || r.verdict === 'NAN') break; // fail fast
  }
  return worst!;
}

function severity(v: Verdict): number {
  return { OK: 0, STATIC: 1, BLACK: 2, NAN: 3, THROW: 4 }[v];
}

function runShape(pattern: any, name: string, cube: CubeSpec, label: string): Result {
  const dims = gridDims(cube);
  const Nmax = Math.max(dims.Nx, dims.Ny, dims.Nz);
  const count = dims.Nx * dims.Ny * dims.Nz;
  const coords = buildCoords(cube);
  const buf = new Uint8ClampedArray(count * 3);
  const params = mergeParamValues(pattern.params, {});

  try {
    if (pattern.setup) {
      const sctx: SetupContext = { Nx: dims.Nx, Ny: dims.Ny, Nz: dims.Nz, N: Nmax, params };
      pattern.setup(sctx);
    }
  } catch (e: any) {
    return { name, verdict: 'THROW', detail: `setup@${label}: ${e?.message ?? e}`, litFracMax: 0, meanBrightness: 0 };
  }

  const dt = 1 / FPS;
  let anyLit = false;
  let litFracMax = 0;
  let meanBrightnessAtPeak = 0;
  let firstFrameSig = '';
  let changed = false;
  // Mild beat so audio patterns show something in the harness.
  for (let f = 0; f < FRAMES; f++) {
    const beat = f % 15 === 0;
    const energy = 0.5 + 0.5 * Math.sin(f * 0.4);
    const ctx: RenderContext = {
      t: f * dt, dt, frame: f,
      Nx: dims.Nx, Ny: dims.Ny, Nz: dims.Nz, N: Nmax,
      params,
      audio: { energy, low: energy, mid: energy * 0.7, high: energy * 0.4, beat },
      power: { amps: 0, watts: 0, budgetAmps: 30, scale: 1 },
      utils: patternUtils,
    };
    try {
      renderPatternFrame(pattern, ctx, coords, buf);
    } catch (e: any) {
      return { name, verdict: 'THROW', detail: `render@${label} f${f}: ${e?.message ?? e}`, litFracMax, meanBrightness: 0 };
    }
    // Sanity + stats.
    let lit = 0, sum = 0, sig = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      if (!Number.isFinite(v)) {
        return { name, verdict: 'NAN', detail: `non-finite byte @${label} f${f} idx${i}`, litFracMax, meanBrightness: 0 };
      }
      if (v > 0) { sum += v; }
      sig = (sig * 31 + v) | 0;
    }
    for (let p = 0; p < count; p++) {
      if (buf[p * 3] || buf[p * 3 + 1] || buf[p * 3 + 2]) lit++;
    }
    const frac = lit / count;
    if (frac > litFracMax) { litFracMax = frac; meanBrightnessAtPeak = lit ? sum / (lit * 3) : 0; }
    if (lit > 0) anyLit = true;
    const sigStr = String(sig);
    if (f === 0) firstFrameSig = sigStr;
    else if (sigStr !== firstFrameSig) changed = true;
  }

  if (!anyLit) {
    return { name, verdict: 'BLACK', detail: `no lit voxels in ${FRAMES} frames @${label}`, litFracMax, meanBrightness: 0 };
  }
  if (!changed) {
    return { name, verdict: 'STATIC', detail: `output never changed across ${FRAMES} frames @${label}`, litFracMax, meanBrightness: meanBrightnessAtPeak };
  }
  return { name, verdict: 'OK', detail: `peak ${(litFracMax * 100).toFixed(0)}% lit, mean ${meanBrightnessAtPeak.toFixed(0)}/255 @${label}`, litFracMax, meanBrightness: meanBrightnessAtPeak };
}

async function main() {
  const filters = process.argv.slice(2);
  let names = listPatternsOnDisk(PATTERNS_ROOT);
  if (filters.length) names = names.filter((n) => filters.some((f) => n.includes(f)));

  const results: Result[] = [];
  for (const name of names) results.push(await verifyOne(name));

  const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);
  let bad = 0;
  console.log('');
  for (const r of results) {
    const mark = r.verdict === 'OK' ? '✓' : '✗';
    if (r.verdict !== 'OK') bad++;
    console.log(`${mark} ${pad(r.verdict, 7)} ${pad(r.name, 42)} ${r.detail}`);
  }
  console.log('');
  console.log(`${results.length - bad}/${results.length} OK, ${bad} need attention.`);
  process.exit(bad > 0 ? 1 : 0);
}

main();
