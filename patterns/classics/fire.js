// Fire — 3D procedural volumetric flame.
//
// A roaring column of fire that lives inside the cube. Upward-scrolling
// fractional-brownian-motion noise drives the fuel field; a radial column
// mask gathers the flame toward a central core so it reads as a body of
// fire rather than a fog. Temperature cools with height and toward the
// edges, so the base burns white-hot, the mid-body glows orange, the tips
// thin to deep red, and the very top goes dark and smoky. A multi-rate
// flicker (coprime sines + noise) keeps the base breathing organically,
// and sparse hot embers detach and float up through the cooled upper air.
// Black below a cutoff keeps the flame volumetric against the void.

export const params = {
  speed:      { type: 'range',  min: 0,   max: 4,   step: 0.01, default: 1.6 },
  scale:      { type: 'range',  min: 1,   max: 8,   step: 0.1,  default: 3.0 },
  cooling:    { type: 'range',  min: 0.2, max: 3,   step: 0.01, default: 1.25 },
  turbulence: { type: 'range',  min: 0,   max: 1.5, step: 0.01, default: 0.7 },
  column:     { type: 'range',  min: 0,   max: 1.5, step: 0.01, default: 0.7,  label: 'Column focus' },
  basePush:   { type: 'range',  min: 0,   max: 1,   step: 0.01, default: 0.45 },
  flicker:    { type: 'range',  min: 0,   max: 1,   step: 0.01, default: 0.5 },
  embers:     { type: 'range',  min: 0,   max: 1,   step: 0.01, default: 0.55 },
  cutoff:     { type: 'range',  min: 0,   max: 0.5, step: 0.01, default: 0.09 },
  palette:    { type: 'select', options: ['warm', 'blue', 'green', 'violet'], default: 'warm' },
};

// Each palette is a 3-stop heat ramp from coolest tip -> mid body -> hot core.
// Stops are HSV [h, s, v]; the renderer mixes between them by temperature and
// blows the very hottest toward white for a bloom-friendly core.
const PALETTES = {
  warm:   [[0.015, 1.00, 0.55],  [0.055, 1.00, 0.95],  [0.13, 0.55, 1.00]],  // ember red -> orange -> gold-white
  blue:   [[0.66, 1.00, 0.55],   [0.58, 1.00, 0.95],   [0.50, 0.45, 1.00]],  // indigo -> blue -> cyan-white
  green:  [[0.38, 1.00, 0.50],   [0.33, 1.00, 0.92],   [0.22, 0.50, 1.00]],  // deep green -> green -> chartreuse
  violet: [[0.80, 1.00, 0.55],   [0.85, 0.95, 0.95],   [0.93, 0.45, 1.00]],  // violet -> magenta -> pink-white
};

// Mix two HSV stops in HSV space (hue interpolates the short way).
function mixHSV(a, b, t) {
  let dh = b[0] - a[0];
  if (dh > 0.5) dh -= 1;
  if (dh < -0.5) dh += 1;
  return [a[0] + dh * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export default {
  name: 'Fire',

  render(ctx, xyz) {
    const { t, params, utils } = ctx;
    const { u, v, w, cx, cz } = xyz; // v: 0 bottom -> 1 top; cx,cz: -1..1 centered
    const clamp = utils.clamp;
    const s = params.scale;
    const drift = t * params.speed;

    // --- Radial column mask: fire gathers toward the vertical center axis ---
    // Distance from the central (x,z) axis, 0 at the core, ~1 at the corners.
    const r = Math.min(1, Math.sqrt(cx * cx + cz * cz) * 0.72);
    // The column widens slightly at the base and pinches as it rises.
    const widen = 1.0 - 0.35 * v;
    const columnMask = 1 - utils.smoothstep(0.0, 1.0, r / Math.max(0.05, widen));
    // How tightly to gather. At column=0 it's a full volume; higher = tighter.
    const focus = 1 - params.column + params.column * columnMask;

    // --- Fuel: two octaves of upward-drifting noise (FBM) ---
    const n1 = utils.noise3d(u * s,       v * s - drift,         w * s);
    const n2 = utils.noise3d(u * s * 2.0, v * s * 2.0 - drift * 1.7, w * s * 2.0);
    const n3 = utils.noise3d(u * s * 4.0, v * s * 4.0 - drift * 2.6, w * s * 4.0);
    const tb = params.turbulence;
    const fbm = (n1 + n2 * tb + n3 * tb * 0.5) / (1 + tb + tb * 0.5);
    let fuel = 0.5 + 0.5 * fbm;
    fuel *= focus; // confine the burn to the column

    // --- Multi-rate base flicker (coprime sines + low-freq noise) ---
    const flickN = utils.noise3d(u * 1.3 + 4.0, drift * 0.7, w * 1.3 - 2.0); // -1..1
    const lic = 0.5 * Math.sin(t * 7.0 + u * 5.0)
              + 0.3 * Math.sin(t * 11.0 + w * 4.0)
              + 0.2 * Math.sin(t * 17.0); // coprime-ish rates, organic licking
    const flick = 1 + params.flicker * (0.6 * flickN + 0.4 * lic);
    // Hot base that decays upward; strongest at the very bottom layer.
    const baseFalloff = (1 - v) * (1 - v) * (1 - v);
    const base = params.basePush * baseFalloff * columnMask * clamp(flick, 0.2, 2.0);

    // --- Cool with height (run out of fuel toward the top) ---
    let temp = fuel * Math.max(0, 1 - v * params.cooling) + base;
    temp = clamp(temp, 0, 1);

    // --- Embers: sparse hot specks that detach and rise into the cool top ---
    // A high-frequency noise field scrolling upward faster than the flame,
    // thresholded so only rare peaks survive -> discrete glowing motes.
    let ember = 0;
    if (params.embers > 0) {
      const ev = v * 6.0 - drift * 2.2;
      const e = utils.noise3d(u * 7.0 + 13.0, ev, w * 7.0 + 7.0); // -1..1
      const eMask = utils.smoothstep(0.74, 0.92, e * 0.5 + 0.5);
      // More embers where the column is, fading in mid-to-upper region.
      const eRegion = utils.smoothstep(0.15, 0.55, v) * (0.4 + 0.6 * columnMask);
      const eTwinkle = 0.6 + 0.4 * Math.sin(t * 23.0 + e * 12.0);
      ember = eMask * eRegion * eTwinkle * params.embers;
    }
    // Embers add their own heat (read as bright hot specks).
    temp = clamp(temp + ember * 0.85, 0, 1);

    if (temp < params.cutoff) return [0, 0, 0];

    // --- S-curve contrast — body fills, tips thin, crisp edges ---
    const tc = temp * temp * (3 - 2 * temp);

    // --- Map temperature through the 3-stop heat ramp ---
    const ramp = PALETTES[params.palette] ?? PALETTES.warm;
    let hsv;
    if (tc < 0.5) {
      hsv = mixHSV(ramp[0], ramp[1], utils.smoothstep(0, 0.5, tc));
    } else {
      hsv = mixHSV(ramp[1], ramp[2], utils.smoothstep(0.5, 1.0, tc));
    }
    let [h, sat, val] = hsv;

    // Blow the hottest cores toward white for bloom; embers punch bright too.
    const whiteHot = utils.smoothstep(0.78, 1.0, tc);
    sat = clamp(sat * (1 - 0.7 * whiteHot), 0.05, 1);
    val = clamp(val * (0.92 + 0.18 * tc) + 0.25 * ember, 0, 1);

    return utils.hsv(h, sat, val);
  },
};
