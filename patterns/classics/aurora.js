// Aurora — northern lights as vertical curtains of light drifting through the cube.
//
// The night sky is mostly DARK. A few luminous curtains (thin vertical sheets)
// hang in the volume; their lateral position meanders across the floor plane
// (x,z) driven by layered 3D noise, so each sheet ripples and flows horizontally
// AND wanders through depth — never a flat 2D plate. A second, faster vertical
// noise carves the bright striations that stream up each curtain. Brightness is a
// crisp smoothstep band around each sheet's center, squared for bright cores and
// deep black between curtains. Color climbs the classic aurora ramp by height +
// noise: green low -> teal/cyan mid -> magenta/violet at the crests, with the
// hottest sheet cores blown toward pale green-white for a bloom-friendly glow.
// Coprime drift rates keep the whole thing slow, organic and non-repeating.

export const params = {
  speed:    { type: 'range', min: 0,   max: 3,   step: 0.01, default: 1,    label: 'Drift speed' },
  curtains: { type: 'range', min: 1,   max: 6,   step: 0.1,  default: 3.0,  label: 'Curtain count' },
  ripple:   { type: 'range', min: 0,   max: 2,   step: 0.01, default: 1.0,  label: 'Ripple / warp' },
  sharp:    { type: 'range', min: 0.2, max: 3,   step: 0.01, default: 1.4,  label: 'Sheet sharpness' },
  streak:   { type: 'range', min: 0,   max: 1.5, step: 0.01, default: 0.85, label: 'Vertical streaks' },
  baseGlow: { type: 'range', min: 0,   max: 0.4, step: 0.01, default: 0.0,  label: 'Sky glow' },
  hueShift: { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.0,  label: 'Hue shift' },
};

// Aurora color ramp, bottom -> top, as HSV stops [h, s, v].
// green -> green-teal -> cyan -> violet -> magenta crest.
const RAMP = [
  [0.34, 1.00, 0.85],  // low: vivid green
  [0.45, 1.00, 0.95],  // teal
  [0.52, 0.95, 1.00],  // cyan
  [0.74, 0.95, 1.00],  // violet
  [0.86, 0.95, 1.00],  // magenta crest
];

