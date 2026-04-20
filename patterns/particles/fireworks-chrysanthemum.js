// Chrysanthemum Fireworks — multi-stage shells with secondary bursts.
//
// Distinct from particles/fireworks.js (which emits spherical puffs): a
// chrysanthemum shell bursts into a *ring* of primary shards travelling
// outward in a plane, and partway through their flight each primary
// fires its own tiny secondary burst. The result reads as the classic
// "flower-with-sparkles" Japanese fireworks shell.
//
// Ring plane normal is biased toward vertical so the petals fan outward
// (otherwise edge-on rings collapse to a line on screen).

export const params = {
  launchRate:   { type: 'range', min: 0.1, max: 3,  step: 0.05, default: 0.7 },
  primaries:    { type: 'int',   min: 6,   max: 24, default: 14, label: 'Primary shards' },
  secondaries:  { type: 'int',   min: 0,   max: 12, default: 5,  label: 'Secondary shards' },
  shellSize:    { type: 'range', min: 2,   max: 10, step: 0.1,   default: 4.5 },
  gravity:      { type: 'range', min: 0,   max: 12, step: 0.1,   default: 4 },
  palette:      { type: 'select', options: ['rainbow', 'warm', 'cool', 'gold', 'emerald'], default: 'rainbow' },
};

const PALETTES = {
  warm:    [[255, 80, 40],  [255, 180, 60],  [255, 240, 140]],
  cool:    [[100, 180, 255],[160, 100, 255], [80, 255, 220]],
  gold:    [[255, 220, 100],[255, 180, 60],  [255, 120, 30]],
  emerald: [[60, 255, 150], [160, 255, 120], [255, 255, 220]],
};

function pickColor(palette, utils) {
  if (palette === 'rainbow') return utils.hsv(Math.random(), 0.95, 1);
  const pal = PALETTES[palette] ?? PALETTES.warm;
  return pal[(Math.random() * pal.length) | 0].slice();
}

function splat(out, N, x, y, z, r, g, b) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  for (let dx = 0; dx <= 1; dx++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dz = 0; dz <= 1; dz++) {
        const xx = x0 + dx, yy = y0 + dy, zz = z0 + dz;
        if (xx < 0 || xx >= N || yy < 0 || yy >= N || zz < 0 || zz >= N) continue;
        const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
        const idx = (xx * N + yy) * N + zz;
        out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r * w);
        out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g * w);
        out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b * w);
      }
    }
  }
}

export default class ChrysanthemumFireworks {
  static name = 'Fireworks (Chrysanthemum)';

  setup(ctx) {
    this.N = ctx.N;
    this.rockets = [];
    this.primaries = [];
    this.secondaries = [];
    this.launchAcc = 0;
  }

  launch(ctx) {
    const { N, params, utils } = ctx;
    const half = (N - 1) / 2;
    const targetY = N * (0.55 + Math.random() * 0.35);
    const vy = Math.sqrt(2 * params.gravity * targetY);
    // Ring plane normal — biased toward vertical so the ring presents face-on.
    const nx = (Math.random() - 0.5) * 0.6;
    const ny = 0.8 + Math.random() * 0.2;
    const nz = (Math.random() - 0.5) * 0.6;
    const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    this.rockets.push({
      x: half + (Math.random() - 0.5) * N * 0.4,
      y: 0,
      z: half + (Math.random() - 0.5) * N * 0.4,
      vx: (Math.random() - 0.5) * 0.6,
      vy,
      vz: (Math.random() - 0.5) * 0.6,
      color: pickColor(params.palette, utils),
      normal: [nx / nlen, ny / nlen, nz / nlen],
    });
  }

