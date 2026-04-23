// Fireworks — rockets arc upward then burst into colored shells.
//
// Three particle states: 'rocket' (arcing with a trail), 'burst' (radial
// expansion from the peak), and 'ember' (slow falling fragments after
// the burst fades).

export const params = {
  launchRate: { type: 'range', min: 0.2, max: 4,  step: 0.05, default: 1.1 },
  shellSize:  { type: 'range', min: 2,   max: 10, step: 0.1,  default: 5 },
  gravity:    { type: 'range', min: 0,   max: 15, step: 0.1,  default: 6 },
  palette:    { type: 'select', options: ['mixed', 'warm', 'cool', 'mono'], default: 'mixed' },
};

const PAL = {
  mixed: [[255, 80, 80], [255, 200, 60], [80, 180, 255], [180, 80, 255], [80, 255, 160]],
  warm:  [[255, 80, 60], [255, 160, 40], [255, 220, 120]],
  cool:  [[80, 160, 255], [140, 80, 255], [80, 255, 220]],
  mono:  [[255, 255, 255], [220, 220, 255]],
};

function splat(out, Nx, Ny, Nz, x, y, z, r, g, b) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  for (let dx = 0; dx <= 1; dx++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dz = 0; dz <= 1; dz++) {
        const xx = x0 + dx, yy = y0 + dy, zz = z0 + dz;
        if (xx < 0 || xx >= Nx || yy < 0 || yy >= Ny || zz < 0 || zz >= Nz) continue;
        const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
        const idx = (xx * Ny + yy) * Nz + zz;
        out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r * w);
        out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g * w);
        out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b * w);
      }
    }
  }
}

export default class Fireworks {
  static name = 'Fireworks';

  setup() {
    this.rockets = [];
    this.shards = [];
    this.launchAcc = 0;
  }

  launch(Nx, Ny, Nz, params) {
    const pal = PAL[params.palette] ?? PAL.mixed;
    const color = pal[(Math.random() * pal.length) | 0];
    const halfX = (Nx - 1) / 2;
    const halfZ = (Nz - 1) / 2;
    const targetY = Ny * (0.55 + Math.random() * 0.35);
    const vy = Math.sqrt(2 * params.gravity * targetY);
    this.rockets.push({
      x: halfX + (Math.random() - 0.5) * Nx * 0.4,
      y: 0,
      z: halfZ + (Math.random() - 0.5) * Nz * 0.4,
      vx: (Math.random() - 0.5) * 0.8,
      vy,
      vz: (Math.random() - 0.5) * 0.8,
      color,
      age: 0,
    });
  }

  burst(rocket, params) {
    const COUNT = 42;
    for (let i = 0; i < COUNT; i++) {
      // Random unit vector (rejection-free via spherical coords).
      const theta = Math.acos(2 * Math.random() - 1);
      const phi = Math.random() * Math.PI * 2;
      const sx = Math.sin(theta) * Math.cos(phi);
      const sy = Math.cos(theta);
      const sz = Math.sin(theta) * Math.sin(phi);
      const speed = params.shellSize * (0.6 + Math.random() * 0.6);
      this.shards.push({
        x: rocket.x, y: rocket.y, z: rocket.z,
        vx: sx * speed, vy: sy * speed, vz: sz * speed,
        color: rocket.color,
        age: 0,
        life: 0.9 + Math.random() * 0.8,
      });
    }
  }

  update(ctx) {
    const { dt, Nx, Ny, Nz, params } = ctx;

    this.launchAcc += params.launchRate * dt;
    while (this.launchAcc >= 1) {
      this.launch(Nx, Ny, Nz, params);
      this.launchAcc -= 1;
    }

    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.vy -= params.gravity * dt;
      r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
      r.age += dt;
      if (r.vy <= 0) {
        this.burst(r, params);
        this.rockets.splice(i, 1);
      }
    }

    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.vy -= params.gravity * 0.4 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.vx *= 0.985; s.vz *= 0.985; // air drag
      s.age += dt;
      if (s.age > s.life) this.shards.splice(i, 1);
    }
  }

  render(ctx, out) {
    const { Nx, Ny, Nz } = ctx;
    out.fill(0);

    // Rockets leave a bright head + short dim trail.
    for (const r of this.rockets) {
      const [cr, cg, cb] = r.color;
      splat(out, Nx, Ny, Nz, r.x, r.y, r.z, cr, cg, cb);
      splat(out, Nx, Ny, Nz, r.x - r.vx * 0.04, r.y - r.vy * 0.04, r.z - r.vz * 0.04, cr * 0.35, cg * 0.35, cb * 0.35);
    }

    for (const s of this.shards) {
      const t = 1 - s.age / s.life;
      const k = t * t;
      splat(out, Nx, Ny, Nz, s.x, s.y, s.z, s.color[0] * k, s.color[1] * k, s.color[2] * k);
    }
  }
}
