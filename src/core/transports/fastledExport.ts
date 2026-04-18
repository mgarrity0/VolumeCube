// FastLED .ino export — records N seconds of the current pattern at a
// chosen frame rate and bakes every frame into a PROGMEM byte array.
// The generated sketch plays the recorded animation in a loop.
//
// This is the simplest credible MVP for "run the cube untethered": the
// sketch is just a tape-recorder, so any pattern — including class-API
// particle systems — exports as if it were prerendered video.
//
// Memory: 10×10×10 LEDs × 3 bytes × 150 frames (5 s @ 30 fps) = 450 KB.
// ESP32 has 4 MB flash by default so this fits. Users tweaking seconds
// or FPS above 10-20× that will start to hit flash limits; the panel
// surfaces the expected size.

import { invoke } from '@tauri-apps/api/core';
import { ledCount, type CubeSpec } from '../cubeGeometry';
import type { LoadedPattern, ParamSchema, RenderContext, SetupContext, VoxelCoord } from '../patternApi';
import { patternUtils } from '../utils';
import { buildGammaLut, bakeStreamBytes, type ColorConfig } from '../colorPipeline';
import { estimatePower, type PowerConfig } from '../power';
import { buildAddressMap, type WiringConfig } from '../wiring';
import { buildCoords } from '../cubeGeometry';

export type ExportOptions = {
  seconds: number;
  fps: number;
  dataPin: number;
  /** Sketch name stem — the file ends up at exports/{stem}_{timestamp}.ino */
  sketchStem?: string;
};

export async function exportFastLed(args: {
  pattern: LoadedPattern;
  paramValues: Record<string, any>;
  cube: CubeSpec;
  color: ColorConfig;
  power: PowerConfig;
  wiring: WiringConfig;
  options: ExportOptions;
}): Promise<{ path: string; frames: number; sizeKb: number }> {
  const { pattern, paramValues, cube, color, power, wiring, options } = args;
  const { seconds, fps, dataPin } = options;

  const N = cube.N;
  const count = ledCount(cube);
  const coords = buildCoords(cube);
  const addressMap = buildAddressMap(wiring, N);
  const gammaLut = buildGammaLut(color.gamma);

  const patternBuf = new Uint8ClampedArray(count * 3);
  const dutyBuf = new Uint8ClampedArray(count * 3);
  const streamBuf = new Uint8Array(count * 3);

  const totalFrames = Math.max(1, Math.round(seconds * fps));
  const dt = 1 / fps;

  // Run setup once. Class patterns carry persistent state on their
  // instance; function patterns may provide an optional setup hook too.
  const setupCtx: SetupContext = { N, params: paramValues };
  if (pattern.setup) pattern.setup(setupCtx);

  // Baked frame array, one row per frame.
  // Storing as strings so we can assemble the sketch without a 450KB
  // worst-case intermediate array of numbers.
  const rows: string[] = [];

  for (let f = 0; f < totalFrames; f++) {
    const ctx: RenderContext = {
      t: f * dt,
      dt,
      frame: f,
      N,
      params: paramValues,
      // Offline export: no live mic. Beat-reactive patterns will look
      // dormant in the baked loop — documented constraint of the v1
      // exporter.
      audio: { energy: 0, low: 0, mid: 0, high: 0, beat: false },
      power: { amps: 0, watts: 0, budgetAmps: power.budgetAmps, scale: 1 },
      utils: patternUtils,
    };

    if (pattern.kind === 'class' && pattern.instance) {
      pattern.instance.update?.(ctx);
      pattern.instance.render(ctx, patternBuf);
    } else if (pattern.kind === 'function' && pattern.renderVoxel) {
      const xyz: VoxelCoord = {
        x: 0, y: 0, z: 0, u: 0, v: 0, w: 0, cx: 0, cy: 0, cz: 0, i: 0,
      };
      const { xs, ys, zs, us, vs, ws, cxs, cys, czs } = coords;
      for (let i = 0; i < count; i++) {
        xyz.x = xs[i]; xyz.y = ys[i]; xyz.z = zs[i];
        xyz.u = us[i]; xyz.v = vs[i]; xyz.w = ws[i];
        xyz.cx = cxs[i]; xyz.cy = cys[i]; xyz.cz = czs[i];
        xyz.i = i;
        const rgb = pattern.renderVoxel(ctx, xyz);
        patternBuf[i * 3 + 0] = rgb[0];
        patternBuf[i * 3 + 1] = rgb[1];
        patternBuf[i * 3 + 2] = rgb[2];
      }
    }

    // Same color/power pipeline as the live render so the baked bytes
    // match what the simulator shows at the moment of capture.
    const brightness = color.brightness;
    for (let i = 0; i < dutyBuf.length; i++) {
      const v = patternBuf[i] * brightness;
      dutyBuf[i] = v > 255 ? 255 : v;
    }
    const pre = estimatePower(dutyBuf, power);
    bakeStreamBytes(patternBuf, streamBuf, color, gammaLut, pre.scale, addressMap);
    rows.push(formatFrameRow(streamBuf));
  }

  const sketch = buildSketch({
    N,
    count,
    dataPin,
    fps,
    totalFrames,
    paramsSchema: pattern.params,
    paramValues,
    patternName: pattern.displayName,
    colorOrder: color.colorOrder,
    frames: rows,
  });

  const stem = sanitize(options.sketchStem ?? pattern.displayName);
  const ts = timestamp();
  const relPath = `${stem}_${ts}.ino`;
  const path = await invoke<string>('write_export', {
    relPath,
    contents: sketch,
  });

  return {
    path,
    frames: totalFrames,
    sizeKb: Math.round((sketch.length / 1024) * 10) / 10,
  };
}

