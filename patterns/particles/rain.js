// Rain — crisp downward drops with motion streaks and floor splashes.
//
// Each drop is a glowing sub-voxel head with a velocity-aligned trail that
// fades upward, deposited trilinearly so heads read sharp and streaks read
// smooth through bloom. Drops fall under gravity with a touch of wind drift,
// so they travel through the volume front-to-back as well as down. When a
// drop hits the floor it kicks off an expanding splash ring. Moody cool
// palette: a near-white hot head grading down a tail into deep teal/indigo.
//
// Class API — drops, splashes and their sub-voxel positions are persistent
// state advanced every frame with ctx.dt.

export const params = {
  density:   { type: 'range', min: 0.05, max: 1,   step: 0.01, default: 0.55, label: 'Density' },
  speed:     { type: 'range', min: 1,    max: 20,  step: 0.1,  default: 9,    label: 'Fall speed' },
  trailLen:  { type: 'range', min: 1,    max: 10,  step: 0.1,  default: 5,    label: 'Streak length' },
  wind:      { type: 'range', min: 0,    max: 1,   step: 0.01, default: 0.35, label: 'Wind drift' },
  color:     { type: 'color', default: '#1f6bd8',  label: 'Rain tint' },
  glow:      { type: 'range', min: 0,    max: 1,   step: 0.01, default: 0.8,  label: 'Head glow' },
  splash:    { type: 'toggle', default: true },
};

function rand(a, b) { return a + Math.random() * (b - a); }

export default class Rain {
  static name = 'Rain';

  setup(ctx) {
    const { Nx, Ny, Nz } = ctx;
    this.drops = [];
    this.splashes = [];
    const target = this.targetCount(ctx);
    for (let i = 0; i < target; i++) {
      // Stagger the initial fill across the whole height so the rig is
      // already full of rain on frame 0 (the default render must look great).
      this.drops.push(this.newDrop(Nx, Ny, Nz, rand(-1, Ny)));
    }
  }

  targetCount(ctx) {
    const { Nx, Nz, params } = ctx;
    // Density scales with floor footprint (Nx*Nz), not height — rain rains down.
    return Math.max(1, Math.round(Nx * Nz * params.density * 0.6));
  }

  newDrop(Nx, Ny, Nz, y) {
    if (y === undefined) y = Ny + rand(0.5, Ny * 0.6);
    return {
      x: rand(0, Math.max(1, Nx - 1)),
      z: rand(0, Math.max(1, Nz - 1)),
      y,
      // Per-drop variation so timing feels organic, not metronomic.
      vx: 0, vz: 0,
      vs: rand(0.78, 1.22),                 // fall-speed multiplier
      hue: rand(-0.04, 0.05),               // tint jitter around base color
      phase: Math.random() * Math.PI * 2,   // wind sway phase
      bright: rand(0.7, 1),
    };
  }

