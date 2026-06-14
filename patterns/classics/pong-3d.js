// 3D Pong — ball bouncing between two AI-controlled paddles on the Z faces.
//
// Ball travels through the cube interior; X and Y walls reflect elastically,
// the Z faces are only "solid" where a paddle is present — miss the paddle
// and the ball serves from center again. Each paddle is a flat (Nx,Ny)
// square at z=0 (paddle1) or z=Nz-1 (paddle2). On contact we add "english"
// proportional to the off-center hit position so volleys diverge over time
// instead of locking into a single trajectory.
//
// AI tracking: paddles aim at the predicted impact point, but their max
// movement speed is gated by `aiSkill`. At low skill the paddle can't keep
// up with sharp angles → misses → re-serve. At high skill, perfect rally.
//
// Note: needs at least Nz≈4 to read as a real game (paddles occupy z=0 and
// z=Nz-1, so play space is Nz-2 layers thick).

export const params = {
  ballSpeed:    { type: 'range', min: 2,   max: 20,  step: 0.5,  default: 7,   label: 'Ball speed (vox/sec)' },
  paddleSize:   { type: 'int',   min: 0,   max: 4,               default: 2,   label: 'Paddle half-size' },
  aiSkill:      { type: 'range', min: 0.1, max: 1.5, step: 0.05, default: 0.7, label: 'AI skill' },
  english:      { type: 'range', min: 0,   max: 2,   step: 0.05, default: 1.0, label: 'Hit english' },
  trailLen:     { type: 'int',   min: 0,   max: 30,              default: 8 },
  ballColor:    { type: 'color', default: '#ffffff' },
  paddle1Color: { type: 'color', default: '#ff5050' },
  paddle2Color: { type: 'color', default: '#5080ff' },
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

export default class Pong3D {
  static name = '3D Pong';

  setup(ctx) {
    const { Nx, Ny, Nz } = ctx;
    this.ball = { x: Nx / 2, y: Ny / 2, z: Nz / 2, vx: 0, vy: 0, vz: 0 };
    this.paddle1 = { x: Nx / 2, y: Ny / 2 };
    this.paddle2 = { x: Nx / 2, y: Ny / 2 };
    this.trail = [];
    this.serve(ctx);
  }

  serve(ctx) {
    const { Nx, Ny, Nz, params } = ctx;
    const speed = params?.ballSpeed ?? 7;
    this.ball.x = Nx / 2;
    this.ball.y = Ny / 2;
    this.ball.z = Nz / 2;
    // Random direction with strong Z component so the rally starts immediately.
    const angle = Math.random() * Math.PI * 2;
    this.ball.vx = Math.cos(angle) * speed * 0.35;
    this.ball.vy = (Math.random() - 0.5) * speed * 0.4;
    this.ball.vz = (Math.random() < 0.5 ? -1 : 1) * Math.sqrt(Math.max(0, speed * speed - this.ball.vx * this.ball.vx - this.ball.vy * this.ball.vy));
    this.trail.length = 0;
  }

  update(ctx) {
    const { dt, Nx, Ny, Nz, params } = ctx;
    const b = this.ball;

    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;

    // Reflect off the four side walls.
    if (b.x < 0)        { b.x = 0;        b.vx =  Math.abs(b.vx); }
    if (b.x > Nx - 1)   { b.x = Nx - 1;   b.vx = -Math.abs(b.vx); }
    if (b.y < 0)        { b.y = 0;        b.vy =  Math.abs(b.vy); }
    if (b.y > Ny - 1)   { b.y = Ny - 1;   b.vy = -Math.abs(b.vy); }

    const pSize = params.paddleSize;

    // Z faces — paddle hit or re-serve.
    if (b.z < 0) {
      const dx = b.x - this.paddle1.x;
      const dy = b.y - this.paddle1.y;
      if (Math.abs(dx) <= pSize && Math.abs(dy) <= pSize) {
        b.z = 0;
        b.vz = Math.abs(b.vz);
        b.vx += dx * params.english;
        b.vy += dy * params.english;
      } else {
        this.serve(ctx);
        return;
      }
    }
    if (b.z > Nz - 1) {
      const dx = b.x - this.paddle2.x;
      const dy = b.y - this.paddle2.y;
      if (Math.abs(dx) <= pSize && Math.abs(dy) <= pSize) {
        b.z = Nz - 1;
        b.vz = -Math.abs(b.vz);
        b.vx += dx * params.english;
        b.vy += dy * params.english;
      } else {
        this.serve(ctx);
        return;
      }
    }

    // Renormalise speed: lateral bounces+english can compound, and a too-slow
    // ball stalls the rally — so re-scale to the requested ball speed each step.
    const vmag = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
    if (vmag > 0.001) {
      const k = params.ballSpeed / vmag;
      b.vx *= k; b.vy *= k; b.vz *= k;
    }

    // Paddle AI: aim at predicted impact, move at speed-capped rate.
    // Cap = aiSkill × Nx voxels/sec (so a perfect player covers the face fast).
    const maxStep = params.aiSkill * Math.max(Nx, Ny) * dt;
    const stepTo = (paddle, tx, ty) => {
      const dx = tx - paddle.x;
      const dy = ty - paddle.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= maxStep) { paddle.x = tx; paddle.y = ty; }
      else { paddle.x += (dx / d) * maxStep; paddle.y += (dy / d) * maxStep; }
    };
    if (b.vz < 0) {
      const tImp = -b.z / b.vz;
      stepTo(this.paddle1, b.x + b.vx * tImp, b.y + b.vy * tImp);
    }
    if (b.vz > 0) {
      const tImp = (Nz - 1 - b.z) / b.vz;
      stepTo(this.paddle2, b.x + b.vx * tImp, b.y + b.vy * tImp);
    }
    this.paddle1.x = Math.max(0, Math.min(Nx - 1, this.paddle1.x));
    this.paddle1.y = Math.max(0, Math.min(Ny - 1, this.paddle1.y));
    this.paddle2.x = Math.max(0, Math.min(Nx - 1, this.paddle2.x));
    this.paddle2.y = Math.max(0, Math.min(Ny - 1, this.paddle2.y));

    this.trail.push(b.x, b.y, b.z);
    const max = params.trailLen * 3;
    if (this.trail.length > max) this.trail.splice(0, this.trail.length - max);
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, params, utils } = ctx;
    out.fill(0);

    const [r1, g1, b1] = utils.parseColor(params.paddle1Color);
    const [r2, g2, b2] = utils.parseColor(params.paddle2Color);
    const [br, bg, bb] = utils.parseColor(params.ballColor);
    const pSize = params.paddleSize | 0;

    // Paddles — flat squares on the back/front faces.
    for (let dy = -pSize; dy <= pSize; dy++) {
      for (let dx = -pSize; dx <= pSize; dx++) {
        const px1 = Math.round(this.paddle1.x + dx);
        const py1 = Math.round(this.paddle1.y + dy);
        if (px1 >= 0 && px1 < Nx && py1 >= 0 && py1 < Ny && Nz > 0) {
          const idx = (px1 * Ny + py1) * Nz + 0;
          out[idx * 3 + 0] = r1; out[idx * 3 + 1] = g1; out[idx * 3 + 2] = b1;
        }
        const px2 = Math.round(this.paddle2.x + dx);
        const py2 = Math.round(this.paddle2.y + dy);
        if (px2 >= 0 && px2 < Nx && py2 >= 0 && py2 < Ny && Nz > 0) {
          const idx = (px2 * Ny + py2) * Nz + (Nz - 1);
          out[idx * 3 + 0] = r2; out[idx * 3 + 1] = g2; out[idx * 3 + 2] = b2;
        }
      }
    }

    // Ball trail (oldest dim → newest bright).
    const tlen = this.trail.length / 3;
    for (let i = 0; i < tlen; i++) {
      const u = i / Math.max(1, tlen - 1); // 0=oldest, 1=newest
      const k = Math.pow(u, 1.8);
      splat(out, Nx, Ny, Nz, this.trail[i * 3], this.trail[i * 3 + 1], this.trail[i * 3 + 2],
            br * k, bg * k, bb * k);
    }
    splat(out, Nx, Ny, Nz, this.ball.x, this.ball.y, this.ball.z, br, bg, bb);
  }
}
