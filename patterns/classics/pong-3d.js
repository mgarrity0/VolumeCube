// 3D Pong — a glowing plasma ball rallying between two luminous paddles on
// the Z faces, inside a softly-drawn court.
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
// SHOW-STOPPER treatment (default look, zero tuning):
//   - The ball is a HOT spherical core with a bloom halo, its hue drifting
//     and flaring brighter the faster it moves.
//   - A comet trail streams behind it, fading old→new and cooling in hue so
//     the motion through the volume reads instantly, including front-to-back.
//   - Paddles are emissive plates with a soft glow that bleeds one layer into
//     the court; the paddle the ball is heading toward "charges" brighter.
//   - A faint court: glowing cube edges + a dim center net plane give clear
//     depth cues so the 3D play space reads from across a room.
//   - Wall/paddle hits fire an expanding ring flash on the struck surface.
//
// Note: needs at least Nz≈4 to read as a real game (paddles occupy z=0 and
// z=Nz-1, so play space is Nz-2 layers thick). Degrades gracefully for thin
// volumes (Nz=1..3) — the court collapses but the ball + glow still read.

export const params = {
  ballSpeed:    { type: 'range', min: 2,   max: 20,  step: 0.5,  default: 8,    label: 'Ball speed (vox/sec)' },
  paddleSize:   { type: 'int',   min: 0,   max: 4,               default: 2,    label: 'Paddle half-size' },
  aiSkill:      { type: 'range', min: 0.1, max: 1.5, step: 0.05, default: 0.78, label: 'AI skill' },
  english:      { type: 'range', min: 0,   max: 2,   step: 0.05, default: 1.0,  label: 'Hit english' },
  trailLen:     { type: 'int',   min: 0,   max: 40,              default: 22,   label: 'Comet trail length' },
  glow:         { type: 'range', min: 0,   max: 2,   step: 0.05, default: 1.0,  label: 'Bloom / glow' },
  court:        { type: 'range', min: 0,   max: 1,   step: 0.02, default: 0.45, label: 'Court depth cues' },
  hueDrift:     { type: 'toggle', default: true,                                label: 'Drifting ball hue' },
  ballColor:    { type: 'color', default: '#ffe070' },
  paddle1Color: { type: 'color', default: '#ff3b5c' },
  paddle2Color: { type: 'color', default: '#3b9bff' },
};

// Additive soft splat with trilinear weighting into a buffer.
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

// Additive write to a single integer voxel (with bounds + clamp).
function addVox(out, Nx, Ny, Nz, x, y, z, r, g, b) {
  if (x < 0 || x >= Nx || y < 0 || y >= Ny || z < 0 || z >= Nz) return;
  const idx = (x * Ny + y) * Nz + z;
  out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r);
  out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g);
  out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b);
}

