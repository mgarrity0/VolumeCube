// Rain — streaks of downward drops.
//
// Each drop is a falling head with an upward-fading trail. Drops respawn
// at the top when they leave the grid. Class API because drops have
// persistent state between frames.

export const params = {
  density:   { type: 'range', min: 0.05, max: 1,   step: 0.01, default: 0.5 },
  speed:     { type: 'range', min: 1,    max: 20,  step: 0.1,  default: 8 },
  trailLen:  { type: 'range', min: 1,    max: 10,  step: 0.1,  default: 4 },
  color:     { type: 'color', default: '#7ab8ff' },
  splash:    { type: 'toggle', default: true },
};

export default class Rain {
  static name = 'Rain';

  setup(ctx) {
    const { Nx, Ny, Nz, params } = ctx;
    // Density scales with floor area (Nx*Nz), not height — rain fills from above.
    const target = Math.max(1, Math.round(Nx * Nz * params.density * 0.6));
    this.drops = [];
    for (let i = 0; i < target; i++) this.drops.push(this.newDrop(Nx, Ny, Nz, Math.random() * Ny));
  }

  newDrop(Nx, Ny, Nz, y) {
    if (y === undefined) y = Ny + Math.random() * Ny;
    return {
      x: Math.floor(Math.random() * Nx),
      z: Math.floor(Math.random() * Nz),
      y,
      splash: 0,
    };
  }

  update(ctx) {
    const { dt, params, Nx, Ny, Nz } = ctx;

    const target = Math.max(1, Math.round(Nx * Nz * params.density * 0.6));
    while (this.drops.length < target) this.drops.push(this.newDrop(Nx, Ny, Nz));
    while (this.drops.length > target) this.drops.pop();

    for (const d of this.drops) {
      d.y -= params.speed * dt;
      if (d.y < -params.trailLen) {
        if (params.splash) d.splash = 6;
        const nd = this.newDrop(Nx, Ny, Nz, Ny + Math.random() * 2);
        d.x = nd.x; d.z = nd.z; d.y = nd.y;
      }
      if (d.splash > 0) d.splash -= 60 * dt;
    }
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, params, utils } = ctx;
    out.fill(0);
    const [rr, gg, bb] = utils.parseColor(params.color);

    for (const d of this.drops) {
      const dx = d.x, dz = d.z;
      for (let y = 0; y < Ny; y++) {
        const dy = d.y - y; // head at d.y; trail extends upward (dy>0)
        if (dy < -0.5 || dy > params.trailLen) continue;
        let intensity;
        if (dy < 0) intensity = 1 + dy * 2;       // head falloff below integer cell
        else        intensity = 1 - dy / params.trailLen;
        intensity = utils.clamp(intensity, 0, 1);
        intensity *= intensity;
        const idx = (dx * Ny + y) * Nz + dz;
        out[idx * 3 + 0] = Math.min(255, rr * intensity);
        out[idx * 3 + 1] = Math.min(255, gg * intensity);
        out[idx * 3 + 2] = Math.min(255, bb * intensity);
      }
      // Splash ring on the floor.
      if (d.splash > 0 && d.y < 1) {
        const t = d.splash / 6;
        const r = Math.round(rr * t * 0.6);
        const g = Math.round(gg * t * 0.6);
        const b = Math.round(bb * t * 0.6);
        for (let ox = -1; ox <= 1; ox++) {
          for (let oz = -1; oz <= 1; oz++) {
            if ((ox === 0) === (oz === 0)) continue;
            const xx = dx + ox, zz = dz + oz;
            if (xx < 0 || xx >= Nx || zz < 0 || zz >= Nz) continue;
            const idx = (xx * Ny + 0) * Nz + zz;
            out[idx * 3 + 0] = Math.max(out[idx * 3 + 0], r);
            out[idx * 3 + 1] = Math.max(out[idx * 3 + 1], g);
            out[idx * 3 + 2] = Math.max(out[idx * 3 + 2], b);
          }
        }
      }
    }
  }
}
