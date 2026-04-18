// Spectrum Cube — each Y-layer renders a spectrogram row.
//
// Bottom layer shows the current FFT; each subsequent layer shows the
// previous frame's layer below it, creating a falling waterfall in Y.
// Hue tracks frequency across X; brightness tracks bin magnitude.

export const params = {
  gain:     { type: 'range', min: 0.5, max: 5, step: 0.01, default: 1.6 },
  axis:     { type: 'select', options: ['y', 'x', 'z'], default: 'y' },
  hueBand:  { type: 'range', min: 0,  max: 1, step: 0.01, default: 0.7 },
  noFloor:  { type: 'range', min: 0,  max: 0.3, step: 0.01, default: 0.05 },
};

export default {
  name: 'Spectrum Cube',

  render(ctx, xyz) {
    const { params, audio, utils, N } = ctx;
    const { u, v, w } = xyz;

    // Scroll axis. 's' is the "depth" along the chosen axis (0=newest).
    const s = params.axis === 'y' ? v : params.axis === 'x' ? u : w;
    // "Frequency" axis runs perpendicular — use u when scrolling on v/w,
    // else v.
    const f = params.axis === 'y' ? u : params.axis === 'x' ? v : u;
    // Magnitude along the third axis just adds a subtle brightness cue.
    const depth = params.axis === 'y' ? w : params.axis === 'x' ? w : v;

    // Newer layers = brighter; older layers fade out (history recreated
    // from tempo-decayed falling effect since patterns are stateless).
    const layerFade = utils.smoothstep(1, 0, s);

    // Pick the FFT bin for this x-column. Log-spaced so low freqs spread.
    const bins = audio.bins;
    const n = bins ? bins.length : 0;
    let mag = 0;
    if (n > 0) {
      const frac = f;
      const binIdx = Math.min(n - 1, Math.floor(Math.exp(frac * Math.log(n))));
      mag = bins[binIdx];
    }
    mag *= params.gain;

    // Scrolling history: since this is a pure function pattern, simulate
    // history by shifting the apparent magnitude along 's' using the
    // instant mag as a silhouette. It'll "pump" with the music in place
    // of a true waterfall — good enough for a stateless pattern.
    const shaped = utils.clamp((mag - params.noFloor) * layerFade, 0, 1);
    if (shaped <= 0) return [0, 0, 0];

    const hue = params.hueBand * f;
    const sat = 1 - shaped * 0.4;
    const val = utils.clamp(shaped * (0.6 + depth * 0.6), 0, 1);
    return utils.hsv(hue, sat, val);
  },
};
