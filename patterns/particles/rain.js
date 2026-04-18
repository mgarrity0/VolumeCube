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
    const { N, params } = ctx;
    const target = Math.max(1, Math.round(N * N * params.density * 0.6));
    this.drops = [];
    for (let i = 0; i < target; i++) this.drops.push(this.newDrop(N, Math.random() * N));
    this.N = N;
  }

  newDrop(N, y = N + Math.random() * N) {
    return {
      x: Math.floor(Math.random() * N),
      z: Math.floor(Math.random() * N),
      y,
      splash: 0,
    };
  }

  update(ctx) {
    const { dt, params, N } = ctx;
    if (this.N !== N) this.setup(ctx);

    // Adjust drop count to match density target.
    const target = Math.max(1, Math.round(N * N * params.density * 0.6));
    while (this.drops.length < target) this.drops.push(this.newDrop(N));
    while (this.drops.length > target) this.drops.pop();

    for (const d of this.drops) {
      d.y -= params.speed * dt;
      if (d.y < -params.trailLen) {
        if (params.splash) d.splash = 6;
        const nd = this.newDrop(N, N + Math.random() * 2);
        d.x = nd.x; d.z = nd.z; d.y = nd.y;
      }
      if (d.splash > 0) d.splash -= 60 * dt;
    }
  }

  render(ctx, out) {
    const { N, params, utils } = ctx;
    out.fill(0);
    const [rr, gg, bb] = utils.mix(params.color, params.color, 0);

    for (const d of this.drops) {
      const dx = d.x, dz = d.z;
      for (let y = 0; y < N; y++) {
        const dy = d.y - y; // head at d.y; trail extends upward (dy>0)
        if (dy < -0.5 || dy > params.trailLen) continue;
        let intensity;
        if (dy < 0) intensity = 1 + dy * 2;       // head falloff below integer cell
        else        intensity = 1 - dy / params.trailLen;
        intensity = utils.clamp(intensity, 0, 1);
        intensity *= intensity;
        const idx = (dx * N + y) * N + dz;
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
            if (xx < 0 || xx >= N || zz < 0 || zz >= N) continue;
            const idx = (xx * N + 0) * N + zz;
            out[idx * 3 + 0] = Math.max(out[idx * 3 + 0], r);
            out[idx * 3 + 1] = Math.max(out[idx * 3 + 1], g);
            out[idx * 3 + 2] = Math.max(out[idx * 3 + 2], b);
          }
        }
      }
    }
  }
}
