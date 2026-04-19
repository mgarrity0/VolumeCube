import { describe, it, expect } from 'vitest';
import { estimatePower, defaultPowerConfig } from './power';

// Power math has to be trustworthy — if estimatePower returns a bogus amps
// value, ABL either under-dims (PSU browns out) or over-dims (dark cube).
// We test the boundary cases: empty frame, full-white frame, ABL on/off.

function fullWhiteDuty(count: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(count * 3);
  buf.fill(255);
  return buf;
}

describe('estimatePower', () => {
  it('reports zero draw for an all-black frame', () => {
    const duty = new Uint8ClampedArray(1000 * 3);
    const r = estimatePower(duty, defaultPowerConfig);
    expect(r.amps).toBe(0);
    expect(r.watts).toBe(0);
    expect(r.scale).toBe(1);
    expect(r.overBudget).toBe(false);
  });

  it('matches 60 mA/LED × 1000 LEDs = 60 A at full white', () => {
    const duty = fullWhiteDuty(1000);
    // Need a generous budget so ABL doesn't fire and we see the raw amps.
    const r = estimatePower(duty, { ...defaultPowerConfig, mode: 'off', budgetAmps: 1000 });
    expect(r.amps).toBeCloseTo(60, 3);
    expect(r.watts).toBeCloseTo(60 * 12, 2);
  });

  it('flags overBudget in warn mode without dimming', () => {
    const duty = fullWhiteDuty(1000);
    const r = estimatePower(duty, { ...defaultPowerConfig, mode: 'warn', budgetAmps: 30 });
    expect(r.overBudget).toBe(true);
    expect(r.scale).toBe(1);
  });

  it('returns scale = budget / amps in auto-dim mode when over budget', () => {
    const duty = fullWhiteDuty(1000);
    const r = estimatePower(duty, { ...defaultPowerConfig, mode: 'auto-dim', budgetAmps: 30 });
    expect(r.overBudget).toBe(true);
    expect(r.scale).toBeCloseTo(30 / 60, 5);
    // Final amps after applying scale should equal the budget.
    expect(r.amps * r.scale).toBeCloseTo(30, 5);
  });

  it('does not dim when under budget', () => {
    const duty = fullWhiteDuty(100); // 6 A at full white
    const r = estimatePower(duty, { ...defaultPowerConfig, mode: 'auto-dim', budgetAmps: 30 });
    expect(r.scale).toBe(1);
    expect(r.overBudget).toBe(false);
  });
});
