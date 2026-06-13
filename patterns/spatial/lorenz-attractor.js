// Lorenz Attractor — a chaotic 3D trajectory traced as a glowing rainbow ribbon
// with a blazing white-hot comet head, drawn live inside the LED volume.
//
// Integrates the canonical Lorenz system with a fixed ODE step per emitted
// sample (so the `trailLen`-sample ribbon always covers a fixed slice of ODE
// time — enough to sweep both lobes); `speed` sets how many samples advance per
// frame, with a fractional accumulator for buttery, frame-rate-stable motion.
// The last `trailLen` samples are kept as a flat array; each is splatted into
// the voxel grid with:
//   - intensity falling off by age (bright fresh tip, dark old tail),
//   - a rainbow hue cycling along the trail AND drifting over time,
//   - a soft additive glow radius so the ribbon blooms in a dark room, and
//   - the freshest samples burning toward white to read as a hot comet head.
//
// The butterfly is auto-fit to the volume: we track the running bounds of the
// live trail and rescale so both wings fill the cube no matter the rig size.
//
// ODE space spans roughly x∈[-22,22], y∈[-28,28], z∈[0,50]. We map:
//   x  → cube X
//   z  → cube Y (so the "up" axis of the butterfly faces up)
//   y  → cube Z (depth) — the wings sweep front-to-back through the volume.

export const params = {
  speed:    { type: 'range', min: 0.1, max: 5,    step: 0.05,  default: 1.0 },
  sigma:    { type: 'range', min: 5,   max: 20,   step: 0.1,   default: 10 },
  rho:      { type: 'range', min: 14,  max: 60,   step: 0.1,   default: 28 },
  beta:     { type: 'range', min: 1,   max: 5,    step: 0.05,  default: 2.667 },
  trailLen: { type: 'int',   min: 50,  max: 2000,              default: 700 },
  glow:     { type: 'range', min: 0.4, max: 2.5,  step: 0.05,  default: 1.15, label: 'Glow radius (voxels)' },
  fill:     { type: 'range', min: 0.5, max: 1.2,  step: 0.01,  default: 0.92, label: 'Volume fill' },
  headGlow: { type: 'range', min: 0,   max: 1,    step: 0.01,  default: 0.85, label: 'Comet head heat' },
  hueCycle: { type: 'range', min: 0,   max: 5,    step: 0.05,  default: 1.3,  label: 'Hue cycle (rev/trail)' },
  hueDrift: { type: 'range', min: -1,  max: 1,    step: 0.005, default: 0.07, label: 'Hue drift (rev/sec)' },
};

// Additive soft splat: deposits a Gaussian-ish blob of radius `rad` (in voxels)
// centered at the continuous coord (x,y,z). Brighter at the core, fading out so
// the ribbon glows through bloom rather than aliasing into hard dots.
function splat(out, Nx, Ny, Nz, x, y, z, r, g, b, rad) {
  const ri = Math.max(1, Math.ceil(rad));
  const x0 = Math.round(x), y0 = Math.round(y), z0 = Math.round(z);
  const inv = 1 / (rad * rad);
  for (let dx = -ri; dx <= ri; dx++) {
    const xx = x0 + dx;
    if (xx < 0 || xx >= Nx) continue;
    const ex = xx - x;
    for (let dy = -ri; dy <= ri; dy++) {
      const yy = y0 + dy;
      if (yy < 0 || yy >= Ny) continue;
      const ey = yy - y;
      for (let dz = -ri; dz <= ri; dz++) {
        const zz = z0 + dz;
        if (zz < 0 || zz >= Nz) continue;
        const ez = zz - z;
        const d2 = ex * ex + ey * ey + ez * ez;
        // Smooth falloff: 1 at center → 0 at ~rad. Squared for a punchy core.
        let w = 1 - d2 * inv;
        if (w <= 0) continue;
        w *= w;
        const idx = (xx * Ny + yy) * Nz + zz;
        const o = idx * 3;
        const cr = out[o] + r * w;
        const cg = out[o + 1] + g * w;
        const cb = out[o + 2] + b * w;
        out[o] = cr > 255 ? 255 : cr;
        out[o + 1] = cg > 255 ? 255 : cg;
        out[o + 2] = cb > 255 ? 255 : cb;
      }
    }
  }
}

