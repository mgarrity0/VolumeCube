// Plasma Globe — branching electric tendrils blasting from a blazing core to
// the cube faces.
//
// Each tendril is a polyline from the cube center to a random point on the
// nearest cube face, with interior points jittered for the jagged
// "lightning-in-a-jar" look. The path RE-JITTERS every frame (organic,
// never-repeating crackle) and the whole arc flickers via summed coprime
// sines, so the discharge never sits still.
//
// Tendrils are drawn in two additive layers: a WIDE colored glow halo and a
// NARROW hot-white core, giving the searing white filament wrapped in a
// saturated electric-blue/violet aura you get in a real plasma globe. Each
// arc owns a hue along an electric journey (cyan → blue → violet → magenta)
// so the globe reads as evolving color, not one flat tint.
//
// A blazing white core breathes at the center and FLASHES on every audio
// beat, kicking out a burst of fresh discharges with it. New arcs spawn at
// `flickerRate` Hz (replacing the oldest) plus beat bursts, so the globe is
// always alive with shifting, snapping arcs and deep dark space between them.

export const params = {
  tendrils:    { type: 'int',   min: 2,   max: 14,   default: 7 },
  flickerRate: { type: 'range', min: 0.1, max: 8,    step: 0.05, default: 3.2, label: 'Discharge rate (Hz)' },
  segments:    { type: 'int',   min: 4,   max: 20,   default: 11 },
  jitter:      { type: 'range', min: 0,   max: 0.5,  step: 0.01, default: 0.16, label: 'Path jitter (frac)' },
  fadeTime:    { type: 'range', min: 0.2, max: 3,    step: 0.05, default: 0.7, label: 'Tendril life (sec)' },
  coreSize:    { type: 'range', min: 0,   max: 3,    step: 0.05, default: 1.05, label: 'Core radius (voxels)' },
  glow:        { type: 'range', min: 0,   max: 1,    step: 0.01, default: 0.6, label: 'Colored glow' },
  audioReact:  { type: 'toggle', default: true,      label: 'Beat-reactive' },
  coreColor:   { type: 'color', default: '#ffffff' },
  arcColor:    { type: 'color', default: '#5aa0ff' },
};

// Additive trilinear splat with a per-voxel max-clamp.
function splat(out, Nx, Ny, Nz, x, y, z, r, g, b) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  for (let dx = 0; dx <= 1; dx++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dz = 0; dz <= 1; dz++) {
        const xx = x0 + dx, yy = y0 + dy, zz = z0 + dz;
        if (xx < 0 || xx >= Nx || yy < 0 || yy >= Ny || zz < 0 || zz >= Nz) continue;
        const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
        if (w <= 0) continue;
        const idx = (xx * Ny + yy) * Nz + zz;
        out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r * w);
        out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g * w);
        out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b * w);
      }
    }
  }
}

// Build a fresh tendril: a uniformly-random direction off the core that walks
// out to the nearest cube face, with jittered interior knots. We store the
// CLEAN backbone (knots) and re-jitter per frame in render() for live crackle.
function spawnTendril(Nx, Ny, Nz, params, seed) {
  const cx = (Nx - 1) / 2, cy = (Ny - 1) / 2, cz = (Nz - 1) / 2;
  // Uniform direction on the unit sphere.
  const theta = Math.acos(2 * Math.random() - 1);
  const phi = Math.random() * Math.PI * 2;
  const dx = Math.sin(theta) * Math.cos(phi);
  const dy = Math.cos(theta);
  const dz = Math.sin(theta) * Math.sin(phi);

  // Smallest ray param t hitting one of the six bounding planes.
  const halfX = Math.max(0.5, cx), halfY = Math.max(0.5, cy), halfZ = Math.max(0.5, cz);
  const tx = halfX / Math.max(1e-3, Math.abs(dx));
  const ty = halfY / Math.max(1e-3, Math.abs(dy));
  const tz = halfZ / Math.max(1e-3, Math.abs(dz));
  const tMax = Math.min(tx, ty, tz);

  const ex = cx + dx * tMax;
  const ey = cy + dy * tMax;
  const ez = cz + dz * tMax;

  const segs = Math.max(2, params.segments | 0);
  const knots = [[cx, cy, cz]];
  // Interior knots get a stable random offset direction; the magnitude is
  // animated per-frame so the arc writhes around its backbone.
  for (let i = 1; i < segs; i++) {
    const u = i / segs;
    const bx = cx + (ex - cx) * u;
    const by = cy + (ey - cy) * u;
    const bz = cz + (ez - cz) * u;
    knots.push([
      bx, by, bz,
      Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5,
    ]);
  }
  knots.push([ex, ey, ez]);

  return {
    knots,
    age: 0,
    life: params.fadeTime * (0.6 + Math.random() * 0.7),
    seed,                         // phase offset for flicker
    hue: Math.random(),          // 0..1 position along the electric hue journey
    rate: 9 + Math.random() * 14, // writhe speed (Hz-ish)
  };
}

