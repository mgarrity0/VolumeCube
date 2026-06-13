// VU Bars — three volumetric audio columns driven by low/mid/high bands.
//
// The XZ floor is split into three slabs along X (low | mid | high). Each
// slab fills upward to a height set by its band's envelope-followed energy.
// Each bar is colored by a height GRADIENT (cool hot base -> blazing tip),
// has a bright crisp top edge, a cylindrical core glow, and a floating
// PEAK-HOLD cap that springs to the loudest recent level and slowly sags.
// Bands react distinctly: lows pulse/thicken with the beat, mids shimmer,
// highs sparkle and flicker fast. Reads great through bloom in a dark room.

export const params = {
  gain:     { type: 'range', min: 0.5, max: 5,   step: 0.01, default: 2.0, label: 'Gain' },
  attack:   { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.55, label: 'Attack' },
  decay:    { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.88, label: 'Decay' },
  peakHold: { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.92, label: 'Peak Sag' },
  gap:      { type: 'range', min: 0,   max: 0.3, step: 0.01, default: 0.06, label: 'Bar Gap' },
  hueLow:   { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.0,  label: 'Low Hue' },
  hueMid:   { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.33, label: 'Mid Hue' },
  hueHi:    { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.58, label: 'High Hue' },
  hueSweep: { type: 'range', min: 0,   max: 0.6, step: 0.01, default: 0.28, label: 'Tip Sweep' },
  glow:     { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.4,  label: 'Floor Glow' },
};

// ----- Per-band state (module-level, advanced once per frame) -------------
let envL = 0, envM = 0, envH = 0;   // envelope-followed levels 0..1
let pkL = 0,  pkM = 0,  pkH = 0;    // peak-hold cap heights 0..1
let beatFlash = 0;                   // decays after each beat (low-band kick)
let lastFrame = -1;
let tSec = 0;

function advance(ctx) {
  const { audio, params, utils, frame, dt } = ctx;
  if (frame === lastFrame) return;
  lastFrame = frame;
  tSec = ctx.t;

  const a = params.attack;
  const d = params.decay;
  const g = params.gain;

  const follow = (env, target) =>
    target > env ? env + (target - env) * a : env * d;

  const tL = utils.clamp(audio.low * g, 0, 1);
  const tM = utils.clamp(audio.mid * g, 0, 1);
  const tH = utils.clamp(audio.high * g, 0, 1);

  envL = follow(envL, tL);
  envM = follow(envM, tM);
  envH = follow(envH, tH);

  // Peak-hold caps: snap up instantly, sag slowly toward the live level.
  const sag = params.peakHold;
  pkL = envL > pkL ? envL : Math.max(envL, pkL * sag);
  pkM = envM > pkM ? envM : Math.max(envM, pkM * sag);
  pkH = envH > pkH ? envH : Math.max(envH, pkH * sag);

  // Beat flash feeds the low band a percussive kick.
  const decayRate = utils.clamp((dt || 0.016) * 4, 0, 1);
  if (audio.beat) beatFlash = 1;
  else beatFlash = Math.max(0, beatFlash - decayRate);
}

// Small idle floor so the piece is alive even with near-silent input.
const FLOOR = 0.085;