// Spherical glow: deposit a soft falloff sphere of given radius centered at
// (cx,cy,cz). brightness is the peak (center) intensity scaling [r,g,b] 0..1.
function glowSphere(out, Nx, Ny, Nz, cx, cy, cz, radius, r, g, b, brightness) {
  if (radius <= 0) return;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(Nx - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(Ny - 1, Math.ceil(cy + radius));
  const z0 = Math.max(0, Math.floor(cz - radius));
  const z1 = Math.min(Nz - 1, Math.ceil(cz + radius));
  const inv = 1 / radius;
  for (let x = x0; x <= x1; x++) {
    const dx = x - cx;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let z = z0; z <= z1; z++) {
        const dz = z - cz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) * inv;
        if (d >= 1) continue;
        // smooth falloff, slightly biased to a hot core
        const f = (1 - d) * (1 - d);
        const k = f * brightness;
        if (k <= 0) continue;
        addVox(out, Nx, Ny, Nz, x, y, z, r * k, g * k, b * k);
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
    this.trail = [];            // flat [x,y,z, x,y,z, ...] oldest→newest
    this.hue = 0.12;            // current ball hue (drifts on bounces)
    this.flashP1 = 0;           // paddle-1 impact flash energy (0..1)
    this.flashP2 = 0;           // paddle-2 impact flash energy
    this.flashWall = 0;         // side-wall impact flash energy
    this.flashWallX = Nx / 2;   // where the wall flash happened
    this.flashWallY = Ny / 2;
    this.flashWallZ = Nz / 2;
    this.serve(ctx);
  }

  serve(ctx) {
    const { Nx, Ny, Nz, params } = ctx;
    const speed = params?.ballSpeed ?? 8;
    this.ball.x = Nx / 2;
    this.ball.y = Ny / 2;
    this.ball.z = Nz / 2;
    // Random direction with strong Z component so the rally starts immediately.
    const angle = Math.random() * Math.PI * 2;
    this.ball.vx = Math.cos(angle) * speed * 0.35;
    this.ball.vy = (Math.random() - 0.5) * speed * 0.4;
    this.ball.vz = (Math.random() < 0.5 ? -1 : 1) *
      Math.sqrt(Math.max(0, speed * speed - this.ball.vx * this.ball.vx - this.ball.vy * this.ball.vy));
    this.trail.length = 0;
  }

  update(ctx) {
    const { dt, Nx, Ny, Nz, params, audio } = ctx;
    const b = this.ball;
    const step = Math.min(dt, 0.05); // guard huge dt (tab refocus) from tunneling

    // Decay impact flashes.
    const decay = Math.exp(-step * 4.5);
    this.flashP1 *= decay;
    this.flashP2 *= decay;
    this.flashWall *= decay;

    b.x += b.vx * step;
    b.y += b.vy * step;
    b.z += b.vz * step;

    // Reflect off the four side walls — record a flash where it struck.
    let wallHit = false;
    if (b.x < 0)        { b.x = 0;        b.vx =  Math.abs(b.vx); wallHit = true; }
    if (b.x > Nx - 1)   { b.x = Nx - 1;   b.vx = -Math.abs(b.vx); wallHit = true; }
    if (b.y < 0)        { b.y = 0;        b.vy =  Math.abs(b.vy); wallHit = true; }
    if (b.y > Ny - 1)   { b.y = Ny - 1;   b.vy = -Math.abs(b.vy); wallHit = true; }
    if (wallHit) {
      this.flashWall = 1;
      this.flashWallX = b.x; this.flashWallY = b.y; this.flashWallZ = b.z;
      this.hue = (this.hue + 0.04) % 1;
    }

    const pSize = params.paddleSize;
    const backZ = Math.max(0, Nz - 1);

    // Z faces — paddle hit or re-serve.
    if (b.z < 0) {
      const dx = b.x - this.paddle1.x;
      const dy = b.y - this.paddle1.y;
      if (Math.abs(dx) <= pSize && Math.abs(dy) <= pSize) {
        b.z = 0;
        b.vz = Math.abs(b.vz);
        b.vx += dx * params.english;
        b.vy += dy * params.english;
        this.flashP1 = 1;
        this.hue = (this.hue + 0.09) % 1;
      } else {
        this.serve(ctx);
        return;
      }
    }
    if (b.z > backZ) {
      const dx = b.x - this.paddle2.x;
      const dy = b.y - this.paddle2.y;
      if (Math.abs(dx) <= pSize && Math.abs(dy) <= pSize) {
        b.z = backZ;
        b.vz = -Math.abs(b.vz);
        b.vx += dx * params.english;
        b.vy += dy * params.english;
        this.flashP2 = 1;
        this.hue = (this.hue + 0.09) % 1;
      } else {
        this.serve(ctx);
        return;
      }
    }

    // Renormalise speed: lateral bounces+english can compound, and a too-slow
    // ball stalls the rally — so re-scale to the requested ball speed each step.
    // A beat gives a brief speed kick for extra life when audio is present.
    const targetSpeed = params.ballSpeed * (1 + 0.25 * (audio?.beat ? 1 : 0));
    const vmag = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
    if (vmag > 0.001) {
      const k = targetSpeed / vmag;
      b.vx *= k; b.vy *= k; b.vz *= k;
    }

    // Paddle AI: aim at predicted impact, move at speed-capped rate.
    // Cap = aiSkill × max(Nx,Ny) voxels/sec.
    const maxStep = params.aiSkill * Math.max(Nx, Ny) * step;
    const stepTo = (paddle, tx, ty) => {
      const dx = tx - paddle.x;
      const dy = ty - paddle.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= maxStep || d < 1e-6) { paddle.x = tx; paddle.y = ty; }
      else { paddle.x += (dx / d) * maxStep; paddle.y += (dy / d) * maxStep; }
    };
    if (b.vz < 0) {
      const tImp = b.vz < -1e-6 ? -b.z / b.vz : 0;
      stepTo(this.paddle1, b.x + b.vx * tImp, b.y + b.vy * tImp);
    }
    if (b.vz > 0) {
      const tImp = b.vz > 1e-6 ? (backZ - b.z) / b.vz : 0;
      stepTo(this.paddle2, b.x + b.vx * tImp, b.y + b.vy * tImp);
    }
    this.paddle1.x = Math.max(0, Math.min(Nx - 1, this.paddle1.x));
    this.paddle1.y = Math.max(0, Math.min(Ny - 1, this.paddle1.y));
    this.paddle2.x = Math.max(0, Math.min(Nx - 1, this.paddle2.x));
    this.paddle2.y = Math.max(0, Math.min(Ny - 1, this.paddle2.y));

    this.trail.push(b.x, b.y, b.z);
    const max = Math.max(0, params.trailLen) * 3;
    if (this.trail.length > max) this.trail.splice(0, this.trail.length - max);
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, t, params, utils, audio } = ctx;
    out.fill(0);

    const N = Math.max(Nx, Ny, Nz);
    const glow = params.glow ?? 1;
    const courtAmt = params.court ?? 0.45;
    const backZ = Math.max(0, Nz - 1);

    // Speed → "heat": fraction of the slider range the ball is moving at.
    const b = this.ball;
    const vmag = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
    const heat = utils.clamp((vmag - 2) / 18, 0, 1); // 0 slow … 1 fast

    // Ball color: drifting hue if enabled, else the chosen ballColor, pushed
    // toward white-hot as speed rises so a fast rally flares.
    let baseBall;
    if (params.hueDrift) {
      baseBall = utils.hsv((this.hue + 0.02 * Math.sin(t * 0.7)) % 1, 0.55 - 0.35 * heat, 1);
    } else {
      baseBall = utils.parseColor(params.ballColor);
    }
    const [br, bg, bb] = baseBall;

    const [r1, g1, b1] = utils.parseColor(params.paddle1Color);
    const [r2, g2, b2] = utils.parseColor(params.paddle2Color);
    const pSize = params.paddleSize | 0;

    // --- COURT: glowing cube edges + dim center net plane (depth cues) ---
    if (courtAmt > 0 && N > 1) {
      // Pulsing edge brightness, very dim so the ball stays the hero.
      const edgePulse = 0.5 + 0.5 * Math.sin(t * 0.6);
      const edgeBase = courtAmt * (18 + 10 * edgePulse);
      const ex = Nx - 1, ey = Ny - 1, ez = Nz - 1;
      const isEdge = (x, y, z) => {
        let onB = 0;
        if (x === 0 || x === ex) onB++;
        if (y === 0 || y === ey) onB++;
        if (z === 0 || z === ez) onB++;
        return onB >= 2;
      };
      // Cool cyan-ish court frame; mix the two paddle hues across Z for depth.
      for (let x = 0; x < Nx; x++) {
        for (let y = 0; y < Ny; y++) {
          for (let z = 0; z < Nz; z++) {
            if (!isEdge(x, y, z)) continue;
            const zf = Nz > 1 ? z / (Nz - 1) : 0; // 0 front … 1 back
            const cr = r1 * (1 - zf) + r2 * zf;
            const cg = g1 * (1 - zf) + g2 * zf;
            const cb = b1 * (1 - zf) + b2 * zf;
            const m = edgeBase / 255;
            addVox(out, Nx, Ny, Nz, x, y, z, cr * m, cg * m, cb * m);
          }
        }
      }
      // Center net: faint plane at mid-Z (only if there's real depth).
      if (Nz >= 4) {
        const zc = (Nz - 1) / 2;
        const z0 = Math.floor(zc), z1 = Math.ceil(zc);
        const netShimmer = courtAmt * 14;
        for (let x = 0; x < Nx; x++) {
          for (let y = 0; y < Ny; y++) {
            // checker so the net reads as a grid, not a fill
            if (((x + y) & 1) === 0) continue;
            const tw = 0.6 + 0.4 * Math.sin(t * 1.3 + (x - y) * 0.5);
            const v = (netShimmer * tw) / 255;
            const wf = z1 === z0 ? 1 : (zc - z0);
            addVox(out, Nx, Ny, Nz, x, y, z0, 60 * v, 130 * v, 150 * v);
            if (z1 !== z0) addVox(out, Nx, Ny, Nz, x, y, z1, 60 * v * wf, 130 * v * wf, 150 * v * wf);
          }
        }
      }
    }

    // --- PADDLES: emissive plates + soft halo bleeding into the court ---
    // The paddle the ball heads toward "charges" brighter.
    const charge1 = b.vz < 0 ? 1 : 0.55;
    const charge2 = b.vz > 0 ? 1 : 0.55;
    const drawPaddle = (px, py, z, r, g, cb, charge, flash) => {
      const halo = 1 + Math.max(0, Math.round(glow)); // extra ring of glow voxels
      for (let dy = -pSize - halo; dy <= pSize + halo; dy++) {
        for (let dx = -pSize - halo; dx <= pSize + halo; dx++) {
          const x = Math.round(px) + dx;
          const y = Math.round(py) + dy;
          if (x < 0 || x >= Nx || y < 0 || y >= Ny) continue;
          const onPlate = Math.abs(dx) <= pSize && Math.abs(dy) <= pSize;
          // distance outside the plate (0 on plate, grows into halo)
          const ox = Math.max(0, Math.abs(dx) - pSize);
          const oy = Math.max(0, Math.abs(dy) - pSize);
          const od = Math.sqrt(ox * ox + oy * oy);
          let bright;
          if (onPlate) {
            bright = (0.75 + 0.25 * charge) + flash * 0.6;
          } else {
            const fall = Math.max(0, 1 - od / (halo + 0.5));
            bright = (0.45 + 0.3 * charge) * fall * fall * glow;
          }
          if (bright <= 0) continue;
          // Set the plate face; halo bleeds toward interior z too.
          addVox(out, Nx, Ny, Nz, x, y, z, r * bright, g * bright, cb * bright);
          // Bleed one layer into the court for a volumetric plate.
          if (Nz > 1 && glow > 0) {
            const iz = z === 0 ? 1 : Nz - 2;
            const bleed = bright * 0.35 * glow;
            addVox(out, Nx, Ny, Nz, x, y, iz, r * bleed, g * bleed, cb * bleed);
          }
        }
      }
    };
    drawPaddle(this.paddle1.x, this.paddle1.y, 0,    r1, g1, b1, charge1, this.flashP1);
    drawPaddle(this.paddle2.x, this.paddle2.y, backZ, r2, g2, b2, charge2, this.flashP2);

    // Paddle impact ring flash: expanding bright ring on the struck face.
    const drawRing = (px, py, z, flash, r, g, cb) => {
      if (flash <= 0.02) return;
      const age = 1 - flash;            // 0 fresh … 1 old
      const ringR = age * (pSize + 3);  // expands outward
      const thick = 1.2;
      for (let dy = -Math.ceil(ringR) - 1; dy <= Math.ceil(ringR) + 1; dy++) {
        for (let dx = -Math.ceil(ringR) - 1; dx <= Math.ceil(ringR) + 1; dx++) {
          const x = Math.round(px) + dx, y = Math.round(py) + dy;
          if (x < 0 || x >= Nx || y < 0 || y >= Ny) continue;
          const d = Math.sqrt(dx * dx + dy * dy);
          const onRing = Math.exp(-((d - ringR) * (d - ringR)) / (thick * thick));
          const k = onRing * flash * 1.4;
          if (k <= 0.01) continue;
          // ring is bright white-hot tinted with paddle color
          addVox(out, Nx, Ny, Nz, x, y, z, 200 * k + r * 0.2 * k, 200 * k + g * 0.2 * k, 210 * k + cb * 0.2 * k);
        }
      }
    };
    drawRing(this.paddle1.x, this.paddle1.y, 0,    this.flashP1, r1, g1, b1);
    drawRing(this.paddle2.x, this.paddle2.y, backZ, this.flashP2, r2, g2, b2);

    // Side-wall impact flash — a quick bright bloom where the ball struck.
    if (this.flashWall > 0.03) {
      const wr = (0.8 + 0.6 * heat) * this.flashWall;
      glowSphere(out, Nx, Ny, Nz, this.flashWallX, this.flashWallY, this.flashWallZ,
        1.4, 255, 255, 255, wr);
    }

    // --- COMET TRAIL: fades old→new, cools in hue, thins toward the tail ---
    const tlen = this.trail.length / 3;
    for (let i = 0; i < tlen; i++) {
      const u = tlen > 1 ? i / (tlen - 1) : 1; // 0 oldest … 1 newest
      const fade = Math.pow(u, 1.7);           // bright near the head
      // cool the tail toward the ball hue's neighbor for a plasma streak
      let tr, tg, tb;
      if (params.hueDrift) {
        const th = (this.hue + 0.02 * Math.sin(t * 0.7) - (1 - u) * 0.12 + 1) % 1;
        [tr, tg, tb] = utils.hsv(th, 0.8, 1);
      } else {
        tr = br; tg = bg; tb = bb;
      }
      const radius = 0.6 + 1.1 * fade * (0.6 + 0.4 * glow);
      const bright = (0.10 + 0.55 * fade) * (0.7 + 0.6 * glow);
      glowSphere(out, Nx, Ny, Nz,
        this.trail[i * 3], this.trail[i * 3 + 1], this.trail[i * 3 + 2],
        radius, tr, tg, tb, bright);
    }

    // --- BALL: hot core + bloom halo, flaring with speed and on beats ---
    const beatPop = audio?.beat ? 0.35 : 0;
    const haloR = (1.6 + 1.6 * glow) * (0.85 + 0.35 * heat) + beatPop;
    const coreR = 0.85 + 0.5 * heat;
    // Outer bloom halo (colored).
    glowSphere(out, Nx, Ny, Nz, b.x, b.y, b.z, haloR, br, bg, bb,
      (0.45 + 0.35 * heat) * (0.6 + 0.7 * glow) + beatPop);
    // Inner hot core — pushed toward white so it reads as a blazing center.
    const cr = Math.min(255, br * 0.4 + 200);
    const cg = Math.min(255, bg * 0.4 + 200);
    const cb2 = Math.min(255, bb * 0.4 + 190);
    glowSphere(out, Nx, Ny, Nz, b.x, b.y, b.z, coreR, cr, cg, cb2, 1.0 + 0.4 * heat);
    // Dead-center pixel: full white-hot point.
    addVox(out, Nx, Ny, Nz, Math.round(b.x), Math.round(b.y), Math.round(b.z), 255, 255, 245);
  }
}
