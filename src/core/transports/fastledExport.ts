// FastLED .ino export — records N seconds of the current pattern at a
// chosen frame rate and bakes every frame into a PROGMEM byte array.
// The generated sketch plays the recorded animation in a loop.
//
// Two output modes:
//
//   single-pin   — One sketch driving one GPIO output. Original behavior;
//                  fine for small builds where a single chain is OK.
//
//   multi-board  — One sketch PER BOARD, each with multiple FastLED
//                  outputs (e.g. five Q1..Q5 outputs on a QuinLED
//                  Dig-Octa Brainboard driving five panels in parallel).
//                  Total bake size per board = ledCount × 3 × frames,
//                  so two Dig-Octas with 500 LEDs each × 150 frames =
//                  ~225 KB each, well within the 4 MB flash.
//
// Color order: bakeFrame() already shuffles bytes to the user-selected
// physical order (e.g. GRB for WS2815), so the bytes in PROGMEM are
// chip-correct as-is. FastLED.addLeds<...,RGB> reads them straight
// through with no second shuffle. (The old single-pin sketch passed
// the user's colorOrder to FastLED *as well*, which double-shuffled
// for any non-RGB choice — fixed in this revision.)
//
// Arduino IDE expects each .ino to live in a folder of the same name.
// We write into `exports/{stem}_{ts}/{stem}_{ts}.ino` so the user can
// open the folder directly without hand-wrapping it.

import { invoke } from '@tauri-apps/api/core';
import { ledCount, buildCoords, gridDims, type CubeSpec } from '../cubeGeometry';
import type { LoadedPattern, RenderContext, SetupContext } from '../patternApi';
import { patternUtils } from '../utils';
import { buildGammaLut, computeDuty, bakeFrame, type ColorConfig } from '../colorPipeline';
import { estimatePower, type PowerConfig } from '../power';
import { buildAddressMapForCube, type WiringConfig } from '../wiring';
import { renderPatternFrame } from '../patternRender';
import type { ExportBoard } from './index';

export type ExportOptions = {
  seconds: number;
  fps: number;
  /** Sketch name stem — file ends up under exports/{stem}_{ts}/. */
  sketchStem?: string;
  // ONE of the next two must be set:
  /** Legacy single-pin mode. Ignored when `boards` is non-empty. */
  dataPin?: number;
  /** Multi-board mode. When set, emits one sketch per board. */
  boards?: ExportBoard[];
};

export type ExportResult = {
  /** All .ino paths written (one per board in multi-board mode, one total in single-pin). */
  paths: string[];
  frames: number;
  /** Total flash bytes baked across all sketches. */
  sizeKb: number;
};