export default class PlasmaGlobe {
  static name = 'Plasma Globe';

  setup() {
    this.tendrils = [];
    this.spawnAcc = 0;
    this.seedCtr = 0;
    this.prevBeat = false;
  }

  _spawn(Nx, Ny, Nz, params) {
    return spawnTendril(Nx, Ny, Nz, params, (this.seedCtr++) * 1.7);
  }

  update(ctx) {
    const { dt, Nx, Ny, Nz, params, audio } = ctx;
    const beat = params.audioReact && audio && audio.beat;

    // Keep the population topped up to the requested count.
    while (this.tendrils.length < params.tendrils) {
      this.tendrils.push(this._spawn(Nx, Ny, Nz, params));
    }

    // Steady discharge stream — retire the oldest, fire a fresh one.
    this.spawnAcc += params.flickerRate * dt;
    let guard = 0;
    while (this.spawnAcc >= 1 && guard++ < 64) {
      if (this.tendrils.length >= params.tendrils) {
        let oldestI = 0, oldestAge = -1;
        for (let i = 0; i < this.tendrils.length; i++) {
          if (this.tendrils[i].age > oldestAge) { oldestAge = this.tendrils[i].age; oldestI = i; }
        }
        this.tendrils.splice(oldestI, 1);
      }
      this.tendrils.push(this._spawn(Nx, Ny, Nz, params));
      this.spawnAcc -= 1;
    }

    // Beat burst: snap a couple of arcs to brand-new paths on the downbeat.
    if (beat && !this.prevBeat) {
      const bursts = Math.min(3, this.tendrils.length);
      for (let b = 0; b < bursts; b++) {
        // Reuse the youngest slot so the burst arcs flash in fresh.
        let pick = Math.floor(Math.random() * this.tendrils.length);
        this.tendrils[pick] = this._spawn(Nx, Ny, Nz, params);
      }
    }
    this.prevBeat = !!beat;

    // Age + cull.
    for (let i = this.tendrils.length - 1; i >= 0; i--) {
      this.tendrils[i].age += dt;
      if (this.tendrils[i].age >= this.tendrils[i].life) this.tendrils.splice(i, 1);
    }
  }

