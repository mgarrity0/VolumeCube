// SD-card pattern export.
//
// Instead of baking PROGMEM source code per pattern (one .ino file each,
// flash a new sketch every time you want a new pattern), this exporter
// writes flat .bin files of raw frame data per board, plus a tiny
// config.json per board. The generic player firmware on the ESP32
// reads the SD card, lists the .bin files, plays whichever the user
// picks via the phone web UI, no re-flash needed.
//
// File-system layout produced (drop one Board* folder onto each
// Brainboard's microSD root):
//
//   exports/sdcard_{ts}/
//     BoardA/
//       config.json                board id + pin map + LED ranges
//       animations/
//         harmonic-blob.bin
//         jellyfish.bin
//         lorenz-attractor.bin
//         ...
//     BoardB/
//       config.json
//       animations/
//         harmonic-blob.bin
//         ...
//
// .bin file format — self-describing so firmware can validate at
// playback time:
//
//   bytes  0-3   magic   = 'VCAN' (0x56 0x43 0x41 0x4E)
//   byte   4     version = 1
//   byte   5     reserved (0)
//   bytes  6-7   fps      uint16 LE
//   bytes  8-11  ledCount uint32 LE   (this board's slice, not the cube total)
//   bytes 12-15  frames   uint32 LE
//   bytes 16+    frame data: frames × ledCount × 3 bytes, RGB pre-shuffled
//                to the chip color order. memcpy straight to CRGB[].

import { invoke } from '@tauri-apps/api/core';
import { ledCount, buildCoords, gridDims, type CubeSpec } from '../cubeGeometry';
import { patternUtils } from '../utils';
import { buildGammaLut, computeDuty, bakeFrame, type ColorConfig } from '../colorPipeline';
import { estimatePower, type PowerConfig } from '../power';
import { buildAddressMapForCube, type WiringConfig } from '../wiring';
import { renderPatternFrame } from '../patternRender';
import {
  mergeParamValues,
  type RenderContext,
  type SetupContext,
} from '../patternApi';
import { loadPattern } from '../patternRuntime';
import type { ExportBoard } from './index';

export const BIN_MAGIC = [0x56, 0x43, 0x41, 0x4e]; // 'VCAN'
export const BIN_VERSION = 1;
export const BIN_HEADER_LEN = 16;
// The player firmware carries the file name in its UDP sync packet, where
// the name field is capped at SYNC_MAX_NAME (64) bytes INCLUDING ".bin".
// A longer name gets truncated on the wire and followers can never match
// it → they'd never play that pattern in lockstep. So the stem (name
// without ".bin") is clamped to 60 chars at bake time, and collisions
// from clamping/sanitizing are disambiguated with a numeric suffix.
export const MAX_STEM = 60;

export type SdCardBakeArgs = {
  /** Pattern relative paths to bake (e.g. "classics/harmonic-blob.js"). */
  patternNames: string[];
  cube: CubeSpec;
  wiring: WiringConfig;
  color: ColorConfig;
  power: PowerConfig;
  boards: ExportBoard[];
  /** Param overrides keyed by pattern name; missing keys use schema defaults. */
  paramValues: Record<string, Record<string, any>>;
  seconds: number;
  fps: number;
};

export type SdCardBakeResult = {
  baseDir: string;
  paths: string[];
  errors: string[];
  totalSizeKb: number;
  patternsBaked: number;
};