export async function exportFastLed(args: {
  pattern: LoadedPattern;
  paramValues: Record<string, any>;
  cube: CubeSpec;
  color: ColorConfig;
  power: PowerConfig;
  wiring: WiringConfig;
  options: ExportOptions;
}): Promise<ExportResult> {
  const { pattern, paramValues, cube, color, power, wiring, options } = args;
  const { seconds, fps } = options;

  const { Nx, Ny, Nz } = gridDims(cube);
  const Nmax = Math.max(Nx, Ny, Nz);
  const count = ledCount(cube);
  const coords = buildCoords(cube);
  const addressMap = buildAddressMapForCube(cube, wiring);
  const gammaLut = buildGammaLut(color.gamma);

  const patternBuf = new Uint8ClampedArray(count * 3);
  const dutyBuf = new Uint8ClampedArray(count * 3);
  const streamBuf = new Uint8Array(count * 3);

  const totalFrames = Math.max(1, Math.round(seconds * fps));
  const dt = 1 / fps;

  const setupCtx: SetupContext = { Nx, Ny, Nz, N: Nmax, params: paramValues };
  if (pattern.setup) pattern.setup(setupCtx);

  // Per-frame all-LEDs stream rendered once, then sliced per board.
  // Each entry of `frames` is the full stream-ordered byte buffer for
  // that frame; multi-board mode picks the relevant ranges below.
  const frames: Uint8Array[] = [];
  for (let f = 0; f < totalFrames; f++) {
    const ctx: RenderContext = {
      t: f * dt,
      dt,
      frame: f,
      Nx,
      Ny,
      Nz,
      N: Nmax,
      params: paramValues,
      audio: { energy: 0, low: 0, mid: 0, high: 0, beat: false },
      power: { amps: 0, watts: 0, budgetAmps: power.budgetAmps, scale: 1 },
      utils: patternUtils,
    };
    renderPatternFrame(pattern, ctx, coords, patternBuf);
    computeDuty(patternBuf, color.brightness, dutyBuf);
    const pre = estimatePower(dutyBuf, power);
    bakeFrame(patternBuf, color, gammaLut, pre.scale, addressMap, null, streamBuf);
    frames.push(streamBuf.slice());
  }

  const ts = timestamp();
  const stem = sanitize(options.sketchStem ?? pattern.displayName);

  // Multi-board path.
  if (options.boards && options.boards.length > 0) {
    const paths: string[] = [];
    let totalBytes = 0;
    for (const board of options.boards) {
      const sketch = buildMultiOutputSketch({
        board,
        frames,
        totalFrames,
        fps,
        paramValues,
        patternName: pattern.displayName,
        cubeDims: { Nx, Ny, Nz },
      });
      const dir = `${stem}_Board${board.id}_${ts}`;
      const relPath = `${dir}/${dir}.ino`;
      const wrote = await invoke<string>('write_export', { relPath, contents: sketch });
      paths.push(wrote);
      totalBytes += sketch.length;
    }
    return {
      paths,
      frames: totalFrames,
      sizeKb: Math.round((totalBytes / 1024) * 10) / 10,
    };
  }

  // Single-pin legacy path.
  const dataPin = options.dataPin ?? 16;
  const sketch = buildSinglePinSketch({
    Nx, Ny, Nz,
    count,
    dataPin,
    fps,
    totalFrames,
    paramValues,
    patternName: pattern.displayName,
    frames,
  });
  const dir = `${stem}_${ts}`;
  const relPath = `${dir}/${dir}.ino`;
  const wrote = await invoke<string>('write_export', { relPath, contents: sketch });
  return {
    paths: [wrote],
    frames: totalFrames,
    sizeKb: Math.round((sketch.length / 1024) * 10) / 10,
  };
}

/** How many flash bytes a given export will consume (approximate, per-board). */
export function estimateExportSize(
  cube: CubeSpec,
  seconds: number,
  fps: number,
): number {
  return ledCount(cube) * 3 * Math.max(1, Math.round(seconds * fps));
}

/** Per-board estimate when an exportBoards layout is configured. */
export function estimateBoardSize(
  board: ExportBoard,
  seconds: number,
  fps: number,
): number {
  return board.ledCount * 3 * Math.max(1, Math.round(seconds * fps));
}

function formatFrameRow(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0) s += ',';
    s += '0x' + bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

function buildSinglePinSketch(args: {
  Nx: number;
  Ny: number;
  Nz: number;
  count: number;
  dataPin: number;
  fps: number;
  totalFrames: number;
  paramValues: Record<string, any>;
  patternName: string;
  frames: Uint8Array[];
}): string {
  const {
    Nx, Ny, Nz, count, dataPin, fps, totalFrames,
    paramValues, patternName, frames,
  } = args;

  const frameBytes = count * 3;
  const paramsComment = Object.keys(paramValues)
    .map((k) => `//   ${k} = ${JSON.stringify(paramValues[k])}`)
    .join('\n');
  const framesSource = frames
    .map((f) => `  {${formatFrameRow(f)}}`)
    .join(',\n');

  return `// Generated by VolumeCube — pattern: ${patternName}
// ${new Date().toISOString()}
// Baked ${totalFrames} frames at ${fps} fps (${(totalFrames / fps).toFixed(2)} s loop).
// Grid: ${Nx} x ${Ny} x ${Nz}
// Params:
${paramsComment}

#include <FastLED.h>

#define NX          ${Nx}
#define NY          ${Ny}
#define NZ          ${Nz}
#define LED_COUNT   ${count}
#define DATA_PIN    ${dataPin}
#define FPS         ${fps}
#define FRAME_COUNT ${totalFrames}
#define FRAME_BYTES ${frameBytes}

CRGB leds[LED_COUNT];

// Flash-resident frame data. Each row is one frame in stream order,
// already shuffled to the configured chip color order, so FastLED's
// addLeds<...,RGB> reads it through unmodified.
const uint8_t PROGMEM frames[FRAME_COUNT][FRAME_BYTES] = {
${framesSource}
};

void setup() {
  FastLED.addLeds<WS2815, DATA_PIN, RGB>(leds, LED_COUNT);
  FastLED.setBrightness(255);
  FastLED.clear();
  FastLED.show();
}

void loop() {
  static uint16_t f = 0;
  memcpy_P((uint8_t*)leds, frames[f], FRAME_BYTES);
  FastLED.show();
  f = (f + 1) % FRAME_COUNT;
  delay(1000 / FPS);
}
`;
}

