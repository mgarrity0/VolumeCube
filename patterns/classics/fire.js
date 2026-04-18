// Fire — 3D procedural flame.
//
// Upward-scrolling fractional-brownian-motion noise makes the fuel field;
// a cooling gradient along Y cuts off the tops; a flickering base boost
// keeps the bottom lit. Temperature maps through a warm palette, with
// black below a cutoff so the flame reads as volumetric against the void
// instead of a fog.

export const params = {
  speed:      { type: 'range',  min: 0,   max: 4,   step: 0.01, default: 1.4 },
  scale:      { type: 'range',  min: 1,   max: 8,   step: 0.1,  default: 3.2 },
  cooling:    { type: 'range',  min: 0.2, max: 3,   step: 0.01, default: 1.4 },
  turbulence: { type: 'range',  min: 0,   max: 1.5, step: 0.01, default: 0.55 },
  basePush:   { type: 'range',  min: 0,   max: 1,   step: 0.01, default: 0.35 },
  flicker:    { type: 'range',  min: 0,   max: 1,   step: 0.01, default: 0.4 },
  cutoff:     { type: 'range',  min: 0,   max: 0.5, step: 0.01, default: 0.08 },
  palette:    { type: 'select', options: ['warm', 'blue', 'green', 'violet'], default: 'warm' },
};

// Palette hue + cool-end hue for the tip (desaturates to near-white at peak).
// Each entry is [baseHue, tipHueOffset].
const PALETTES = {
  warm:   [0.00, 0.13],   // red → yellow
  blue:   [0.58, -0.10],  // deep blue → cyan
  green:  [0.33, -0.08],  // green → yellow-green
  violet: [0.78, 0.05],   // magenta → pinkish-white
};

export default {
  name: 'Fire',

  render(ctx, xyz) {
    const { t, params, utils } = ctx;
    const { u, v, w } = xyz; // v is 0 at the bottom layer, 1 at the top
    const s = params.scale;
    const drift = t * params.speed;

    // Two-octave noise field drifting upward (subtracting from v sample).
    const n1 = utils.noise3d(u * s,     v * s - drift,       w * s);
    const n2 = utils.noise3d(u * s * 2, v * s * 2 - drift * 1.7, w * s * 2);
    const fuel = 0.5 + 0.5 * (n1 + n2 * params.turbulence) / (1 + params.turbulence);

    // Low-frequency flicker at the base so it breathes rather than pulses uniformly.
    const flickerNoise = utils.noise3d(u * 1.2, drift * 0.8, w * 1.2); // -1..1
    const base = params.basePush * (1 - v) * (1 - v) *
                 (1 + params.flicker * flickerNoise);

    // Cool with height. Above ≈1/cooling the flame runs out of fuel.
    let temp = fuel * Math.max(0, 1 - v * params.cooling) + base;
    temp = utils.clamp(temp, 0, 1);

    if (temp < params.cutoff) return [0, 0, 0];

    // S-curve contrast — body fills, tips thin.
    temp = temp * temp * (3 - 2 * temp);

    const [baseH, tipOffset] = PALETTES[params.palette] ?? PALETTES.warm;
    const h = baseH + tipOffset * temp;
    // Desaturate toward the tip so the core looks near-white.
    const sat = utils.clamp(1 - temp * 0.65, 0.1, 1);
    // Brightness tracks temperature but gets a bloom-friendly boost near peak.
    const val = utils.clamp(temp * 1.1, 0, 1);

    return utils.hsv(h, sat, val);
  },
};
