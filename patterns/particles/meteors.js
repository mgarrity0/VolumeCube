// Meteors — diagonal streaks that shoot across the volume with a bright
// head and a fading tail. New meteors spawn with random entry faces and
// directions so the effect feels omnidirectional.

export const params = {
  count:    { type: 'int',   min: 1,  max: 40,  step: 1,    default: 8 },
  speed:    { type: 'range', min: 2,  max: 30,  step: 0.1,  default: 12 },
  trailLen: { type: 'range', min: 2,  max: 15,  step: 0.1,  default: 6 },
  hueSpin:  { type: 'range', min: 0,  max: 1,   step: 0.01, default: 0.3 },
};

function randomEntry(Nx, Ny, Nz) {
  // Pick one of the six faces as entry; velocity points into the volume.
  const face = (Math.random() * 6) | 0;
  const rx = Math.random() * (Nx - 1);
  const ry = Math.random() * (Ny - 1);
  const rz = Math.random() * (Nz - 1);
  let px, py, pz, dx, dy, dz;
  switch (face) {
    case 0: px = -1;    py = ry; pz = rz; dx =  1; dy = 0; dz = 0; break;
    case 1: px = Nx;    py = ry; pz = rz; dx = -1; dy = 0; dz = 0; break;
    case 2: px = rx; py = -1;    pz = rz; dx = 0; dy =  1; dz = 0; break;
    case 3: px = rx; py = Ny;    pz = rz; dx = 0; dy = -1; dz = 0; break;
    case 4: px = rx; py = ry; pz = -1;    dx = 0; dy = 0; dz =  1; break;
    default: px = rx; py = ry; pz = Nz;   dx = 0; dy = 0; dz = -1; break;
  }
  // Add a perpendicular drift so streaks aren't purely axis-aligned.
  dx += (Math.random() - 0.5) * 0.6;
  dy += (Math.random() - 0.5) * 0.6;
  dz += (Math.random() - 0.5) * 0.6;
  const len = Math.hypot(dx, dy, dz) || 1;
  return { x: px, y: py, z: pz, vx: dx / len, vy: dy / len, vz: dz / len, hue: Math.random() };
}

export default class Meteors {
  static name = 'Meteors';

  setup(ctx) {
    this.ms = [];
    for (let i = 0; i < ctx.params.count; i++) {
      this.ms.push(randomEntry(ctx.Nx, ctx.Ny, ctx.Nz));
    }
  }

  update(ctx) {
    const { dt, params, Nx, Ny, Nz } = ctx;
    while (this.ms.length < params.count) this.ms.push(randomEntry(Nx, Ny, Nz));
    while (this.ms.length > params.count) this.ms.pop();

    for (let i = 0; i < this.ms.length; i++) {
      const m = this.ms[i];
      m.x += m.vx * params.speed * dt;
      m.y += m.vy * params.speed * dt;
      m.z += m.vz * params.speed * dt;
      m.hue = (m.hue + params.hueSpin * dt) % 1;
      const pad = params.trailLen + 2;
      if (m.x < -pad || m.x > Nx + pad ||
          m.y < -pad || m.y > Ny + pad ||
          m.z < -pad || m.z > Nz + pad) {
        this.ms[i] = randomEntry(Nx, Ny, Nz);
      }
    }
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, params, utils } = ctx;
    out.fill(0);

    const tailSteps = Math.max(2, Math.round(params.trailLen));
    for (const m of this.ms) {
      const [hr, hg, hb] = utils.hsv(m.hue, 0.6, 1);
      for (let k = 0; k < tailSteps; k++) {
        const t = k / tailSteps;
        const intensity = (1 - t) * (1 - t);
        const x = m.x - m.vx * k * 0.8;
        const y = m.y - m.vy * k * 0.8;
        const z = m.z - m.vz * k * 0.8;
        const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
        const fx = x - x0, fy = y - y0, fz = z - z0;
        for (let dx = 0; dx <= 1; dx++) {
          for (let dy = 0; dy <= 1; dy++) {
            for (let dz = 0; dz <= 1; dz++) {
              const xx = x0 + dx, yy = y0 + dy, zz = z0 + dz;
              if (xx < 0 || xx >= Nx || yy < 0 || yy >= Ny || zz < 0 || zz >= Nz) continue;
              const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz) * intensity;
              const idx = (xx * Ny + yy) * Nz + zz;
              out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + hr * w);
              out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + hg * w);
              out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + hb * w);
            }
          }
        }
      }
    }
  }
}