// Mix two HSV stops, hue interpolating the short way around the wheel.
function mixHSV(a, b, t) {
  let dh = b[0] - a[0];
  if (dh > 0.5) dh -= 1;
  if (dh < -0.5) dh += 1;
  return [a[0] + dh * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Sample the ramp at p in [0,1].
function rampHSV(p) {
  const n = RAMP.length - 1;
  const f = Math.max(0, Math.min(1, p)) * n;
  const i = Math.min(n - 1, Math.floor(f));
  return mixHSV(RAMP[i], RAMP[i + 1], f - i);
}

export default {
  name: 'Aurora',

  render(ctx, xyz) {
    const { t, params, utils, audio } = ctx;
    const { clamp, smoothstep, noise3d, hsv } = utils;
    const { u, v, w, cx, cz } = xyz; // v: 0 bottom -> 1 top; cx,cz: -1..1 centered

    // Audio is optional — a beat gives the sky a gentle swell, energy adds drift.
    const energy = (audio && audio.energy) || 0;
    const beat   = (audio && audio.beat) ? 1 : 0;

    const drift = t * params.speed * (1 + 0.2 * energy);

    // --- Curtain coordinate ---------------------------------------------------
    // Each curtain is a vertical sheet. We build a smooth scalar "phase" field
    // across the floor plane (x,z) and through height; bright sheets live where
    // the phase passes through an integer band. The phase meanders with layered
    // noise so sheets ripple horizontally and snake through depth over time.
    const nf = 1.4;                       // base noise frequency
    const rip = params.ripple;

    // Low-frequency warp of the lateral coordinate. Coprime time rates +
    // a height term make taller parts of a curtain lead/lag (the classic
    // draping, folding look) instead of moving as a rigid wall.
    const warp =
        rip * 0.9 * noise3d(cx * nf + drift * 0.23, v * 1.1 - drift * 0.17, cz * nf + 4.0)
      + rip * 0.5 * noise3d(cx * nf * 2.1 - drift * 0.31, v * 2.0 + 7.0, cz * nf * 2.1 - drift * 0.13);

    // Depth wander: push each sheet's reference plane back and forth through z
    // so curtains travel toward/away from the viewer, not just side to side.
    const depthWander = rip * 0.6 * noise3d(cz * 0.9 - drift * 0.19, v * 0.7 + 2.0, 11.0);

    // The curtain phase: lateral position (cx) + depth (cz) folded together,
    // warped, and scrolled. `curtains` sets how many sheets span the volume.
    const phase =
      (cx * 0.55 + cz * 0.30 + depthWander) * params.curtains
      + warp
      + drift * 0.35;                     // whole field slides sideways

    // Distance to the nearest sheet center (phase near an integer + 0.5),
    // folded to a triangle wave in [-0.5, 0.5].
    const fr = phase - Math.floor(phase);     // 0..1 within a curtain cell
    const d = fr - 0.5;                        // -0.5..0.5, 0 == sheet center
    const dist = Math.abs(d);                  // 0 at core, 0.5 at the gap

    // --- Sheet intensity ------------------------------------------------------
    // Thin bright band around the sheet center; everything else falls to black.
    // `sharp` controls how thin/crisp the curtain reads.
    const halfWidth = clamp(0.30 / Math.max(0.2, params.sharp), 0.04, 0.45);
    let sheet = 1 - smoothstep(0.0, halfWidth, dist); // 1 at core -> 0 at edge
    sheet = sheet * sheet;                            // punchy core, dark falloff

    // --- Vertical streamers ---------------------------------------------------
    // Fast, tall, thin noise streaming UPWARD carves the bright vertical
    // striations that ripple along each curtain. Scrolls up faster than the
    // sheet drifts for that flickering, rising-light feel.
    let streak = 1;
    if (params.streak > 0) {
      const sn = noise3d(
        phase * 3.0 + 13.0,               // tie streaks to curtain identity
        v * 4.5 - drift * 1.3,            // tall + rising
        cz * 2.0 - drift * 0.4,
      );                                   // -1..1
      const sm = 0.5 + 0.5 * sn;
      // Map so only the upper band of streak noise lights -> gaps go dark,
      // giving discrete vertical rays rather than a smear.
      const lit = smoothstep(0.45, 0.85, sm);
      streak = (1 - params.streak) + params.streak * lit;
    }

    // --- Vertical envelope ----------------------------------------------------
    // Aurora is brightest in the lower-middle and feathers out at the very top
    // and the floor — keeps the sky above dark and the band luminous.
    const env = smoothstep(0.0, 0.18, v) * (1 - smoothstep(0.55, 1.0, v) * 0.75);

    // Combine. Beat adds a brief swell to the whole curtain band.
    let intensity = sheet * streak * env;
    intensity = clamp(intensity * (1 + 0.18 * beat), 0, 1);

    // Faint sky glow option (default 0 keeps space truly black for depth).
    const glow = params.baseGlow * env * (0.4 + 0.3 * (0.5 + 0.5 * Math.sin(t * 0.2 + cx * 2)));
    let value = clamp(intensity + glow, 0, 1);

    if (value <= 0.004) return [0, 0, 0]; // truly off — sculpt the dark sky

    // --- Color ----------------------------------------------------------------
    // Climb the aurora ramp by HEIGHT, nudged by a slow noise value so the
    // crest colors (violet/magenta) bloom unevenly across the curtains rather
    // than at one fixed height — organic, like real shimmering bands.
    const colorNoise = noise3d(cx * 0.8 + drift * 0.15, v * 0.6, cz * 0.8 - 3.0); // -1..1
    let rampPos = v * 0.85 + 0.12 * colorNoise + 0.06 * (0.5 - dist) * 2;
    rampPos = clamp(rampPos, 0, 1);

    let [h, sat, val] = rampHSV(rampPos);
    h = ((h + params.hueShift) % 1 + 1) % 1;

    // HDR value: squared intensity for bright sheet cores against deep black.
    const lum = value * value;

    // The very brightest sheet cores blow toward a pale green-white glow
    // (bloom-friendly incandescent core), like the most intense ribbons.
    const hot = smoothstep(0.6, 1.0, value);
    sat = clamp(sat * (1 - 0.55 * hot), 0.12, 1);
    val = clamp(val * (0.20 + 0.80 * lum) + 0.20 * hot * lum, 0, 1);

    return hsv(h, sat, val);
  },
};