export default class LorenzAttractor {
  static name = 'Lorenz Attractor';

  setup() {
    // Off-axis seed so the integrator escapes the unstable origin.
    this.x = 0.01; this.y = 0; this.z = 0;
    this.trail = []; // flat [x, y, z, x, y, z, ...] for cache locality
    // Auto-fit envelope of the live trajectory, for framing the butterfly.
    // Seeded to the classic Lorenz extents (rho=28) so frame 1 already fits;
    // the envelope then refines toward the actual orbit and holds it.
    this.bMinX = -19; this.bMaxX = 19;
    this.bMinY = 1;   this.bMaxY = 47;   // ODE z (drives cube Y / up)
    this.bMinZ = -25; this.bMaxZ = 25;   // ODE y (drives cube Z / depth)
  }

  update(ctx) {
    const { dt, params } = ctx;

    // Each emitted trail sample advances a fixed, healthy ODE step so that the
    // `trailLen`-sample ribbon always covers a fixed slice of ODE time (~8
    // units) — enough to sweep BOTH lobes and fill the volume. `speed` sets how
    // many samples we emit per frame; integrate with a finer substep per sample
    // (RK-ish midpoint via two half Euler steps) to stay smooth and stable.
    const STEP = 0.012;                 // ODE time per emitted trail sample
    const dts = Math.min(dt, 0.05);     // guard a stalled/huge frame
    // Samples this frame, with a fractional accumulator for frame-rate-stable,
    // non-chunky motion. ~26 samples/sec per unit speed → a lively orbit.
    this._acc = (this._acc || 0) + dts * params.speed * (1 / STEP) * 0.45;
    let nSamp = Math.floor(this._acc);
    this._acc -= nSamp;
    if (nSamp < 1) nSamp = 1;           // always crawl forward a little
    if (nSamp > 400) nSamp = 400;       // cap catch-up after a long stall

    let { x, y, z } = this;
    const { sigma, rho, beta } = params;
    const trail = this.trail;

    // Two half-steps per sample = better stability than one Euler leap.
    const hh = STEP * 0.5;
    for (let i = 0; i < nSamp; i++) {
      for (let s = 0; s < 2; s++) {
        const dx = sigma * (y - x);
        const dy = x * (rho - z) - y;
        const dz = x * y - beta * z;
        x += dx * hh; y += dy * hh; z += dz * hh;
      }
      trail.push(x, y, z);
    }
    this.x = x; this.y = y; this.z = z;

    const max = params.trailLen * 3;
    if (trail.length > max) trail.splice(0, trail.length - max);

    // Bounds of the ENTIRE live trail (the whole visible ribbon).
    let mnX = Infinity, mxX = -Infinity;
    let mnY = Infinity, mxY = -Infinity; // ODE z → cube Y
    let mnZ = Infinity, mxZ = -Infinity; // ODE y → cube Z
    for (let j = 0; j < trail.length; j += 3) {
      const tx = trail[j], ty = trail[j + 1], tz = trail[j + 2];
      if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) continue;
      if (tx < mnX) mnX = tx; if (tx > mxX) mxX = tx;
      if (tz < mnY) mnY = tz; if (tz > mxY) mxY = tz;
      if (ty < mnZ) mnZ = ty; if (ty > mxZ) mxZ = ty;
    }

