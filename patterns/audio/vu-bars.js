// VU Bars — three vertical columns lit by low/mid/high audio energy.
//
// Divides the XZ floor into three horizontal bands (by u/X). Each band
// rises to a height proportional to its audio band, colored by hue.

export const params = {
  gain:    { type: 'range', min: 0.5, max: 5,  step: 0.01, default: 2.2 },
  attack:  { type: 'range', min: 0,   max: 1,  step: 0.01, default: 0.4 },
  decay:   { type: 'range', min: 0,   max: 1,  step: 0.01, default: 0.85 },
  hueLow:  { type: 'range', min: 0,   max: 1,  step: 0.01, default: 0 },
  hueMid:  { type: 'range', min: 0,   max: 1,  step: 0.01, default: 0.33 },
  hueHi:   { type: 'range', min: 0,   max: 1,  step: 0.01, default: 0.6 },
};

// Envelope-followed levels so bars don't strobe with every FFT frame.
let envL = 0, envM = 0, envH = 0;
let lastFrame = -1;

export default {
  name: 'VU Bars',

  render(ctx, xyz) {
    const { audio, params, utils, frame } = ctx;
    if (frame !== lastFrame) {
      lastFrame = frame;
      const a = params.attack;
      const d = params.decay;
      const followed = (env, target) =>
        target > env ? env + (target - env) * a : env * d;
      envL = followed(envL, utils.clamp(audio.low * params.gain, 0, 1));
      envM = followed(envM, utils.clamp(audio.mid * params.gain, 0, 1));
      envH = followed(envH, utils.clamp(audio.high * params.gain, 0, 1));
    }

    const { u, v, w } = xyz;
    // Band selection by u (X axis). Use z (w) to double each band to two
    // rows so it reads as proper bars rather than a single LED column.
    const band = u < 0.34 ? 0 : u < 0.67 ? 1 : 2;
    const level = band === 0 ? envL : band === 1 ? envM : envH;
    const hue = band === 0 ? params.hueLow : band === 1 ? params.hueMid : params.hueHi;

    if (v > level) return [0, 0, 0];

    // Soft top edge.
    const edge = utils.smoothstep(level, level - 0.08, v);
    // Inner shadow so bars have a subtle cylindrical look.
    const depth = 1 - Math.abs(w - 0.5) * 0.8;
    const brightness = utils.clamp(edge * depth, 0, 1);
    return utils.hsv(hue, 0.9, brightness);
  },
};
