// Noise field — volumetric domain-warped FBM that flows THROUGH the cube.
// Ridged + warped value noise carves bright filaments out of darkness (empty
// space stays truly off for depth), drifts front-to-back, and journeys through
// hue over space + time with a complementary glow on the hottest cores.

export const params = {
  scale:    { type: 'range', min: 0.5, max: 8,   step: 0.1,  default: 2.2, label: 'Scale' },
  speed:    { type: 'range', min: 0,   max: 3,   step: 0.01, default: 0.5, label: 'Flow speed' },
  octaves:  { type: 'int',   min: 1,   max: 4,              default: 3,    label: 'Octaves' },
  warp:     { type: 'range', min: 0,   max: 1.5, step: 0.01, default: 0.75, label: 'Domain warp' },
  ridged:   { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.7, label: 'Ridge / filaments' },
  density:  { type: 'range', min: 0.1, max: 0.9, step: 0.01, default: 0.45, label: 'Fill density' },
  contrast: { type: 'range', min: 0.5, max: 4,   step: 0.01, default: 2.4, label: 'Contrast' },
  hueShift: { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.58, label: 'Base hue' },
  hueSpan:  { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.32, label: 'Hue spread' },
};

export default {
  name: 'Noise field',

  render(ctx, xyz) {
    const { t, params, utils, audio } = ctx;
    const { clamp, smoothstep, noise3d, hsv } = utils;

    const s = params.scale;
    const drift = t * params.speed;
    // Front-to-back travel: the field migrates along +Z so structures pass
    // through the volume toward/away from the viewer, not just rotate in plane.
    const flowZ = t * params.speed * 0.6;

    const u = xyz.u, v = xyz.v, w = xyz.w;

    // --- Domain warp: bend the sampling coordinates with low-freq noise so the
    //     field forms turbulent, organic flow instead of a static lattice. ---
    const wq = params.warp;
    let wx = 0, wy = 0, wz = 0;
    if (wq > 0) {
      const ws = s * 0.45;
      wx = noise3d(u * ws + 11.3, v * ws - drift * 0.5, w * ws + 4.1) * wq;
      wy = noise3d(u * ws - 7.7, v * ws + 2.9, w * ws + drift * 0.5 + 19.0) * wq;
      wz = noise3d(u * ws + 5.2 + drift * 0.4, v * ws + 8.8, w * ws - 3.3) * wq;
    }

    // --- Fractal sum (fBm). Optionally ridged to sharpen into glowing filaments. ---
    let sum = 0, amp = 1, norm = 0, freq = 1;
    const oct = params.octaves;
    const rid = params.ridged;
    for (let o = 0; o < oct; o++) {
      const sf = s * freq;
      let nv = noise3d(
        (u + wx) * sf + drift,
        (v + wy) * sf,
        (w + wz) * sf - drift + flowZ,
      ); // -1..1

      // Ridge transform: fold valleys up into crisp ridge lines, then blend
      // with the smooth signal by the `ridged` knob.
      const ridge = 1 - Math.abs(nv);        // 0..1, peaks where nv crosses 0
      const ridgedV = ridge * ridge * 2 - 1; // back to ~-1..1, sharpened
      const oc = nv * (1 - rid) + ridgedV * rid;

      sum += amp * oc;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    let n = norm > 0 ? sum / norm : 0;        // -1..1
    let field = 0.5 + 0.5 * n;                // 0..1

    // --- Carve darkness: threshold + contrast so only the hot ridges light up.
    //     `density` sets how much of the volume survives; below it = pure black,
    //     giving the cube real depth instead of mid-grey fog. ---
    const beat = audio && typeof audio.beat === 'boolean' ? audio.beat : false;
    const energy = audio ? (audio.energy || 0) : 0;
    const lift = energy * 0.12 + (beat ? 0.06 : 0);
    const lo = clamp((1 - params.density) - lift, 0, 1);
    const hi = clamp(lo + 0.42, lo + 0.01, 1);
    let core = smoothstep(lo, hi, field);     // 0..1 soft-carved mask

    // Boost dynamic range: bright cores, dark falloff, crisp edges.
    core = Math.pow(clamp(core, 0, 1), 1 / Math.max(0.1, 1 / params.contrast));
    core = clamp(core, 0, 1);
    if (core <= 0.001) return [0, 0, 0];      // truly off — preserve contrast

    // --- Color: hue journeys through the volume (depth via w) and over time at
    //     coprime rates for organic, non-repeating drift. Hottest cores tip
    //     toward a complementary accent so peaks pop. ---
    const flow = (n * 0.5 + 0.5);             // 0..1 along the field gradient
    const t1 = Math.sin(t * 0.13 + w * 3.1);
    const t2 = Math.sin(t * 0.071 + v * 2.0 + 1.7);
    const journey = (t1 * 0.5 + t2 * 0.3) * 0.5; // gentle wander
    let h = params.hueShift
          + flow * params.hueSpan
          + w * 0.18
          + journey * 0.25;

    // Complementary accent on the hottest voxels.
    const hot = smoothstep(0.65, 1.0, core);
    h += hot * 0.5;
    h = ((h % 1) + 1) % 1;

    // Saturation eases off slightly at the white-hot peaks so cores read as
    // incandescent rather than flat color.
    const sat = clamp(0.95 - hot * 0.45, 0.4, 1);
    const val = clamp(0.06 + core * (0.98 - 0.06), 0, 1);

    const rgb = hsv(h, sat, val);
    return [
      clamp(rgb[0], 0, 255),
      clamp(rgb[1], 0, 255),
      clamp(rgb[2], 0, 255),
    ];
  },
};
