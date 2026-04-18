// Sparks — upward-launching embers from the base plane.
//
// Particles spawn at the floor with a randomized velocity and gravity;
// color shifts warm → cool as they age (like real sparks cooling).

export const params = {
  rate:     { type: 'range', min: 1,  max: 120, step: 1,    default: 40 },
  gravity:  { type: 'range', min: 0,  max: 20,  step: 0.1,  default: 8 },
  launch:   { type: 'range', min: 2,  max: 25,  step: 0.1,  default: 11 },
  spread:   { type: 'range', min: 0,  max: 3,   step: 0.01, default: 1.2 },
  life:     { type: 'range', min: 0.3, max: 3,  step: 0.01, default: 1.2 },
};

export default class Sparks {
  static name = 'Sparks';

  setup(ctx) {
    this.N = ctx.N;
    this.parts = [];
    this.spawnAcc = 0;
  }

  spawn(N, params) {
    const half = (N - 1) / 2;
    this.parts.push({
      x: half + (Math.random() - 0.5) * 0.5,
      y: 0,
      z: half + (Math.random() - 0.5) * 0.5,
      vx: (Math.random() - 0.5) * params.spread,
      vy: params.launch * (0.7 + Math.random() * 0.5),
      vz: (Math.random() - 0.5) * params.spread,
      age: 0,
      life: params.life * (0.7 + Math.random() * 0.6),
    });
  }

  update(ctx) {
    const { dt, N, params } = ctx;
    if (this.N !== N) this.setup(ctx);

    this.spawnAcc += params.rate * dt;
    while (this.spawnAcc >= 1) {
      this.spawn(N, params);
      this.spawnAcc -= 1;
    }

    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.vy -= params.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.age += dt;
      if (p.age > p.life || p.y < -0.5 || p.x < -1 || p.x > N || p.z < -1 || p.z > N) {
        this.parts.splice(i, 1);
      }
    }
  }

  render(ctx, out) {
    const { N, utils } = ctx;
    out.fill(0);

    for (const p of this.parts) {
      const t = p.age / p.life; // 0..1
      // Hot white → yellow → red → dim.
      const tail = utils.clamp(1 - t, 0, 1);
      const r = 255 * tail;
      const g = 255 * tail * (1 - t * 0.85);
      const b = 255 * Math.pow(1 - t, 6) * 0.8;

      const x0 = Math.floor(p.x), y0 = Math.floor(p.y), z0 = Math.floor(p.z);
      const fx = p.x - x0, fy = p.y - y0, fz = p.z - z0;
      for (let dx = 0; dx <= 1; dx++) {
        for (let dy = 0; dy <= 1; dy++) {
          for (let dz = 0; dz <= 1; dz++) {
            const x = x0 + dx, y = y0 + dy, z = z0 + dz;
            if (x < 0 || x >= N || y < 0 || y >= N || z < 0 || z >= N) continue;
            const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
            const idx = (x * N + y) * N + z;
            out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r * w);
            out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g * w);
            out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b * w);
          }
        }
      }
    }
  }
}
