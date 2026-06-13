// Harmonic Blob — implicit sphere whose radius breathes per-direction
// via a sum of real spherical harmonics, each oscillating at its own
// frequency. The superposition of a few low-order modes produces
// organic, dance-like deformation that never quite repeats.
//
//   R(n̂, t) = baseRadius + amplitude · Σᵢ Yᵢ(n̂) · sin(ωᵢ·speed·t + φᵢ)
//
// Mode 1 squashes along Y (axial pinch). Mode 2 tilts. Mode 3 spins a
// 4-lobe equatorial bulge. Higher modes add finer wobble — keep them
// off for "alive but coherent", turn them on for chaotic.
//
// Color — DEFAULT is velocity-hue: the surface phase (atan2 of deform
// velocity vs deform amount) drives the hue, so the skin cycles through
// the whole wheel as it swings outward → peaks → pulls inward → troughs.
// Outward-swinging lobes glow hot, inward-pulling ones cool — the blob
// reads as a living, color-shifting body, not a flat tint.
//
// The surface is rendered with a soft bloom skin (bright crisp core at
// the iso surface, an exponential halo blooming inward + outward) so it
// glows the way bright voxels bleed through the cube in a dark room.
// 'filled' adds a luminous interior; 'shell' keeps it a hollow glowing
// membrane.
//
// Audio hook (optional): beats kick a brief radial swell + saturation
// punch, and low/high bands lean the hue warm/cool, so the blob breathes
// with the music when audio is present (silently ignored when it's not).
//
// Color modes:
//   velocity-hue — hue tracks the surface pulse phase (DEFAULT, show-off)
//   radius-hue   — hue tracks how stretched THIS direction is right now
//   tint         — flat color, no animation

export const params = {
  modes:      { type: 'int',    min: 1,    max: 8,   default: 4, label: 'Active modes' },
  baseRadius: { type: 'range',  min: 0.2,  max: 0.9, step: 0.01, default: 0.5 },
  amplitude:  { type: 'range',  min: 0.05, max: 0.5, step: 0.01, default: 0.34 },
  speed:      { type: 'range',  min: 0,    max: 3,   step: 0.01, default: 1 },
  thickness:  { type: 'range',  min: 0.04, max: 0.5, step: 0.01, default: 0.18, label: 'Skin thickness' },
  bloom:      { type: 'range',  min: 0,    max: 1,   step: 0.01, default: 0.5, label: 'Bloom / halo' },
  fill:       { type: 'select', options: ['shell', 'filled'], default: 'shell' },
  colorMode:  { type: 'select', options: ['velocity-hue', 'radius-hue', 'tint'], default: 'velocity-hue' },
  hueSpread:  { type: 'range',  min: 0,    max: 2,   step: 0.01, default: 0.85, label: 'Hue spread' },
  hueDrift:   { type: 'range',  min: 0,    max: 1,   step: 0.005, default: 0.04, label: 'Hue drift' },
  tint:       { type: 'color',  default: '#ff5090' },
  audioReact: { type: 'toggle', default: true, label: 'Audio reactive' },
};

