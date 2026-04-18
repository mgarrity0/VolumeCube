// Small utility library passed to patterns as ctx.utils.
//
// Patterns get: clamp, smoothstep, mix (color), hsv, noise3d.
// Kept allocation-conscious — the hot path is O(N³) per frame.

import type { PatternUtils, RGB } from './patternApi';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(a: number, b: number, v: number): number {
  if (a === b) return v < a ? 0 : 1;
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// Parse "#rrggbb" or [r,g,b] (0..255) into a 3-tuple of 0..255.
function toRGB(c: string | number[]): RGB {
  if (typeof c === 'string') {
    const h = c.startsWith('#') ? c.slice(1) : c;
    if (h.length === 3) {
      const r = parseInt(h[0] + h[0], 16);
      const g = parseInt(h[1] + h[1], 16);
      const b = parseInt(h[2] + h[2], 16);
      return [r, g, b];
    }
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return [r, g, b];
  }
  return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
}

// Linear interpolation between two colors at t in [0,1]. Returns [r,g,b] 0..255.
export function mix(a: string | number[], b: string | number[], t: number): RGB {
  const [ar, ag, ab] = toRGB(a);
  const [br, bg, bb] = toRGB(b);
  const k = clamp(t, 0, 1);
  return [
    ar + (br - ar) * k,
    ag + (bg - ag) * k,
    ab + (bb - ab) * k,
  ];
}

// HSV → RGB. h,s,v in [0,1]. Output in 0..255.
export function hsv(h: number, s: number, v: number): RGB {
  h = ((h % 1) + 1) % 1;
  s = clamp(s, 0, 1);
  v = clamp(v, 0, 1);
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [r * 255, g * 255, b * 255];
}

// ---------- 3D value noise ----------
//
// Cheap, deterministic, good enough for plasma / fire / smoke patterns.
// Evaluated at up to ~8k voxels per frame — no big lib dependency.

function hash(x: number, y: number, z: number): number {
  let h = x * 374761393 + y * 668265263 + z * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  // Map to [-1, 1]
  return ((h & 0x7fffffff) / 0x3fffffff) - 1;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function noise3d(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);

  const n000 = hash(xi,     yi,     zi);
  const n100 = hash(xi + 1, yi,     zi);
  const n010 = hash(xi,     yi + 1, zi);
  const n110 = hash(xi + 1, yi + 1, zi);
  const n001 = hash(xi,     yi,     zi + 1);
  const n101 = hash(xi + 1, yi,     zi + 1);
  const n011 = hash(xi,     yi + 1, zi + 1);
  const n111 = hash(xi + 1, yi + 1, zi + 1);

  const x00 = lerp(n000, n100, u);
  const x10 = lerp(n010, n110, u);
  const x01 = lerp(n001, n101, u);
  const x11 = lerp(n011, n111, u);
  const y0 = lerp(x00, x10, v);
  const y1 = lerp(x01, x11, v);
  return lerp(y0, y1, w);
}

export const patternUtils: PatternUtils = {
  clamp,
  smoothstep,
  mix,
  hsv,
  noise3d,
};
