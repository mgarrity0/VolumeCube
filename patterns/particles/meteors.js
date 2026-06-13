// Meteors — incandescent shooting stars that streak through the volume.
// Each meteor is a blazing white-hot head trailing a long, color-graded tail
// that cools from white -> hot hue -> deep ember as it fades. Meteors enter
// from random faces, curve under a little gravity + perpendicular drift, and
// occasionally a rare "fireball" rips through twice as bright and twice as
// long. Spawns are staggered with organic cadence; beats kick a fresh swarm.
//
// CLASS API (stateful particle system). Sub-voxel trilinear deposit gives the
// heads/tails a soft volumetric bloom. Everything scales with Nx/Ny/Nz and is
// guarded for thin slabs (Nz=1..3).

export const params = {
  count:     { type: 'int',   min: 1,  max: 40,  step: 1,    default: 10, label: 'Meteors' },
  speed:     { type: 'range', min: 2,  max: 30,  step: 0.1,  default: 13, label: 'Speed' },
  trailLen:  { type: 'range', min: 2,  max: 18,  step: 0.1,  default: 9,  label: 'Trail Length' },
  gravity:   { type: 'range', min: 0,  max: 6,   step: 0.05, default: 1.6, label: 'Gravity' },
  hueShift:  { type: 'range', min: 0,  max: 1,   step: 0.01, default: 0.06, label: 'Hue Drift' },
  palette:   { type: 'range', min: 0,  max: 1,   step: 0.01, default: 0.0, label: 'Palette' },
  audioKick: { type: 'toggle', default: true,  label: 'Beat Bursts' },
};

// Fractional random in [a,b)
function rand(a, b) { return a + Math.random() * (b - a); }

function spawnMeteor(Nx, Ny, Nz, t, paletteBase) {
  // Pick an entry face; velocity points into the volume. Bias toward
  // horizontal/diagonal entries so streaks sweep across the long axes.
  const r = Math.random();
  const rx = rand(0, Nx - 1), ry = rand(0, Ny - 1), rz = rand(0, Nz - 1);
  let px, py, pz, dx, dy, dz;
  if (r < 0.30)      { px = -1;   py = ry; pz = rz; dx =  1; dy = -0.15; dz = rand(-0.3, 0.3); }
  else if (r < 0.60) { px = Nx;   py = ry; pz = rz; dx = -1; dy = -0.15; dz = rand(-0.3, 0.3); }
  else if (r < 0.78) { px = rx; py = Ny;   pz = rz; dx = rand(-0.4, 0.4); dy = -1; dz = rand(-0.4, 0.4); }
  else if (r < 0.92) { px = rx; py = ry; pz = -1;   dx = rand(-0.3, 0.3); dy = -0.15; dz =  1; }
  else               { px = rx; py = ry; pz = Nz;   dx = rand(-0.3, 0.3); dy = -0.15; dz = -1; }

  // Perpendicular drift so streaks aren't perfectly axis-aligned.
  dx += rand(-0.25, 0.25);
  dy += rand(-0.25, 0.25);
  dz += rand(-0.25, 0.25);
  const len = Math.hypot(dx, dy, dz) || 1;

  // Rare bright "fireball": ~12% chance, brighter + longer + slower-fading.
  const fireball = Math.random() < 0.12;

  // Hue clustered around the palette base with a little spread, so the whole
  // shower reads as a coherent meteor storm rather than confetti.
  const hue = (paletteBase + rand(-0.10, 0.10) + 1) % 1;

  return {
    x: px, y: py, z: pz,
    vx: dx / len, vy: dy / len, vz: dz / len,
    hue,
    fire: fireball,
    bright: fireball ? rand(1.7, 2.2) : rand(0.85, 1.25),
    speedMul: fireball ? rand(0.75, 0.95) : rand(0.85, 1.2),
    lenMul: fireball ? rand(1.4, 1.8) : rand(0.8, 1.15),
    // Per-meteor flicker so heads twinkle instead of sitting at a flat value.
    flickPhase: rand(0, Math.PI * 2),
    flickRate: rand(7, 14),
    age: 0,
  };
}

export default class Meteors {
  static name = 'Meteors';

