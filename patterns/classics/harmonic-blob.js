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
// Audio hook (future): each mode's amplitude can be driven by an FFT
// band — l=2 = bass squash, l=3 = mid wobble, l=4 = high shimmer.
//
// 'shell' draws a glowing skin at the iso surface; 'filled' fills the
// interior with a center-bright gradient that fades to the surface.
//
// Color modes:
//   tint         — flat color, no animation
//   radius-hue   — hue tracks how stretched THIS direction is right now
//   velocity-hue — hue tracks the surface phase (atan2 of deform velocity
//                  vs deform amount), so colors rotate through the
//                  pulse cycle: outward swing → peak → inward → trough

export const params = {
  modes:      { type: 'int',    min: 1,    max: 8,   default: 3, label: 'Active modes' },
  baseRadius: { type: 'range',  min: 0.2,  max: 0.9, step: 0.01, default: 0.55 },
  amplitude:  { type: 'range',  min: 0.05, max: 0.5, step: 0.01, default: 0.2 },
  speed:      { type: 'range',  min: 0,    max: 3,   step: 0.01, default: 1 },
  thickness:  { type: 'range',  min: 0.04, max: 0.5, step: 0.01, default: 0.15 },
  fill:       { type: 'select', options: ['shell', 'filled'], default: 'shell' },
  colorMode:  { type: 'select', options: ['tint', 'radius-hue', 'velocity-hue'], default: 'tint' },
  tint:       { type: 'color',  default: '#ff6080' },
  hueDrift:   { type: 'range',  min: 0,    max: 1,   step: 0.005, default: 0.05, label: 'Hue drift' },
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
    const { t, params, utils } = ctx;
    const { cx, cy, cz } = xyz;

    const r = Math.sqrt(cx * cx + cy * cy + cz * cz);
    // Origin voxel is always inside the blob; pick an arbitrary up-pointing
    // normal so the modes evaluate without a divide-by-zero.
    let nx, ny, nz;
    if (r < 1e-6) { nx = 0; ny = 1; nz = 0; }
    else { nx = cx / r; ny = cy / r; nz = cz / r; }

    // Sum active modes — both R(t) and ∂R/∂t (used by velocity-hue).
    const M = Math.min(params.modes, MODES.length);
    let deform = 0;
    let velocity = 0;
    for (let i = 0; i < M; i++) {
      const m = MODES[i];
      const arg = t * params.speed * m.omega + PHASES[i];
      const y = m.fn(nx, ny, nz);
      deform   += y * Math.sin(arg);
      velocity += y * Math.cos(arg) * m.omega;
    }
    deform   *= params.amplitude;
    velocity *= params.amplitude * params.speed;

    const R = params.baseRadius + deform;

    // Shell or fill envelope.
    let intensity;
    if (params.fill === 'shell') {
      intensity = utils.smoothstep(params.thickness, 0, Math.abs(r - R));
    } else {
      // Smooth surface boundary × center-bright interior so the volume
      // reads as a body, not a flat disc.
      const surf = utils.smoothstep(R + params.thickness, R - params.thickness, r);
      const core = 1 - 0.45 * utils.clamp(r / Math.max(R, 0.05), 0, 1);
      intensity = surf * core;
    }
    if (intensity <= 0) return [0, 0, 0];

    // Color.
    let cr, cg, cb;
    if (params.colorMode === 'tint') {
      const c = utils.parseColor(params.tint);
      cr = c[0]; cg = c[1]; cb = c[2];
    } else if (params.colorMode === 'radius-hue') {
      // Map deformation [-amp, +amp] to hue [0, 1] (then drift over time).
      let h = (params.amplitude > 0 ? deform / (params.amplitude * 2) : 0) + 0.5 + t * params.hueDrift;
      h -= Math.floor(h);
      const c = utils.hsv(h, 0.9, 1);
      cr = c[0]; cg = c[1]; cb = c[2];
    } else {
      // Phase angle of the (deform, velocity) state vector — rotates
      // through every hue as the surface swings out → peak → in → trough.
      let h = Math.atan2(velocity, deform * 1.5) / (Math.PI * 2) + 0.5 + t * params.hueDrift;
      h -= Math.floor(h);
      const c = utils.hsv(h, 0.9, 1);
      cr = c[0]; cg = c[1]; cb = c[2];
    }

    return [cr * intensity, cg * intensity, cb * intensity];
  },
};
