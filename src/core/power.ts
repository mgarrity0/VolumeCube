// Power estimation + automatic brightness limiter (ABL) for WS2815.
//
// WS2815 full-white is ≈ 60 mA per LED at 12 V (20 mA per channel). We sum
// the post-brightness duty-cycled output (before gamma, since gamma is a
// perceptual curve not a power curve — the LED dies see PWM proportional
// to the linear duty value) and divide by 1000 for amps.
//
// Modes:
//   'off'      — no-op, still report for display
//   'warn'     — report; panel highlights red when over budget
//   'auto-dim' — compute scale = min(1, budgetAmps/amps); caller uses
//                that in the color pipeline to avoid browning the PSU.
//
// We compute on the brightness-scaled buffer (after step 2 of the pipeline)
// to match what the strip actually draws — gamma runs after in the
// simulator-only float path but doesn't affect actual current draw.

export type PowerMode = 'off' | 'warn' | 'auto-dim';

export type PowerConfig = {
  mode: PowerMode;
  budgetAmps: number;
  voltage: number; // 12 for WS2815
  mAPerChannel: number; // 20 mA per channel at full 255
};

export const defaultPowerConfig: PowerConfig = {
  mode: 'warn',
  budgetAmps: 30,
  voltage: 12,
  mAPerChannel: 20,
};

export type PowerReading = {
  amps: number;
  watts: number;
  scale: number;
  overBudget: boolean;
};

/**
 * Estimate amps drawn by the current frame.
 * `dutyBuf` is the per-channel 0..255 buffer after brightness scaling (so the
 * same buffer that'll hit the strip in hardware, minus the gamma curve).
 */
export function estimatePower(
  dutyBuf: Uint8ClampedArray,
  cfg: PowerConfig,
): PowerReading {
  let sum = 0;
  const n = dutyBuf.length;
  for (let i = 0; i < n; i++) sum += dutyBuf[i];
  // sum is total channel-intensity in 0..255 units
  const amps = (sum * cfg.mAPerChannel) / 255 / 1000;
  const watts = amps * cfg.voltage;

  let scale = 1;
  const overBudget = amps > cfg.budgetAmps && cfg.budgetAmps > 0;
  if (cfg.mode === 'auto-dim' && overBudget) {
    scale = cfg.budgetAmps / amps;
  }

  return { amps, watts, scale, overBudget };
}

// A tiny helper for displaying fractional amps/watts cleanly.
export function fmtAmps(a: number): string {
  if (a < 0.01) return '0.00 A';
  if (a < 10) return a.toFixed(2) + ' A';
  return a.toFixed(1) + ' A';
}
export function fmtWatts(w: number): string {
  if (w < 1) return w.toFixed(1) + ' W';
  return Math.round(w) + ' W';
}