  setup(ctx) {
    const { Nx, Ny, Nz, params, t } = ctx;
    const base = (params.palette || 0);
    this.ms = [];
    const n = Math.max(1, params.count | 0);
    for (let i = 0; i < n; i++) {
      const m = spawnMeteor(Nx, Ny, Nz, t, base);
      // Pre-warm: scatter initial positions along their travel so the volume
      // isn't empty on frame 0.
      const pre = rand(0, Math.max(Nx, Ny, Nz));
      m.x += m.vx * pre; m.y += m.vy * pre; m.z += m.vz * pre;
      m.age = pre / Math.max(1, params.speed);
      this.ms.push(m);
    }
    this._beatGuard = 0;
  }

  update(ctx) {
    const { dt, params, Nx, Ny, Nz, audio } = ctx;
    if (!this.ms) this.setup(ctx);

    const base = (params.palette || 0);
    const target = Math.max(1, params.count | 0);
    while (this.ms.length < target) this.ms.push(spawnMeteor(Nx, Ny, Nz, ctx.t, base));
    while (this.ms.length > target) this.ms.pop();

    // Beat kick: respawn a couple of meteors as a coordinated burst.
    let kicks = 0;
    if (params.audioKick && audio && audio.beat && this._beatGuard <= 0) {
      kicks = Math.min(3, this.ms.length);
      this._beatGuard = 0.18;
    }
    if (this._beatGuard > 0) this._beatGuard -= dt;

    const energy = (audio && typeof audio.energy === 'number') ? audio.energy : 0;
    const speedBoost = 1 + energy * 0.45;
    const pad = params.trailLen + 3;

    for (let i = 0; i < this.ms.length; i++) {
      const m = this.ms[i];
      const sp = params.speed * m.speedMul * speedBoost;

      m.x += m.vx * sp * dt;
      m.y += m.vy * sp * dt;
      m.z += m.vz * sp * dt;

      // Gravity bends the path downward (Y is up) and re-normalizes velocity so
      // speed stays roughly constant while the arc curves — sells the "falling".
      m.vy -= params.gravity * dt * 0.12;
      const vlen = Math.hypot(m.vx, m.vy, m.vz) || 1;
      m.vx /= vlen; m.vy /= vlen; m.vz /= vlen;

      m.hue = (m.hue + params.hueShift * dt + 1) % 1;
      m.age += dt;

      const dead =
        m.x < -pad || m.x > Nx + pad ||
        m.y < -pad || m.y > Ny + pad ||
        m.z < -pad || m.z > Nz + pad ||
        kicks-- > 0;

      if (dead) this.ms[i] = spawnMeteor(Nx, Ny, Nz, ctx.t, base);
    }
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, params, utils, t } = ctx;
    out.fill(0);
    if (!this.ms) return;

    const clamp = utils.clamp;
    const NyNz = Ny * Nz;

    // Deposit one additive splat at sub-voxel position (x,y,z) with color
    // (r,g,b) already scaled by intensity. Trilinear over the 8 neighbors.
    const splat = (x, y, z, r, g, b) => {
      const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
      const fx = x - x0, fy = y - y0, fz = z - z0;
      for (let dx = 0; dx <= 1; dx++) {
        const xx = x0 + dx;
        if (xx < 0 || xx >= Nx) continue;
        const wx = dx ? fx : 1 - fx;
        for (let dy = 0; dy <= 1; dy++) {
          const yy = y0 + dy;
          if (yy < 0 || yy >= Ny) continue;
          const wy = dy ? fy : 1 - fy;
          const wxy = wx * wy;
          for (let dz = 0; dz <= 1; dz++) {
            const zz = z0 + dz;
            if (zz < 0 || zz >= Nz) continue;
            const w = wxy * (dz ? fz : 1 - fz);
            if (w <= 0) continue;
            const idx = (xx * NyNz + yy * Nz + zz) * 3;
            out[idx]     += r * w;   // additive accumulation
            out[idx + 1] += g * w;
            out[idx + 2] += b * w;
          }
        }
      }
    };

    // Tail sampling: more steps for longer trails, with a finer sub-step so the
    // streak reads as continuous rather than a string of beads.
    const baseLen = Math.max(2, params.trailLen);