export default {
  name: 'VU Bars',

  render(ctx, xyz) {
    advance(ctx);
    const { params, utils, Nx } = ctx;
    const { u, v, w, cx, cz } = xyz;

    // --- Pick the band by X slab, with a dark gap between bars ----------
    const slab = u * 3;            // 0..3
    const band = slab < 1 ? 0 : slab < 2 ? 1 : 2;
    const inSlab = slab - band;    // 0..1 position across this bar's slab
    // Dark gutters between bars (and at the outer edges) for crisp shapes.
    const half = params.gap * 0.5;
    const gx = utils.smoothstep(0, half + 0.02, inSlab) *
               utils.smoothstep(1, 1 - half - 0.02, inSlab);
    if (gx <= 0.001) return [0, 0, 0];

    // --- This band's live level, peak cap, hue, and personality --------
    let level, peak, baseHue, shimmer;
    if (band === 0) {
      // LOWS: thick, punchy, swells with the beat.
      level = utils.clamp(envL + beatFlash * 0.22, 0, 1);
      peak = Math.max(pkL, level);
      baseHue = params.hueLow;
      shimmer = 1;                                   // steady
    } else if (band === 1) {
      // MIDS: gentle organic shimmer.
      level = envM;
      peak = pkM;
      baseHue = params.hueMid;
      shimmer = 0.85 + 0.15 * Math.sin(tSec * 7.3 + u * 9);
    } else {
      // HIGHS: fast flicker / sparkle.
      level = envH;
      peak = pkH;
      baseHue = params.hueHi;
      shimmer = 0.7 + 0.3 * utils.noise3d(u * 6, v * 6, tSec * 6);
    }
    level = Math.max(level, FLOOR);
    peak = Math.max(peak, level);

    // Idle breathing so a flat bar never looks frozen.
    level += 0.03 * Math.max(0, Math.sin(tSec * 1.7 + band * 2.1));

    const out = [0, 0, 0];
    const lo = ctx.utils.clamp; // alias

    // --- Floating peak-hold cap (a bright band ~1 voxel thick) ----------
    const Ny = ctx.Ny;
    const capT = 1 / Math.max(Ny, 4);              // cap thickness in v-space
    const capLit = lo(1 - Math.abs(v - peak) / capT, 0, 1);
    if (capLit > 0 && peak > FLOOR + 0.02) {
      // Cap glows hot white-pink, the classic "you peaked here" marker.
      const capHue = baseHue + params.hueSweep * 0.8;
      const capCol = utils.hsv(capHue, 0.45, 1);
      const k = capLit * capLit * gx;
      out[0] += capCol[0] * k;
      out[1] += capCol[1] * k;
      out[2] += capCol[2] * k;
    }

    // --- The bar body fills from the floor up to `level` ----------------
    if (v <= level + 0.02) {
      // Crisp soft top edge.
      const top = utils.smoothstep(level + 0.02, level - 0.12, v);
      // Cylindrical core: brightest down the bar's centerline (X and Z).
      const radial = 1 - Math.min(1, Math.hypot(inSlab - 0.5, cz) * 1.35);
      const core = 0.45 + 0.55 * Math.max(0, radial);

      // Height gradient: hot base hue climbs toward the swept tip hue.
      const h = v / Math.max(level, 1e-3);          // 0 floor .. 1 tip
      const hue = baseHue + params.hueSweep * (h * h);
      // Tips desaturate toward white-hot; bases stay deeply saturated.
      const sat = 1 - 0.45 * h * h;
      const val = lo(top * core * shimmer, 0, 1);
      // Push contrast: dark falloff, bright cores.
      const bright = val * val * (3 - 2 * val);

      const col = utils.hsv(hue, sat, bright);
      out[0] += col[0] * gx;
      out[1] += col[1] * gx;
      out[2] += col[2] * gx;
    }

    // --- Ground glow: bottom row washes with the band's energy ----------
    if (v < 0.12) {
      const floorK = utils.smoothstep(0.12, 0, v) * params.glow * level;
      const fcol = utils.hsv(baseHue, 0.9, 1);
      const k = floorK * gx;
      out[0] += fcol[0] * k;
      out[1] += fcol[1] * k;
      out[2] += fcol[2] * k;
    }

    // --- Soft volumetric haze: a dim band-colored bloom hugging the bar,
    //     fading up to the peak cap. Adds depth without flat grey fill. ---
    const ceil = Math.max(peak, level);
    if (v < ceil + capT) {
      const vert = utils.smoothstep(ceil + capT, 0, v);   // brightest low
      const haze = vert * vert * 0.16 * gx * (0.5 + 0.5 * level);
      if (haze > 0.002) {
        const hcol = utils.hsv(baseHue + params.hueSweep * 0.4, 0.85, 1);
        out[0] += hcol[0] * haze;
        out[1] += hcol[1] * haze;
        out[2] += hcol[2] * haze;
      }
    }

    // Guard: keep finite + roughly in range (pipeline clamps too).
    out[0] = lo(out[0] || 0, 0, 255);
    out[1] = lo(out[1] || 0, 0, 255);
    out[2] = lo(out[2] || 0, 0, 255);
    return out;
  },
};
