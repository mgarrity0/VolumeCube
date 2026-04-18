// Noise field — volumetric value noise with selectable octaves, drifting in time.

export const params = {
  scale:    { type: 'range', min: 0.5, max: 8,   step: 0.1,  default: 2.5 },
  speed:    { type: 'range', min: 0,   max: 3,   step: 0.01, default: 0.4 },
  octaves:  { type: 'int',   min: 1,   max: 4,              default: 2 },
  hueShift: { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.55 },
  contrast: { type: 'range', min: 0,   max: 3,   step: 0.01, default: 1.4 },
};

export default {
  name: 'Noise field',

  render(ctx, xyz) {
    const { t, params, utils } = ctx;
    const s = params.scale;
    const drift = t * params.speed;

    let sum = 0;
    let amp = 1;
    let norm = 0;
    let freq = 1;
    for (let o = 0; o < params.octaves; o++) {
      sum += amp * utils.noise3d(
        xyz.u * s * freq + drift,
        xyz.v * s * freq,
        xyz.w * s * freq - drift,
      );
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    let n = sum / norm;                    // -1..1
    n = utils.clamp(n * params.contrast, -1, 1);
    const k = 0.5 + 0.5 * n;               // 0..1

    const h = (params.hueShift + k * 0.5) % 1;
    return utils.hsv(h, 0.9, k);
  },
};