    for (const m of this.ms) {
      const tailLen = baseLen * m.lenMul;
      const steps = Math.max(8, Math.round(tailLen * 2.2));
      const step = tailLen / steps;

      // Head flicker (twinkle) — gentle, never fully off.
      const flick = 0.85 + 0.15 * Math.sin(t * m.flickRate + m.flickPhase);

      // Spawn fade-in over the first fraction of life so heads don't pop.
      const spawnFade = clamp(m.age * 4.0, 0, 1);

      const headBright = m.bright * flick * spawnFade;

      // Hue endpoints: hot core (whiteish) -> meteor hue -> cooled ember.
      const hue = m.hue;
      const [mr, mg, mb] = utils.hsv(hue, 0.85, 1);        // body color
      const [er, eg, eb] = utils.hsv((hue + 0.96) % 1, 1.0, 1); // ember (warmer/redder)

      // Build a perpendicular basis so the tail can bloom sideways a little,
      // giving each streak volumetric thickness instead of a 1-voxel thread.
      let ax = -m.vy, ay = m.vx, az = 0;            // perp via cross with up-ish
      if (ax * ax + ay * ay + az * az < 1e-4) { ax = 1; ay = 0; az = 0; }
      let al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
      // second perpendicular = v x a
      let bx = m.vy * az - m.vz * ay;
      let by = m.vz * ax - m.vx * az;
      let bz = m.vx * ay - m.vy * ax;
      let bl = Math.hypot(bx, by, bz) || 1; bx /= bl; by /= bl; bz /= bl;

      for (let k = 0; k <= steps; k++) {
        const tt = k / steps;                 // 0 at head, 1 at tail end
        // Position back along the velocity (where the meteor came from).
        const back = k * step;
        const px = m.x - m.vx * back;
        const py = m.y - m.vy * back;
        const pz = m.z - m.vz * back;

        // Longitudinal intensity: blazing head, gentle decay so the mid-tail
        // stays clearly lit (reads as a glowing streak, not a few beads).
        const fall = (1 - tt);
        const intensity = fall * (0.35 + 0.65 * fall);

        // Color grade along the tail:
        //  near head  -> hot white core
        //  mid tail   -> saturated meteor hue
        //  far tail   -> deep ember, dimming to black
        let r, g, b;
        const whiteMix = clamp((0.25 - tt) / 0.25, 0, 1); // 1 at head -> 0
        const emberMix = clamp((tt - 0.5) / 0.5, 0, 1);   // 0 -> 1 at tail
        r = mr; g = mg; b = mb;
        if (whiteMix > 0) {
          r = r + (255 - r) * whiteMix;
          g = g + (255 - g) * whiteMix;
          b = b + (255 - b) * whiteMix;
        }
        if (emberMix > 0) {
          r = r + (er - r) * emberMix;
          g = g + (eg - g) * emberMix;
          b = b + (eb - b) * emberMix;
        }

        const amp = intensity * headBright;
        if (amp <= 0.002) continue;

        // Core deposit along the centerline.
        splat(px, py, pz, r * amp, g * amp, b * amp);

        // Sideways bloom: widest near the head, tapering down the tail. Skip
        // for the very tail tip to keep a crisp point. Cheap (4 extra splats).
        const glow = amp * 0.4 * (0.4 + 0.6 * fall);
        if (glow > 0.01) {
          splat(px + ax, py + ay, pz + az, r * glow, g * glow, b * glow);
          splat(px - ax, py - ay, pz - az, r * glow, g * glow, b * glow);
          splat(px + bx, py + by, pz + bz, r * glow, g * glow, b * glow);
          splat(px - bx, py - by, pz - bz, r * glow, g * glow, b * glow);
        }
      }

      // Extra hot over-bright core dab right at the head for a crisp highlight.
      const core = headBright * 1.6;
      if (core > 0.01) {
        splat(m.x, m.y, m.z, 255 * core, 255 * core, 250 * core);
      }
    }

    // Soft clamp (preserve hue): keep values finite and roughly 0..255 while
    // letting the additive bloom blow out to white where meteors overlap.
    const len = out.length;
    for (let i = 0; i < len; i++) {
      const v = out[i];
      out[i] = v > 255 ? 255 : (v < 0 ? 0 : v);
    }
  }
}