function buildMultiOutputSketch(args: {
  board: ExportBoard;
  frames: Uint8Array[];
  totalFrames: number;
  fps: number;
  paramValues: Record<string, any>;
  patternName: string;
  cubeDims: { Nx: number; Ny: number; Nz: number };
}): string {
  const { board, frames, totalFrames, fps, paramValues, patternName, cubeDims } = args;
  const frameBytes = board.ledCount * 3;

  // Slice each frame down to this board's byte range. Stream-global
  // bytes [board.ledStart*3 ... (board.ledStart+board.ledCount)*3)
  // become the board-local PROGMEM data.
  const sliceStart = board.ledStart * 3;
  const sliceEnd = sliceStart + frameBytes;
  const localFrames = frames.map((f) => f.subarray(sliceStart, sliceEnd));

  const paramsComment = Object.keys(paramValues)
    .map((k) => `//   ${k} = ${JSON.stringify(paramValues[k])}`)
    .join('\n');

  const framesSource = localFrames
    .map((f) => `  {${formatFrameRow(f)}}`)
    .join(',\n');

  const outputDecls = board.outputs
    .map((o) => {
      const label = o.label ? `  // ${o.label}: ${o.ledCount} LEDs` : '';
      return `  FastLED.addLeds<WS2815, ${o.pin}, RGB>(leds, ${o.ledStart}, ${o.ledCount});${label}`;
    })
    .join('\n');

  const outputsComment = board.outputs
    .map((o) => `//   ${o.label ?? 'out'} GPIO${o.pin}: LEDs ${o.ledStart}..${o.ledStart + o.ledCount - 1}`)
    .join('\n');

  return `// Generated by VolumeCube — pattern: ${patternName}
// ${new Date().toISOString()}
// Baked ${totalFrames} frames at ${fps} fps (${(totalFrames / fps).toFixed(2)} s loop).
// Grid: ${cubeDims.Nx} x ${cubeDims.Ny} x ${cubeDims.Nz}
//
// Board: ${board.name} (id="${board.id}")
//   LEDs ${board.ledStart}..${board.ledStart + board.ledCount - 1} of the global stream
//   ${board.outputs.length} output channels:
${outputsComment}
//
// Params:
${paramsComment}

#include <FastLED.h>

#define LED_COUNT   ${board.ledCount}
#define FPS         ${fps}
#define FRAME_COUNT ${totalFrames}
#define FRAME_BYTES ${frameBytes}

CRGB leds[LED_COUNT];

// Frame data is pre-shuffled to chip color order by the exporter, so
// FastLED's addLeds<...,RGB> writes the bytes straight through.
const uint8_t PROGMEM frames[FRAME_COUNT][FRAME_BYTES] = {
${framesSource}
};

void setup() {
${outputDecls}
  FastLED.setBrightness(255);
  FastLED.clear();
  FastLED.show();
}

void loop() {
  static uint16_t f = 0;
  memcpy_P((uint8_t*)leds, frames[f], FRAME_BYTES);
  FastLED.show();
  f = (f + 1) % FRAME_COUNT;
  delay(1000 / FPS);
}
`;
}

function sanitize(name: string): string {
  return (name || 'pattern').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'pattern';
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '_' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}