// Real spherical harmonics evaluated directly on the unit vector (nx, ny, nz)
// where Y is up. Each is roughly L∞-normalized so a single `amplitude`
// scales them comparably. Frequencies are coprime-ish so the superposition
// doesn't lock into a short period.
const MODES = [
  // l=2, m=0  — axial squash along Y (prolate ↔ oblate)
  { fn: (nx, ny, nz) => 1.5 * ny * ny - 0.5,                                  omega: 0.70 },
  // l=2, m=±1 — diagonal tilt in the XY plane
  { fn: (nx, ny, nz) => 2.5 * ny * nx,                                        omega: 1.10 },
  // l=2, m=±2 — 4-lobe equatorial bulge (XZ plane)
  { fn: (nx, ny, nz) => 2.5 * (nx * nx - nz * nz),                            omega: 0.90 },
  // l=3, m=±1 — 6-lobe tilt
  { fn: (nx, ny, nz) => 1.7 * nx * (5 * ny * ny - 1),                         omega: 1.50 },
  // l=3, m=±3 — 6-lobe equatorial twist
  { fn: (nx, ny, nz) => 2.0 * nx * (nx * nx - 3 * nz * nz),                   omega: 1.70 },
  // l=4, m=0  — axial 3-band pinch + bulge
  { fn: (nx, ny, nz) => (35 * ny ** 4 - 30 * ny * ny + 3) / 8,                omega: 2.20 },
  // l=4, m=±4 — 8-lobe equatorial flower
  { fn: (nx, ny, nz) => 1.5 * (nx ** 4 - 6 * nx * nx * nz * nz + nz ** 4),    omega: 1.90 },
  // l=5, m=0  — fine axial ripple
  { fn: (nx, ny, nz) => ny * (63 * ny ** 4 - 70 * ny * ny + 15) / 8,          omega: 2.50 },
];

// Pre-baked phase offsets — same every run so the blob has a stable
// "personality" rather than rolling new motion on each pattern load.
const PHASES = [0.00, 1.70, 2.90, 0.50, 4.20, 1.10, 3.60, 5.00];

