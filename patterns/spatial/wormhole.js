// Wormhole — flying down a living tunnel. The tube axis runs along +Z (depth):
// every voxel maps to (radius from the swaying axis, angle, depth). A wall sits at
// a fixed radius, and concentric bright RINGS scroll toward the viewer (z=0) along
// depth. The wall is dark in the center (the far throat), dark outside the tube, and
// blazes only on the ring crests. The tube mouth twists (angular shear that grows
// with depth) and sways gently off-centre so it reads as flying through an organic
// throat. Hue cycles down the tunnel depth + spins with the twist for an iridescent
// vortex. Pure per-voxel function API — no state, no allocations.

export const params = {
  speed:      { type: 'range', min: 0,    max: 3,   step: 0.01, default: 1,    label: 'Fly speed' },
  rings:      { type: 'range', min: 1,    max: 9,   step: 0.1,  default: 4.5,  label: 'Ring density' },
  twist:      { type: 'range', min: 0,    max: 4,   step: 0.01, default: 1.6,  label: 'Twist' },
  sway:       { type: 'range', min: 0,    max: 0.6, step: 0.01, default: 0.22, label: 'Sway' },
  radius:     { type: 'range', min: 0.25, max: 1.0, step: 0.01, default: 0.62, label: 'Tube radius' },
  wallThick:  { type: 'range', min: 0.1,  max: 0.9, step: 0.01, default: 0.42, label: 'Wall depth' },
  hueCycle:   { type: 'range', min: 0,    max: 3,   step: 0.01, default: 1.1,  label: 'Hue cycle' },
  color:      { type: 'color', default: '#19b6ff' },
};

const TAU = Math.PI * 2;

export default {
  name: 'Wormhole',

  render(ctx, xyz) {
    const { t, params, utils, audio } = ctx;
    const { clamp, smoothstep, hsv, mix, parseColor } = utils;
    const { cx, cy, w } = xyz;

    // --- Audio (all optional). Beat punches the rings; energy speeds the fly-through.
    const energy = audio ? clamp(audio.energy || 0, 0, 1) : 0;
    const beat   = audio && audio.beat ? 1 : 0;

    const sp = params.speed * (1 + 0.35 * energy);
    const tt = t * sp;

    // --- Depth along the tunnel axis. w is 0..1 across Z (front face z=0 = near the
    // viewer, the tube mouth). Guard Nz=1 (w can be constant) by folding a little
    // time in so the tunnel still pulses on a flat slab.
    const depth = w; // 0 = mouth (near), 1 = far throat

    // --- Living axis: the centre of the tube sways off-centre, and the sway grows
    // with depth so the far end of the throat leans more than the mouth (parallax).
    // Coprime sine rates keep the wander from ever repeating cleanly.
    const swayAmt = params.sway;
    const lean = 0.35 + 0.65 * depth; // far end leans more
    const axX = swayAmt * lean * (Math.sin(t * 0.31) + 0.5 * Math.sin(t * 0.73 + 1.7));
    const axY = swayAmt * lean * (Math.cos(t * 0.27) + 0.5 * Math.sin(t * 0.61 + 0.4));

    // Vector from the (swaying) tube axis to this voxel, in the X/Y plane.
    const px = cx - axX;
    const py = cy - axY;
    const rad = Math.hypot(px, py);        // radius from axis, ~0..1.4
    const ang = Math.atan2(py, px);        // -PI..PI around the tube

    // --- The tube WALL: a soft annulus centred on params.radius. Inside (toward the
    // axis) falls to black = the dark far throat; outside falls to black = dark room.
    // Crisp smoothstep edges so the wall floats in negative space under bloom.
    const R = params.radius;
    const half = params.wallThick * 0.5;
    // distance from the wall's centreline, normalised by the wall thickness.
    const dWall = Math.abs(rad - R) / Math.max(half, 1e-3);
    let wall = 1 - smoothstep(0.55, 1.0, dWall); // 1 on the wall, 0 off it
    if (wall <= 0.001) return [0, 0, 0];          // sculpt the empty tube + outside

    // --- Twist: shear the angle by depth so the throat spirals as it recedes. The
    // twist also slowly rotates over time so the whole vortex turns.
    const spiralAng = ang + params.twist * depth * TAU * 0.5 + tt * 0.6;

    // --- Concentric RINGS scrolling toward the viewer. Phase combines depth (rings
    // recede into +Z) with the spiral so the bands corkscrew rather than sit flat.
    // Subtracting time pulls the rings toward the mouth (z=0) = flying forward.
    const ringPhase =
      depth * params.rings
      - tt * 0.9
      + spiralAng / TAU * 0.25;            // slight helical skew of the bands

    let ring = 0.5 + 0.5 * Math.sin(ringPhase * TAU);
    // Sharpen into bright crests with dark gaps -> high dynamic range down the tube.
    ring = smoothstep(0.45, 0.98, ring);
    ring = ring * ring;                     // punchy cores, deep gaps

    // --- Depth shading: the far throat dims toward black for a real sense of looking
    // INTO distance; the mouth (near) is brightest. A travelling pulse adds life on
    // flat slabs (Nz=1) where depth alone barely changes.
    const recede = 1 - 0.75 * depth;        // near bright, far dark
    const pulse  = 0.55 + 0.45 * Math.sin((depth * 2.0 - tt * 0.5) * TAU + ang * 2);

    // Beat swell briefly flares every ring crest.
    const flare = 1 + beat * 0.6;

    let lum = wall * ring * recede * (0.6 + 0.4 * pulse) * flare;
    lum = clamp(lum, 0, 1);

    // A thin hot rim where the wall meets the dark interior reads as the lit edge of
    // the throat — adds a crisp inner contour without flooding the wall.
    const innerRim = (1 - smoothstep(0.0, 0.35, dWall)) * wall;
    lum = clamp(lum + innerRim * 0.18 * recede, 0, 1);

    if (lum <= 0.002) return [0, 0, 0];

    // --- Colour cycles DOWN the tunnel depth and spins with the twist, so each ring
    // is a different hue and the palette keeps travelling. Base hue comes from the
    // user colour so the default has a teal/electric-blue identity.
    const base = parseColor(params.color);
    const baseHue = rgbHue(base);
    const hue =
      (baseHue
        + depth * params.hueCycle
        + spiralAng / TAU * 0.15
        + tt * 0.03) % 1;

    // Saturated punchy colour; the very brightest crests bloom toward white for a hot
    // core under bloom. Tint slightly toward the user colour for cohesion.
    const sat = clamp(0.95 - 0.4 * (lum * lum), 0.35, 1);
    let col = hsv(hue, sat, lum);
    col = mix(col, base, 0.12 * (1 - lum)); // gentle palette cohesion in the mids

    return [
      clamp(col[0], 0, 255),
      clamp(col[1], 0, 255),
      clamp(col[2], 0, 255),
    ];
  },
};

// Approximate hue (0..1) of an [r,g,b] colour so the tunnel's palette is anchored to
// the user-chosen base colour.
function rgbHue(c) {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 1e-6) return 0.55; // grey -> default to a cool tunnel hue
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return h < 0 ? h + 1 : h;
}