  render(ctx, out) {
    const { t, Nx, Ny, Nz, params, utils, audio } = ctx;
    out.fill(0);

    const cx = (Nx - 1) / 2, cy = (Ny - 1) / 2, cz = (Nz - 1) / 2;
    const [coreR, coreG, coreB] = utils.parseColor(params.coreColor);
    const [aR, aG, aB] = utils.parseColor(params.arcColor);
    const glow = utils.clamp(params.glow, 0, 1);
    const energy = (params.audioReact && audio) ? audio.energy : 0;

    // Length scale so jitter reads consistently on non-cubic rigs.
    const scale = Math.max(1, Math.cbrt(Nx * Ny * Nz));

    // ---- Blazing core: breathes on coprime sines, flares with audio. ----
    const cr = params.coreSize;
    if (cr > 0) {
      // Organic breathing (sum of coprime-rate sines), plus an energy flare.
      const breath = 0.78
        + 0.14 * Math.sin(t * 2.3)
        + 0.08 * Math.sin(t * 3.7 + 1.0);
      const flare = 1 + 0.9 * energy;
      const reach = cr * 1.7;
      const ix0 = Math.max(0, Math.floor(cx - reach - 1));
      const ix1 = Math.min(Nx - 1, Math.ceil(cx + reach + 1));
      const iy0 = Math.max(0, Math.floor(cy - reach - 1));
      const iy1 = Math.min(Ny - 1, Math.ceil(cy + reach + 1));
      const iz0 = Math.max(0, Math.floor(cz - reach - 1));
      const iz1 = Math.min(Nz - 1, Math.ceil(cz + reach + 1));
      for (let x = ix0; x <= ix1; x++) {
        for (let y = iy0; y <= iy1; y++) {
          for (let z = iz0; z <= iz1; z++) {
            const dx = x - cx, dy = y - cy, dz = z - cz;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            // Hot white center, soft colored aura on the outer falloff.
            const kCore = utils.smoothstep(cr * 1.7, 0, d) * breath * flare;
            if (kCore <= 0) continue;
            const aura = utils.smoothstep(cr * 1.7, cr * 0.55, d); // 1 at edge → 0 at center
            // Inner: white. Outer: tint toward the arc color.
            const r = coreR * kCore;
            const g = coreG * kCore;
            const b = coreB * kCore;
            const tintK = aura * 0.55;
            const idx = (x * Ny + y) * Nz + z;
            out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r * (1 - tintK) + aR * kCore * tintK);
            out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g * (1 - tintK) + aG * kCore * tintK);
            out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b * (1 - tintK) + aB * kCore * tintK);
          }
        }
      }
    }

    // ---- Tendrils: two additive layers — colored halo + hot-white core. ----
    for (const tend of this.tendrils) {
      const ageT = tend.age / tend.life;
      // Fast rise (8%) then a power-curve decay so each arc snaps then fades.
      let env = ageT < 0.08
        ? ageT / 0.08
        : Math.pow(Math.max(0, 1 - (ageT - 0.08) / 0.92), 1.4);

      // Live flicker — summed coprime sines (per-arc phase) + a quick strobe.
      const ph = tend.seed;
      const flick = 0.78
        + 0.14 * Math.sin(t * 17.0 + ph)
        + 0.10 * Math.sin(t * 27.0 + ph * 2.3);
      const intensity = env * Math.max(0.45, flick) * (1 + 0.6 * energy);
      if (intensity <= 0.01) continue;

      // Per-arc hue journey through the electric band: cyan→blue→violet→magenta.
      // 0.5 (cyan) .. ~0.83 (magenta), with a slow global drift for evolution.
      const huePos = (tend.hue + t * 0.02) % 1;
      const hue = 0.5 + 0.33 * (0.5 + 0.5 * Math.sin(huePos * Math.PI * 2));
      const [hR, hG, hB] = utils.hsv(hue, 0.85, 1);
      // Blend the user arc color with the journey hue so the picker still steers it.
      const cR = aR * 0.45 + hR * 0.55;
      const cG = aG * 0.45 + hG * 0.55;
      const cB = aB * 0.45 + hB * 0.55;

      // Animate the knot offsets so the path writhes every frame.
      const knots = tend.knots;
      const amp = params.jitter * scale;
      const wr = t * tend.rate;
      // Resolve live point positions.
      const pts = this._pts || (this._pts = []);
      pts.length = knots.length;
      for (let i = 0; i < knots.length; i++) {
        const k = knots[i];
        if (k.length === 3) {
          pts[i] = k; // clean endpoints (center & face)
        } else {
          // Per-frame writhe: knot wanders on its random axis, modulated by
          // taper (interior knots move more than near-endpoint ones).
          const u = i / (knots.length - 1);
          const taper = Math.sin(u * Math.PI); // 0 at ends, 1 mid
          const wob = Math.sin(wr + i * 1.9) * amp * taper;
          pts[i] = [
            k[0] + k[3] * wob,
            k[1] + k[4] * wob,
            k[2] + k[5] * wob,
          ];
        }
      }

      // Draw the polyline. Tip is hotter than the root for a discharging look.
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i], p1 = pts[i + 1];
        const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const n = Math.max(2, Math.ceil(len * 1.8));
        const segU0 = i / (pts.length - 1);
        for (let s = 0; s <= n; s++) {
          const u = s / n;
          const x = p0[0] + dx * u, y = p0[1] + dy * u, z = p0[2] + dz * u;
          // Brighter toward the tip (the face end), where the discharge lands.
          const along = segU0 + (u / (pts.length - 1));
          const tipBoost = 0.8 + 0.5 * along;
          const I = intensity * tipBoost;

          // Layer 1: wide colored glow halo (saturated, soft) — spread to the
          // 6 axis neighbors so the aura genuinely fills the bloom radius.
          if (glow > 0) {
            const gI = I * glow * 0.85;
            const r = cR * gI, g = cG * gI, b = cB * gI;
            // Center of the halo (bright).
            splat(out, Nx, Ny, Nz, x, y, z, r, g, b);
            // Axis-neighbor falloff (dimmer) — cheap volumetric thickness.
            const h = gI * 0.5;
            splat(out, Nx, Ny, Nz, x + 1, y, z, cR * h, cG * h, cB * h);
            splat(out, Nx, Ny, Nz, x - 1, y, z, cR * h, cG * h, cB * h);
            splat(out, Nx, Ny, Nz, x, y + 1, z, cR * h, cG * h, cB * h);
            splat(out, Nx, Ny, Nz, x, y - 1, z, cR * h, cG * h, cB * h);
            splat(out, Nx, Ny, Nz, x, y, z + 1, cR * h, cG * h, cB * h);
            splat(out, Nx, Ny, Nz, x, y, z - 1, cR * h, cG * h, cB * h);
          }

          // Layer 2: hot-white filament core (searing, narrow, full intensity).
          const w = Math.min(255, I * 300);
          // Push toward white but keep a kiss of the arc hue so it isn't sterile.
          splat(out, Nx, Ny, Nz, x, y, z,
            Math.min(255, w),
            Math.min(255, w),
            Math.min(255, w * 0.92 + cB * I * 0.3));
        }
      }
    }
  }
}