export async function bakeForSdCard(
  args: SdCardBakeArgs,
  onProgress?: (msg: string) => void,
): Promise<SdCardBakeResult> {
  const { patternNames, cube, wiring, color, power, boards, paramValues, seconds, fps } = args;
  const total = ledCount(cube);
  const coords = buildCoords(cube);
  const addressMap = buildAddressMapForCube(cube, wiring);
  const gammaLut = buildGammaLut(color.gamma);
  const { Nx, Ny, Nz } = gridDims(cube);
  const Nmax = Math.max(Nx, Ny, Nz);
  const frameCount = Math.max(1, Math.round(seconds * fps));
  const dt = 1 / fps;

  const ts = timestamp();
  const baseDir = `sdcard_${ts}`;
  const paths: string[] = [];
  const errors: string[] = [];
  let totalBytes = 0;

  // ---- Per-board config.json ----
  for (const board of boards) {
    const cfg = {
      boardId: board.id,
      name: board.name,
      totalLeds: board.ledCount,
      ledStartInCube: board.ledStart,
      fps,
      outputs: board.outputs.map((o) => ({
        pin: o.pin,
        ledStart: o.ledStart,
        ledCount: o.ledCount,
        label: o.label ?? null,
      })),
    };
    const relPath = `${baseDir}/Board${board.id}/config.json`;
    const wrote = await invoke<string>('write_export', {
      relPath,
      contents: JSON.stringify(cfg, null, 2),
    });
    paths.push(wrote);
  }

  // ---- One .bin per pattern × board ----
  let patternsBaked = 0;
  const patternBuf = new Uint8ClampedArray(total * 3);
  const dutyBuf = new Uint8ClampedArray(total * 3);
  const streamBuf = new Uint8Array(total * 3);
  // Track emitted stems so two patterns that sanitize/clamp to the same
  // name don't overwrite each other's .bin (and so the firmware sees
  // distinct, matchable names).
  const usedStems = new Set<string>();

  for (const patternName of patternNames) {
    onProgress?.(`Loading ${patternName}…`);
    const loadRes = await loadPattern(patternName);
    if (!loadRes.ok) {
      errors.push(`${patternName}: ${loadRes.error}`);
      continue;
    }
    const pattern = loadRes.pattern;
    const params = mergeParamValues(pattern.params, paramValues[patternName] ?? {});

    if (pattern.setup) {
      const setupCtx: SetupContext = { Nx, Ny, Nz, N: Nmax, params };
      pattern.setup(setupCtx);
    }

    // Allocate per-board frame buffers up-front so we know exactly how
    // much memory we'll consume during the render of this pattern.
    const boardBuffers = new Map<string, Uint8Array>();
    for (const board of boards) {
      boardBuffers.set(board.id, new Uint8Array(BIN_HEADER_LEN + frameCount * board.ledCount * 3));
      writeBinHeader(boardBuffers.get(board.id)!, fps, board.ledCount, frameCount);
    }

    onProgress?.(`${patternName}: rendering ${frameCount} frames…`);
    for (let f = 0; f < frameCount; f++) {
      const ctx: RenderContext = {
        t: f * dt,
        dt,
        frame: f,
        Nx,
        Ny,
        Nz,
        N: Nmax,
        params,
        audio: { energy: 0, low: 0, mid: 0, high: 0, beat: false },
        power: { amps: 0, watts: 0, budgetAmps: power.budgetAmps, scale: 1 },
        utils: patternUtils,
      };
      renderPatternFrame(pattern, ctx, coords, patternBuf);
      computeDuty(patternBuf, color.brightness, dutyBuf);
      const pre = estimatePower(dutyBuf, power);
      bakeFrame(patternBuf, color, gammaLut, pre.scale, addressMap, null, streamBuf);

      for (const board of boards) {
        const buf = boardBuffers.get(board.id)!;
        const startByte = board.ledStart * 3;
        const sliceLen = board.ledCount * 3;
        const writeOff = BIN_HEADER_LEN + f * sliceLen;
        buf.set(streamBuf.subarray(startByte, startByte + sliceLen), writeOff);
      }
    }

    // Write each board's .bin file. Tauri's write_export takes a string
    // and a binary file written as a string would mangle high bytes —
    // hence the new write_export_bytes command that takes Vec<u8>.
    const stem = uniqueStem(sanitize(pattern.displayName), usedStems);
    for (const board of boards) {
      const buf = boardBuffers.get(board.id)!;
      const relPath = `${baseDir}/Board${board.id}/animations/${stem}.bin`;
      const wrote = await invoke<string>('write_export_bytes', {
        relPath,
        bytes: Array.from(buf),
      });
      paths.push(wrote);
      totalBytes += buf.length;
    }
    patternsBaked++;
  }

  return {
    baseDir,
    paths,
    errors,
    totalSizeKb: Math.round(totalBytes / 1024),
    patternsBaked,
  };
}

/** Estimate the on-disk size of a single .bin file for a given board. */
export function estimateBinSize(
  ledCountForBoard: number,
  seconds: number,
  fps: number,
): number {
  return BIN_HEADER_LEN + ledCountForBoard * 3 * Math.max(1, Math.round(seconds * fps));
}

function writeBinHeader(buf: Uint8Array, fps: number, ledCount: number, frameCount: number): void {
  buf[0] = BIN_MAGIC[0];
  buf[1] = BIN_MAGIC[1];
  buf[2] = BIN_MAGIC[2];
  buf[3] = BIN_MAGIC[3];
  buf[4] = BIN_VERSION;
  buf[5] = 0;
  // fps uint16 LE
  buf[6] = fps & 0xff;
  buf[7] = (fps >> 8) & 0xff;
  // ledCount uint32 LE
  buf[8]  = ledCount & 0xff;
  buf[9]  = (ledCount >> 8) & 0xff;
  buf[10] = (ledCount >> 16) & 0xff;
  buf[11] = (ledCount >> 24) & 0xff;
  // frameCount uint32 LE
  buf[12] = frameCount & 0xff;
  buf[13] = (frameCount >> 8) & 0xff;
  buf[14] = (frameCount >> 16) & 0xff;
  buf[15] = (frameCount >> 24) & 0xff;
}

function sanitize(name: string): string {
  return (name || 'pattern').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'pattern';
}

/**
 * Clamp a stem to MAX_STEM chars and guarantee it's unique within this
 * bake. Clamping is deterministic so both boards produce the same .bin
 * filename — the firmware's sync packet (capped at 64 bytes incl. ".bin")
 * then carries an untruncated, matchable name. Collisions (from clamping
 * or sanitizing distinct display names to the same string) get a numeric
 * suffix that itself stays within the length budget.
 */
function uniqueStem(raw: string, used: Set<string>): string {
  let base = raw.slice(0, MAX_STEM);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = base.slice(0, MAX_STEM - suffix.length) + suffix;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
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
