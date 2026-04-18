// Snow — drifting flakes with horizontal sway.
//
// Flakes fall slowly with a tiny noise-driven horizontal wander; they
// dim slightly as they approach the floor to suggest atmospheric depth.

export const params = {
  density: { type: 'range', min: 0.05, max: 1.5, step: 0.01, default: 0.6 },
  speed:   { type: 'range', min: 0.1,  max: 5,   step: 0.05, default: 1.1 },
  sway:    { type: 'range', min: 0,    max: 1.5, step: 0.01, default: 0.35 },
  tint:    { type: 'color', default: '#ffffff' },
};

export default class Snow {
  static name = 'Snow';

  setup(ctx) {
    const { N, params } = ctx;
    const target = Math.max(1, Math.round(N * N * params.density));
    this.flakes = [];
    for (let i = 0; i < target; i++) this.flakes.push(this.newFlake(N));
    this.N = N;
    this.t = 0;
  }

  newFlake(N, y = N + Math.random() * N) {
    return {
      x: Math.random() * (N - 1),
      z: Math.random() * (N - 1),
      y,
      phase: Math.random() * Math.PI * 2,
      wobble: 0.6 + Math.random() * 0.8,
    };
  }

  update(ctx) {
    const { dt, params, N } = ctx;
    if (this.N !== N) this.setup(ctx);
    this.t += dt;

    const target = Math.max(1, Math.round(N * N * params.density));
    while (this.flakes.length < target) this.flakes.push(this.newFlake(N));
    while (this.flakes.length > target) this.flakes.pop();

    for (const f of this.flakes) {
      f.y -= params.speed * dt * f.wobble;
      if (f.y < -0.5) {
        const nf = this.newFlake(N, N + 0.5 + Math.random() * 2);
        f.x = nf.x; f.z = nf.z; f.y = nf.y; f.phase = nf.phase; f.wobble = nf.wobble;
      }
    }
  }

  render(ctx, out) {
    const { N, params, utils } = ctx;
    out.fill(0);
    const [tr, tg, tb] = utils.mix(params.tint, params.tint, 0);

    for (const f of this.flakes) {
      const sway = Math.sin(this.t * 0.8 + f.phase) * params.sway;
      const xF = f.x + sway;
      const zF = f.z + Math.cos(this.t * 0.6 + f.phase * 1.3) * params.sway * 0.7;
      // Trilinear splat across the 8 nearest voxels.
      const x0 = Math.floor(xF), y0 = Math.floor(f.y), z0 = Math.floor(zF);
      const fx = xF - x0, fy = f.y - y0, fz = zF - z0;
      const depthFade = utils.clamp(0.55 + f.y / N * 0.5, 0.3, 1);
      for (let dx = 0; dx <= 1; dx++) {
        for (let dy = 0; dy <= 1; dy++) {
          for (let dz = 0; dz <= 1; dz++) {
            const x = x0 + dx, y = y0 + dy, z = z0 + dz;
            if (x < 0 || x >= N || y < 0 || y >= N || z < 0 || z >= N) continue;
            const wx = dx ? fx : 1 - fx;
            const wy = dy ? fy : 1 - fy;
            const wz = dz ? fz : 1 - fz;
            const w = wx * wy * wz * depthFade;
            const idx = (x * N + y) * N + z;
            out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + tr * w);
            out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + tg * w);
            out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + tb * w);
          }
        }
      }
    }
  }
}
