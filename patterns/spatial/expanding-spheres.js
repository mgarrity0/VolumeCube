// Expanding Spheres — concentric pulses radiate outward from the center,
// colored by hue. Each ring fades as it grows, and new rings spawn on a
// steady cadence so the cube has 2–3 rings in flight at once.

export const params = {
  period:    { type: 'range', min: 0.2, max: 5,  step: 0.01, default: 1.3 },
  thickness: { type: 'range', min: 0.03, max: 0.6, step: 0.01, default: 0.15 },
  ringCount: { type: 'int',   min: 1,   max: 6,  step: 1,    default: 3 },
  hueShift:  { type: 'range', min: 0,   max: 1,  step: 0.01, default: 0.2 },
  centerGlow:{ type: 'range', min: 0,   max: 1,  step: 0.01, default: 0.25 },
};

export default {
  name: 'Expanding Spheres',

  render(ctx, xyz) {
    const { t, params, utils } = ctx;
    const { cx, cy, cz } = xyz;
    const r = Math.hypot(cx, cy, cz);

    let accR = 0, accG = 0, accB = 0;

    // Radii in cube space span ~0..√3 (corners). We let rings expand out
    // to 1.8 before fading fully so they kiss the corners at peak.
    for (let i = 0; i < params.ringCount; i++) {
      const offset = i / params.ringCount;
      const phase = ((t / params.period) + offset) % 1; // 0..1
      const radius = phase * 1.8;
      const d = Math.abs(r - radius);
      const shell = utils.smoothstep(params.thickness, 0, d);
      if (shell <= 0) continue;
      const fade = 1 - phase; // fades as it grows
      const hue = (offset + params.hueShift * (t / params.period)) % 1;
      const [hr, hg, hb] = utils.hsv(hue, 0.8, shell * fade);
      accR += hr; accG += hg; accB += hb;
    }

    if (params.centerGlow > 0 && r < 0.5) {
      const g = params.centerGlow * (1 - r * 2);
      accR += 255 * g * 0.5;
      accG += 255 * g * 0.5;
      accB += 255 * g * 0.6;
    }

    return [Math.min(255, accR), Math.min(255, accG), Math.min(255, accB)];
  },
};
