// Runtime config — what the NUC streamer needs to drive the rig.
//
// Loaded from a JSON file passed via --config. Mirrors the shape of
// the desktop app's Zustand store but trimmed to just the fields that
// matter for headless streaming.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CubeSpec } from '../src/core/cubeGeometry';
import { defaultColorConfig, type ColorConfig } from '../src/core/colorPipeline';
import { defaultPowerConfig, type PowerConfig } from '../src/core/power';
import { defaultWiringConfig, type WiringConfig } from '../src/core/wiring';
import {
  defaultOutputConfig,
  type OutputConfig,
} from '../src/core/transports';

export type RuntimeConfig = {
  /** Absolute or relative path to patterns/ directory. */
  patternsRoot: string;
  cube: CubeSpec;
  wiring: WiringConfig;
  color: ColorConfig;
  power: PowerConfig;
  output: OutputConfig;
  /** Render + send target frame rate. */
  fps: number;
  /** Which pattern to play (relative path under patternsRoot). */
  pattern: {
    name: string;
    params?: Record<string, any>;
  };
};

export function loadConfig(configPath: string): RuntimeConfig {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}`);
  }
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));

  // Shallow-merge with defaults so the user only has to override what
  // differs from defaults. Anything explicitly in the file wins.
  const cube = raw.cube as CubeSpec;
  if (!cube || !('kind' in cube)) {
    throw new Error('config.cube is required and must include "kind" ("lattice" or "fibonacci")');
  }
  const wiring = { ...defaultWiringConfig, ...(raw.wiring ?? {}) };
  const color = { ...defaultColorConfig, ...(raw.color ?? {}) };
  const power = { ...defaultPowerConfig, ...(raw.power ?? {}) };
  const output: OutputConfig = { ...defaultOutputConfig, ...(raw.output ?? {}) };
  const fps = raw.fps ?? 30;
  const pattern = raw.pattern;
  if (!pattern || !pattern.name) {
    throw new Error('config.pattern.name is required (e.g. "classics/harmonic-blob.js")');
  }
  const patternsRoot = path.resolve(
    path.dirname(abs),
    raw.patternsRoot ?? path.join(path.dirname(abs), 'patterns'),
  );

  return { patternsRoot, cube, wiring, color, power, output, fps, pattern };
}