export default {
  name: 'Harmonic Blob',
  render(ctx, xyz) {
    const { t, params, utils, audio } = ctx;
    const { cx, cy, cz } = xyz;

    const r = Math.sqrt(cx * cx + cy * cy + cz * cz);
    // Origin voxel is always inside the blob; pick an arbitrary up-pointing
    // normal so the modes evaluate without a divide-by-zero.
    let nx, ny, nz;
    if (r < 1e-6) { nx = 0; ny = 1; nz = 0; }
    else { nx = cx / r; ny = cy / r; nz = cz / r; }

    // Optional audio drive — fully guarded so it's a no-op without audio.
    const a = (params.audioReact && audio) ? audio : null;
    const energy = a ? a.energy : 0;
    const beat   = a && a.beat ? 1 : 0;

    // Sum active modes — both R(t) and ∂R/∂t (used by velocity-hue).
    // A little extra speed on a beat gives the surface a quick "breath".
    const M = Math.min(params.modes | 0, MODES.length);
    const spd = params.speed * (1 + 0.25 * energy);
    let deform = 0;
    let velocity = 0;
    for (let i = 0; i < M; i++) {
      const m = MODES[i];
      const arg = t * spd * m.omega + PHASES[i];
      const y = m.fn(nx, ny, nz);
      deform   += y * Math.sin(arg);
      velocity += y * Math.cos(arg) * m.omega;
    }
    // Bolder by default: amplitude (×1.15) gives the blob a confident,
    // sculptural deformation rather than a timid wobble. Beats add a brief
    // radial swell that pushes the whole surface outward.
    const amp = params.amplitude * 1.15;
    deform   *= amp;
    velocity *= amp * (spd || 1);

    const baseR = params.baseRadius + 0.12 * amp * beat;
    const R = baseR + deform;

    // --- Surface / bloom envelope -------------------------------------
    // A crisp bright skin at the iso surface plus a soft exponential halo
    // that blooms inward and outward — this is the glow that reads through
    // the cube in a dark room. High dynamic range: hot core, dark falloff.
    const th = Math.max(params.thickness, 1e-3);
    const d = r - R;                          // signed distance to surface
    const ad = Math.abs(d);

    // Crisp core skin: full brightness right at the surface.
    const skin = utils.smoothstep(th, th * 0.25, ad);
    // Bloom halo: tight exponential falloff just beyond the skin so the
    // surface glows without flooding the volume — darkness stays dark.
    // Reaches a little further outward than inward so the body blooms into
    // the surrounding void. Falloff measured from the OUTER edge of the
    // skin (ad - th) so the halo decorates the shell rather than the core.
    const reach = th * (0.35 + 0.9 * params.bloom);
    const out = d > 0;                        // outside the surface?
    const haloReach = out ? reach : reach * 0.55;
    const edge = Math.max(ad - th, 0);        // distance past the skin
    const halo = params.bloom > 0 ? Math.exp(-(edge * edge) / (haloReach * haloReach + 1e-6)) : 0;

    // Halo contributes only OUTSIDE the crisp skin band, as a soft add — so
    // the shell stays a sharp hero edge with a gentle glow leaking past it.
    const bloomAdd = 0.5 * params.bloom * halo * (1 - skin);

    let intensity;
    if (params.fill === 'filled') {
      // Luminous interior: bright at the surface, glowing core, dark void
      // outside. Center stays lit so the volume reads as a solid body.
      const inside = utils.smoothstep(R + th, R - th, r);   // 1 inside → 0 outside
      const coreGlow = 1 - 0.55 * utils.clamp(r / Math.max(R, 0.05), 0, 1);
      intensity = Math.max(skin, inside * coreGlow * 0.8) + bloomAdd;
    } else {
      // Hollow glowing membrane: crisp skin + soft outer bloom only.
      intensity = skin + bloomAdd;
    }
    // Beat sparkle on the skin itself.
    intensity *= 1 + 0.35 * beat * skin;
    intensity = utils.clamp(intensity, 0, 1.25);
    if (intensity <= 0.004) return [0, 0, 0];

    // --- Color --------------------------------------------------------
    let h, sat = 0.92, val = 1;
    const drift = t * params.hueDrift;

    if (params.colorMode === 'tint') {
      const c = utils.parseColor(params.tint);
      // Even the flat tint gets value contrast from the bloom envelope.
      const v = utils.clamp(intensity, 0, 1.25);
      return [c[0] * v, c[1] * v, c[2] * v];
    } else if (params.colorMode === 'radius-hue') {
      // Map deformation [-amp, +amp] to a hue band spread by hueSpread.
      const norm = amp > 0 ? deform / (amp * 2) : 0;        // ~[-0.5, 0.5]
      h = 0.58 + norm * params.hueSpread + drift;           // teal → magenta sweep
    } else {
      // velocity-hue (DEFAULT): phase angle of the (deform, velocity) state
      // vector — rotates through every hue as the surface swings out → peak
      // → in → trough. hueSpread widens the journey across the wheel.
      const phase = Math.atan2(velocity, deform * 1.5) / (Math.PI * 2); // ~[-0.5,0.5]
      h = 0.55 + phase * params.hueSpread + drift;
      // Outward-swinging surface runs hotter & more saturated than inward.
      const swing = utils.clamp(velocity / (amp * 1.5 + 1e-6), -1, 1);
      sat = utils.clamp(0.78 + 0.22 * Math.abs(swing), 0, 1);
      val = utils.clamp(0.82 + 0.18 * (0.5 + 0.5 * swing), 0, 1);
    }

    // Audio leans the hue: low end warm, high end cool — and beats punch saturation.
    if (a) {
      h += 0.10 * ((a.low || 0) - (a.high || 0));
      sat = utils.clamp(sat + 0.25 * beat, 0, 1);
    }
    h -= Math.floor(h);

    const c = utils.hsv(h, sat, val);
    // Bloom halo desaturates toward white at the very brightest core for a
    // hot, blown-out highlight; the falloff carries the saturated hue.
    const heat = utils.clamp((intensity - 0.85) / 0.4, 0, 1);
    const cr = c[0] + (255 - c[0]) * heat * 0.6;
    const cg = c[1] + (255 - c[1]) * heat * 0.6;
    const cb = c[2] + (255 - c[2]) * heat * 0.6;

    const v = utils.clamp(intensity, 0, 1.25);
    return [cr * v, cg * v, cb * v];
  },
};