  update(ctx) {
    const { dt, t, params, Nx, Ny, Nz } = ctx;

    const target = this.targetCount(ctx);
    while (this.drops.length < target) this.drops.push(this.newDrop(Nx, Ny, Nz));
    while (this.drops.length > target) this.drops.pop();

    const beat = ctx.audio && ctx.audio.beat ? 1 : 0;
    // Coprime-ish swirl rates give a non-repeating breeze across the volume.
    const gustX = Math.sin(t * 0.37) * 0.6 + Math.sin(t * 0.13 + 1.7) * 0.4;
    const gustZ = Math.cos(t * 0.29) * 0.6 + Math.sin(t * 0.19 + 0.6) * 0.4;

    for (const d of this.drops) {
      const fall = params.speed * d.vs * (1 + beat * 0.25);
      d.y -= fall * dt;

      // Gentle horizontal drift: a shared gust plus a per-drop sway so the
      // sheet of rain breathes and drifts through depth, not just downward.
      const sway = Math.sin(t * 1.3 + d.phase) * 0.5;
      d.x += (gustX + sway) * params.wind * dt * 2.2;
      d.z += (gustZ - sway) * params.wind * dt * 2.2;

      // Wrap horizontally so wind never starves a column.
      if (Nx > 1) { if (d.x < -0.5) d.x += Nx; else if (d.x > Nx - 0.5) d.x -= Nx; }
      if (Nz > 1) { if (d.z < -0.5) d.z += Nz; else if (d.z > Nz - 0.5) d.z -= Nz; }

      // Hit the floor: spawn a splash, then recycle this drop up top.
      if (d.y <= 0) {
        if (params.splash) {
          this.splashes.push({
            x: d.x, z: d.z,
            r: 0,
            life: 1,
            bright: d.bright,
            hue: d.hue,
          });
          if (this.splashes.length > 64) this.splashes.shift();
        }
        const nd = this.newDrop(Nx, Ny, Nz);
        d.x = nd.x; d.z = nd.z; d.y = nd.y;
        d.vs = nd.vs; d.hue = nd.hue; d.phase = nd.phase; d.bright = nd.bright;
      }
    }

    // Advance splash rings: expand outward and fade.
    for (const s of this.splashes) {
      s.r += dt * 6;
      s.life -= dt * 2.4;
    }
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      if (this.splashes[i].life <= 0) this.splashes.splice(i, 1);
    }
  }

  // Trilinear additive splat of a color at a continuous position.
  deposit(out, Nx, Ny, Nz, x, y, z, r, g, b) {
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
        for (let dz = 0; dz <= 1; dz++) {
          const zz = z0 + dz;
          if (zz < 0 || zz >= Nz) continue;
          const w = wx * wy * (dz ? fz : 1 - fz);
          if (w <= 0) continue;
          const idx = (xx * Ny + yy) * Nz + zz;
          out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r * w);
          out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g * w);
          out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b * w);
        }
      }
    }
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, t, params, utils } = ctx;
    out.fill(0);

    const base = utils.parseColor(params.color);
    // A near-white, slightly-cool hot head reads as a sharp glint through bloom.
    const head = utils.mix('#eaf4ff', base, 0.18);
    const br0 = base[0], bg0 = base[1], bb0 = base[2];
    const hr0 = head[0], hg0 = head[1], hb0 = head[2];

    const trail = Math.max(1, params.trailLen);
    // Sample the streak densely enough that it stays continuous when long.
    const steps = Math.max(3, Math.round(trail * 2.2));
    const glow = utils.clamp(params.glow, 0, 1);

    // Shared gust this frame (matches update()); coprime-ish rates -> non-repeating.
    const gustX = Math.sin(t * 0.37) * 0.6 + Math.sin(t * 0.13 + 1.7) * 0.4;
    const gustZ = Math.cos(t * 0.29) * 0.6 + Math.sin(t * 0.19 + 0.6) * 0.4;

    for (const d of this.drops) {
      const br = d.bright;
      // Drift direction this drop is travelling — the tail trails along it.
      const sway = Math.sin(t * 1.3 + d.phase) * 0.5;
      const driftX = (gustX + sway) * params.wind * 2.2;
      const driftZ = (gustZ - sway) * params.wind * 2.2;

      // March the streak from the head upward; head bright + hot, tail dim + cool base.
      for (let k = 0; k < steps; k++) {
        const f = k / (steps - 1 || 1);          // 0 at head .. 1 at tail tip
        const y = d.y + f * trail;                // trail extends upward
        if (y < -1 || y > Ny + 1) continue;
        const x = d.x - driftX * f * trail * 0.18;
        const z = d.z - driftZ * f * trail * 0.18;

        // Intensity: bright crisp head, quadratic fade up the tail.
        const fade = 1 - f;
        let intensity = fade * fade * br;
        // Extra punch right at the head for a glinting core.
        if (f < 0.18) intensity += glow * (0.18 - f) / 0.18 * 0.9 * br;

        // Color grade head -> base along the streak (manual lerp, no alloc).
        const hm = Math.max(0, 1 - f * 2.2);
        const r = (br0 + (hr0 - br0) * hm) * intensity;
        const g = (bg0 + (hg0 - bg0) * hm) * intensity;
        const b = (bb0 + (hb0 - bb0) * hm) * intensity;

        this.deposit(out, Nx, Ny, Nz, x, y, z, r, g, b);
      }
    }

    // Splash rings on the floor (y ~ 0). An expanding bright ring that fades.
    if (params.splash) {
      const floorH = head; // splashes flash with the bright head color
      for (const s of this.splashes) {
        const life = utils.clamp(s.life, 0, 1);
        const ring = s.r;
        const inten = life * life * s.bright * 0.9;
        if (inten <= 0.01) continue;
        // Drop ring samples around the circumference; trilinear so it glows.
        const segs = Math.max(6, Math.round(ring * 6) + 6);
        const splashCol = utils.mix(base, floorH, life * 0.6);
        for (let a = 0; a < segs; a++) {
          const ang = (a / segs) * Math.PI * 2;
          const rx = s.x + Math.cos(ang) * ring;
          const rz = s.z + Math.sin(ang) * ring;
          if (rx < -0.5 || rx > Nx - 0.5 || rz < -0.5 || rz > Nz - 0.5) continue;
          // Crown: spray arcs up as the ring expands, then settles back down.
          const ky = Math.min(1.2, ring * 0.45) * life;
          this.deposit(out, Nx, Ny, Nz, rx, ky, rz,
            splashCol[0] * inten, splashCol[1] * inten, splashCol[2] * inten);
        }
        // Bright impact point at the center while fresh.
        const centerI = life * life * life * s.bright;
        if (centerI > 0.02) {
          this.deposit(out, Nx, Ny, Nz, s.x, 0, s.z,
            floorH[0] * centerI, floorH[1] * centerI, floorH[2] * centerI);
        }
      }
    }
  }
}