  burst(rocket, params) {
    // Two orthonormal tangents to the ring normal — pick the larger cross
    // product target to avoid a degenerate u when normal ≈ y.
    const [nx, ny, nz] = rocket.normal;
    let ux, uy, uz;
    if (Math.abs(ny) < 0.9) { ux = ny; uy = -nx; uz = 0; }
    else                    { ux = 0;  uy = -nz; uz = ny; }
    const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
    ux /= ulen; uy /= ulen; uz /= ulen;
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;

    const speed = params.shellSize;
    for (let i = 0; i < params.primaries; i++) {
      const a = (i / params.primaries) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = ux * ca + vx * sa;
      const dy = uy * ca + vy * sa;
      const dz = uz * ca + vz * sa;
      this.primaries.push({
        x: rocket.x, y: rocket.y, z: rocket.z,
        vx: dx * speed, vy: dy * speed, vz: dz * speed,
        color: rocket.color,
        age: 0,
        life: 1.2 + Math.random() * 0.5,
        splitAt: 0.55 + Math.random() * 0.3,
        split: false,
      });
    }
  }

  split(shard, params) {
    for (let i = 0; i < params.secondaries; i++) {
      // Rejection-free random unit vector via spherical coordinates.
      const theta = Math.acos(2 * Math.random() - 1);
      const phi = Math.random() * Math.PI * 2;
      const sx = Math.sin(theta) * Math.cos(phi);
      const sy = Math.cos(theta);
      const sz = Math.sin(theta) * Math.sin(phi);
      const speed = params.shellSize * 0.4 * (0.4 + Math.random() * 0.8);
      this.secondaries.push({
        x: shard.x, y: shard.y, z: shard.z,
        vx: shard.vx * 0.2 + sx * speed,
        vy: shard.vy * 0.2 + sy * speed,
        vz: shard.vz * 0.2 + sz * speed,
        color: shard.color,
        age: 0,
        life: 0.45 + Math.random() * 0.4,
      });
    }
  }

  update(ctx) {
    const { dt, N, params } = ctx;
    if (this.N !== N) this.setup(ctx);

    this.launchAcc += params.launchRate * dt;
    while (this.launchAcc >= 1) { this.launch(ctx); this.launchAcc -= 1; }

    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.vy -= params.gravity * dt;
      r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
      if (r.vy <= 0) { this.burst(r, params); this.rockets.splice(i, 1); }
    }

    for (let i = this.primaries.length - 1; i >= 0; i--) {
      const s = this.primaries[i];
      // Primaries feel gravity weakly — they're meant to arc out and fade in the air.
      s.vy -= params.gravity * 0.3 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.vx *= 0.985; s.vz *= 0.985;
      s.age += dt;
      if (!s.split && s.age / s.life >= s.splitAt) {
        s.split = true;
        if (params.secondaries > 0) this.split(s, params);
      }
      if (s.age > s.life) this.primaries.splice(i, 1);
    }

    for (let i = this.secondaries.length - 1; i >= 0; i--) {
      const s = this.secondaries[i];
      s.vy -= params.gravity * 0.5 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.age += dt;
      if (s.age > s.life) this.secondaries.splice(i, 1);
    }
  }

  render(ctx, out) {
    const { N } = ctx;
    out.fill(0);

    for (const r of this.rockets) {
      const [cr, cg, cb] = r.color;
      splat(out, N, r.x, r.y, r.z, cr, cg, cb);
      splat(out, N, r.x - r.vx * 0.04, r.y - r.vy * 0.04, r.z - r.vz * 0.04,
            cr * 0.35, cg * 0.35, cb * 0.35);
    }
    for (const s of this.primaries) {
      const t = 1 - s.age / s.life;
      const k = t * t;
      splat(out, N, s.x, s.y, s.z, s.color[0] * k, s.color[1] * k, s.color[2] * k);
    }
    for (const s of this.secondaries) {
      // Secondaries flash brighter briefly — the "sparkle" accent on a chrysanthemum.
      const t = 1 - s.age / s.life;
      const k = Math.min(1, t * 1.3);
      const bright = k * k;
      splat(out, N, s.x, s.y, s.z, s.color[0] * bright, s.color[1] * bright, s.color[2] * bright);
    }
  }
}