    // Auto-fit envelope: a short trail only covers an arc of the attractor at
    // any instant, so we keep a persistent envelope that EXPANDS instantly to
    // contain any sample and CONTRACTS only very slowly. Over a few seconds it
    // converges on the full butterfly extent and then holds it steady.
    if (Number.isFinite(mnX)) {
      const grow = 1;       // snap outward immediately
      const shrink = 0.0025; // relax inward glacially
      this.bMinX += (mnX - this.bMinX) * (mnX < this.bMinX ? grow : shrink);
      this.bMaxX += (mxX - this.bMaxX) * (mxX > this.bMaxX ? grow : shrink);
      this.bMinY += (mnY - this.bMinY) * (mnY < this.bMinY ? grow : shrink);
      this.bMaxY += (mxY - this.bMaxY) * (mxY > this.bMaxY ? grow : shrink);
      this.bMinZ += (mnZ - this.bMinZ) * (mnZ < this.bMinZ ? grow : shrink);
      this.bMaxZ += (mxZ - this.bMaxZ) * (mxZ > this.bMaxZ ? grow : shrink);
    }
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, t, params, utils, audio } = ctx;
    out.fill(0);
    const trail = this.trail;
    const total = (trail.length / 3) | 0;
    if (total === 0) return;

    // --- Auto-fit transform: map smoothed ODE bounds → centered cube span. ---
    const fill = params.fill;
    const spanX = Math.max(1e-3, this.bMaxX - this.bMinX);
    const spanY = Math.max(1e-3, this.bMaxY - this.bMinY);
    const spanZ = Math.max(1e-3, this.bMaxZ - this.bMinZ);
    const midX = (this.bMinX + this.bMaxX) * 0.5;
    const midY = (this.bMinY + this.bMaxY) * 0.5;
    const midZ = (this.bMinZ + this.bMaxZ) * 0.5;

    // Per-axis half-extent in voxels (degenerate axis → pin to center plane).
    const halfX = Nx > 1 ? (Nx - 1) * 0.5 : 0;
    const halfY = Ny > 1 ? (Ny - 1) * 0.5 : 0;
    const halfZ = Nz > 1 ? (Nz - 1) * 0.5 : 0;
    const cxV = (Nx - 1) * 0.5;
    const cyV = (Ny - 1) * 0.5;
    const czV = (Nz - 1) * 0.5;

    // Map an ODE component to centered voxel space, filling the axis.
    const sX = (halfX * 2 * fill) / spanX;
    const sY = (halfY * 2 * fill) / spanY;
    const sZ = (halfZ * 2 * fill) / spanZ;

    // Glow radius shrinks for thin rigs so a 10x10x3 doesn't smear to a blob.
    const thin = Math.min(Nx, Ny, Nz);
    const rad = Math.max(0.6, Math.min(params.glow, thin * 0.45));

    // Audio gives the whole ribbon a subtle breathing brightness + beat flash.
    const a = audio || { energy: 0, beat: false };
    const energy = utils.clamp(a.energy || 0, 0, 1);
    const beatPulse = a.beat ? 0.35 : 0;
    const masterGain = 0.85 + energy * 0.35 + beatPulse;

    const invTotal = 1 / total;
    const headHeat = params.headGlow;

    for (let i = 0; i < total; i++) {
      const ox = trail[i * 3 + 0];
      const oy = trail[i * 3 + 1];
      const oz = trail[i * 3 + 2];
      if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)) continue;

      // ODE → voxel (auto-fit). x→X, z→Y(up), y→Z(depth).
      const vx = cxV + (ox - midX) * sX;
      const vy = cyV + (oz - midY) * sY;
      const vz = czV + (oy - midZ) * sZ;

      // Age 0 = newest tip, 1 = oldest tail.
      const age = (total - 1 - i) * invTotal;
      const fade = 1 - age;
      // Keep the whole rainbow ribbon readable (a healthy floor so the body
      // glows), but bias brightness toward the fresh end so the head leads.
      const intensity = (0.22 + 0.78 * Math.pow(fade, 1.3)) * masterGain;

      // Rainbow journey: cycles along trail length and drifts over time, with
      // a gentle organic wobble so the color never marches in lockstep.
      let hue = i * invTotal * params.hueCycle
        + t * params.hueDrift
        + 0.04 * Math.sin(i * 0.06 + t * 0.7);
      hue = hue - Math.floor(hue);

      let r, g, b;
      // The freshest ~12% of the trail is the comet head: pump saturation down
      // and value up so it burns toward white-hot and blooms past the ribbon.
      const headT = utils.smoothstep(0.88, 1.0, fade); // 0 along body → 1 at tip
      const heat = headT * headHeat;
      const sat = 0.95 - 0.85 * heat;
      const val = 1.0;
      const c = utils.hsv(hue, sat, val);
      // Extra additive white core at the very tip for a hot, glowing nucleus.
      const white = 255 * heat * heat;
      r = c[0] * intensity + white * intensity;
      g = c[1] * intensity + white * intensity;
      b = c[2] * intensity + white * intensity;

      // Head gets a fatter glow so it reads as a luminous bead leading the line.
      const splatRad = rad * (1 + 0.6 * heat);

      splat(out, Nx, Ny, Nz, vx, vy, vz, r, g, b, splatRad);
    }
  }
}
