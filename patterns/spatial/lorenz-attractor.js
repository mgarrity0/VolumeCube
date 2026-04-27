// Lorenz Attractor — chaotic 3D trajectory traced as a fading rainbow ribbon.
//
// Integrates the canonical Lorenz system in many substeps per frame so the
// trajectory stays smooth at any `speed`. The last `trailLen` integration
// samples are kept as a flat array; each is splatted into the voxel grid
// with intensity falling off by age and a rainbow hue cycling along the
// trail's length.
//
// ODE space spans roughly x∈[-22,22], y∈[-28,28], z∈[0,50]. We map:
//   x  → cube X
//   z  → cube Y (so the "up" axis of the butterfly faces up)
//   y  → cube Z (depth)
// putting the wings face-on toward the front of the cube by default.

export const params = {
  speed:    { type: 'range', min: 0.1, max: 5,    step: 0.05,  default: 1.0 },
  sigma:    { type: 'range', min: 5,   max: 20,   step: 0.1,   default: 10 },
  rho:      { type: 'range', min: 14,  max: 60,   step: 0.1,   default: 28 },
  beta:     { type: 'range', min: 1,   max: 5,    step: 0.05,  default: 2.667 },
  trailLen: { type: 'int',   min: 50,  max: 2000,              default: 600 },
  scale:    { type: 'range', min: 15,  max: 35,   step: 0.5,   default: 25,   label: 'ODE → cube scale' },
  hueCycle: { type: 'range', min: 0,   max: 5,    step: 0.05,  default: 0.7,  label: 'Hue cycle (rev/trail)' },
  hueDrift: { type: 'range', min: -1,  max: 1,    step: 0.005, default: 0.05, label: 'Hue drift (rev/sec)' },
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

export default class LorenzAttractor {
  static name = 'Lorenz Attractor';

  setup() {
    // Off-axis seed so the integrator escapes the unstable origin.
    this.x = 0.01; this.y = 0; this.z = 0;
    this.trail = []; // flat [x, y, z, x, y, z, ...] for cache locality
  }

  update(ctx) {
    const { dt, params } = ctx;

    // Many substeps per frame so the trajectory is a continuous ribbon
    // even when `speed` is cranked — without this the trail jumps in chunks.
    const substeps = Math.max(20, Math.ceil(60 * params.speed));
    const h = dt * params.speed / substeps;

    let { x, y, z } = this;
    const { sigma, rho, beta } = params;
    const trail = this.trail;
    for (let i = 0; i < substeps; i++) {
      const dx = sigma * (y - x);
      const dy = x * (rho - z) - y;
      const dz = x * y - beta * z;
      x += dx * h; y += dy * h; z += dz * h;
      trail.push(x, y, z);
    }
    this.x = x; this.y = y; this.z = z;

    const max = params.trailLen * 3;
    if (trail.length > max) trail.splice(0, trail.length - max);
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, t, params, utils } = ctx;
    out.fill(0);
    const trail = this.trail;
    const total = trail.length / 3;
    if (total === 0) return;

    const scale = params.scale;
    const sxN = Nx > 1 ? (Nx - 1) * 0.5 : 0;
    const syN = Ny > 1 ? (Ny - 1) * 0.5 : 0;
    const szN = Nz > 1 ? (Nz - 1) * 0.5 : 0;
    const cxV = (Nx - 1) * 0.5;
    const cyV = (Ny - 1) * 0.5;
    const czV = (Nz - 1) * 0.5;

    for (let i = 0; i < total; i++) {
      const ox = trail[i * 3 + 0];
      const oy = trail[i * 3 + 1];
      const oz = trail[i * 3 + 2];
      // Map ODE coords → voxel space. ODE z is centered at ~25 so subtract.
      const vx = cxV + (ox / scale) * sxN;
      const vy = cyV + ((oz - 25) / scale) * syN;
      const vz = czV + (oy / scale) * szN;

      // Age 0=newest tip, 1=oldest tail; brighter at the head.
      const age = (total - 1 - i) / total;
      const intensity = Math.pow(1 - age, 1.7);
      const hue = (i / Math.max(1, total)) * params.hueCycle + t * params.hueDrift;
      const c = utils.hsv(((hue % 1) + 1) % 1, 0.9, 1);
      splat(out, Nx, Ny, Nz, vx, vy, vz, c[0] * intensity, c[1] * intensity, c[2] * intensity);
    }
  }
}