/** How many flash bytes a given export will consume (approximate). */
export function estimateExportSize(N: number, seconds: number, fps: number): number {
  return N * N * N * 3 * Math.max(1, Math.round(seconds * fps));
}

function formatFrameRow(bytes: Uint8Array): string {
  // Pack as hex pairs separated by commas — readable in the sketch and
  // compact enough that 450KB+ compiles without choking avr-gcc.
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0) s += ',';
    s += '0x' + bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

function buildSketch(args: {
  N: number;
  count: number;
  dataPin: number;
  fps: number;
  totalFrames: number;
  paramsSchema: ParamSchema;
  paramValues: Record<string, any>;
  patternName: string;
  colorOrder: string;
  frames: string[];
}): string {
  const {
    N, count, dataPin, fps, totalFrames,
    paramsSchema, paramValues, patternName, colorOrder,
    frames,
  } = args;

  const frameBytes = count * 3;
  const rgbOrder = colorOrder === 'GRB' ? 'GRB' : colorOrder === 'RGB' ? 'RGB' :
                   colorOrder === 'BRG' ? 'BRG' : colorOrder === 'BGR' ? 'BGR' :
                   colorOrder === 'GBR' ? 'GBR' : 'RBG';

  const paramsComment = Object.keys(paramsSchema)
    .map((k) => `//   ${k} = ${JSON.stringify(paramValues[k] ?? (paramsSchema[k] as any).default)}`)
    .join('\n');

  const framesSource = frames
    .map((row) => `  {${row}}`)
    .join(',\n');

  return `// Generated by VolumeCube — pattern: ${patternName}
// ${new Date().toISOString()}
// Baked ${totalFrames} frames at ${fps} fps (${(totalFrames / fps).toFixed(2)} s loop).
// Params:
${paramsComment}

#include <FastLED.h>

#define N           ${N}
#define LED_COUNT   ${count}
#define DATA_PIN    ${dataPin}
#define FPS         ${fps}
#define FRAME_COUNT ${totalFrames}
#define FRAME_BYTES ${frameBytes}

CRGB leds[LED_COUNT];

// Flash-resident frame data. Each row is one frame in stream order,
// ready to memcpy straight into the CRGB buffer.
const uint8_t PROGMEM frames[FRAME_COUNT][FRAME_BYTES] = {
${framesSource}
};

void setup() {
  FastLED.addLeds<WS2815, DATA_PIN, ${rgbOrder}>(leds, LED_COUNT);
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
