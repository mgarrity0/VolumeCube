// Plasma — classic 3-axis sine interference, with a radial/linear/sphere mode.

export const params = {
  speed:  { type: 'range', min: 0,   max: 5, step: 0.01, default: 1 },
  scale:  { type: 'range', min: 0.1, max: 6, step: 0.01, default: 3 },
  color1: { type: 'color', default: '#ff2266' },
  color2: { type: 'color', default: '#22aaff' },
  mode:   { type: 'select', options: ['radial', 'linear', 'sphere'], default: 'radial' },
};

export default {
  name: 'Plasma',

  render(ctx, xyz) {
    const { t, params, utils } = ctx;
    const { cx, cy, cz, u, v, w } = xyz;
    const s = params.scale;
    const sp = params.speed;

    let k;
    if (params.mode === 'sphere') {
      const r = Math.sqrt(cx * cx + cy * cy + cz * cz);
      k = 0.5 + 0.5 * Math.sin(r * s * 2 - t * sp * 2);
    } else if (params.mode === 'linear') {
      k = 0.5 + 0.5 * Math.sin((u + v + w) * s - t * sp * 1.5);
    } else {
      const a = Math.sin(u * s + t * sp);
      const b = Math.sin(v * s + t * sp * 1.3);
      const c = Math.sin(w * s + t * sp * 0.7);
      k = (a + b + c + 3) / 6;
    }

    return utils.mix(params.color1, params.color2, k);
  },
};
