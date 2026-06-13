// Chrysanthemum Fireworks — huge color-graded shells with drooping trails.
//
// Distinct from particles/fireworks.js (which emits spherical puffs): a
// chrysanthemum shell bursts into a *ring* of primary shards travelling
// outward in a plane, and partway through their flight each primary fires
// its own tiny secondary burst. The result reads as the classic
// "flower-with-sparkles" Japanese fireworks shell.
//
// The signature of a real chrysanthemum is the long *drooping trail* each
// petal leaves behind — bright spark heads dragging glowing tails that bend
// over under gravity into a weeping dome. We get that by stamping every
// shard's recent path each frame (a sub-voxel splat chain), so the whole
// flower stays lit and the cube fills with a hanging willow of light rather
// than a few lonely dots. Shells are color-graded over their lifetime: a
// white-hot ignition flash cools through the petal's hue and dims toward
// smoky embers, the way a burning star fades as it falls.
//
// Ring plane normal is biased toward vertical so the petals fan outward
// (otherwise edge-on rings collapse to a line on screen).

export const params = {
  launchRate:   { type: 'range', min: 0.1, max: 3,  step: 0.05, default: 1.1 },
  primaries:    { type: 'int',   min: 6,   max: 36, default: 22, label: 'Primary shards' },
  secondaries:  { type: 'int',   min: 0,   max: 12, default: 6,  label: 'Secondary shards' },
  shellSize:    { type: 'range', min: 2,   max: 12, step: 0.1,   default: 6.0 },
  gravity:      { type: 'range', min: 0,   max: 12, step: 0.1,   default: 3.2 },
  trail:        { type: 'range', min: 0,   max: 1,  step: 0.01,  default: 0.85, label: 'Trail droop' },
  glow:         { type: 'range', min: 0.5, max: 2.5, step: 0.05, default: 1.4, label: 'Glow' },
  palette:      { type: 'select', options: ['rainbow', 'warm', 'cool', 'gold', 'emerald', 'ice'], default: 'rainbow' },
};

const PALETTES = {
  warm:    [[255, 80, 40],  [255, 180, 60],  [255, 240, 140]],
  cool:    [[100, 180, 255],[160, 100, 255], [80, 255, 220]],
  gold:    [[255, 220, 100],[255, 180, 60],  [255, 120, 30]],
  emerald: [[60, 255, 150], [160, 255, 120], [255, 255, 220]],
  ice:     [[150, 220, 255],[90, 150, 255],  [220, 240, 255]],
};

// Pick a saturated petal color. Rainbow draws from the full wheel; named
// palettes draw a hero hue. Returned color is the petal's mid-life tint —
// the renderer grades hotter (toward white) early and cooler (toward the
// hue, then dim) late.
function pickColor(palette, utils) {
  if (palette === 'rainbow') return utils.hsv(Math.random(), 0.9, 1);
  const pal = PALETTES[palette] ?? PALETTES.warm;
  return pal[(Math.random() * pal.length) | 0].slice();
}

// Additive trilinear splat — deposits (r,g,b)*weight into the 8 voxels
// surrounding a sub-voxel point. Clamped so bloom saturates cleanly.
function splat(out, Nx, Ny, Nz, x, y, z, r, g, b) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  for (let dx = 0; dx <= 1; dx++) {
    const wx = dx ? fx : 1 - fx;
    if (wx <= 0) continue;
    const xx = x0 + dx;
    if (xx < 0 || xx >= Nx) continue;
    for (let dy = 0; dy <= 1; dy++) {
      const wy = dy ? fy : 1 - fy;
      if (wy <= 0) continue;
      const yy = y0 + dy;
      if (yy < 0 || yy >= Ny) continue;
      for (let dz = 0; dz <= 1; dz++) {
        const wz = dz ? fz : 1 - fz;
        if (wz <= 0) continue;
        const zz = z0 + dz;
        if (zz < 0 || zz >= Nz) continue;
        const w = wx * wy * wz;
        const idx = ((xx * Ny + yy) * Nz + zz) * 3;
        const nr = out[idx]     + r * w;
        const ng = out[idx + 1] + g * w;
        const nb = out[idx + 2] + b * w;
        out[idx]     = nr > 255 ? 255 : nr;
        out[idx + 1] = ng > 255 ? 255 : ng;
        out[idx + 2] = nb > 255 ? 255 : nb;
      }
    }
  }
}

export default class ChrysanthemumFireworks {
  static name = 'Fireworks (Chrysanthemum)';

  setup() {
    this.rockets = [];
    this.primaries = [];
    this.secondaries = [];
    this.launchAcc = 0;
    // Drift a touch so the show never repeats exactly.
    this.seed = Math.random() * 1000;
  }

  launch(ctx) {
    const { Nx, Ny, Nz, params } = ctx;
    const halfX = (Nx - 1) / 2;
    const halfZ = (Nz - 1) / 2;
    const g = Math.max(0.05, params.gravity);
    // Burst high in the volume so the weeping trails have room to fall.
    const targetY = Ny * (0.62 + Math.random() * 0.3);
    const vy = Math.sqrt(2 * g * targetY);
    // Ring plane normal — biased toward vertical so the ring presents face-on.
    const nx = (Math.random() - 0.5) * 0.7;
    const ny = 0.78 + Math.random() * 0.22;
    const nz = (Math.random() - 0.5) * 0.7;
    const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    this.rockets.push({
      x: halfX + (Math.random() - 0.5) * Nx * 0.4,
      y: 0,
      z: halfZ + (Math.random() - 0.5) * Nz * 0.4,
      vx: (Math.random() - 0.5) * 0.6,
      vy,
      vz: (Math.random() - 0.5) * 0.6,
      hue: Math.random(),
      color: pickColor(params.palette, ctx.utils),
      normal: [nx / nlen, ny / nlen, nz / nlen],
      trail: [],
    });
  }

  burst(rocket, params) {
    // Two orthonormal tangents to the ring normal — pick the larger cross
    // product target to avoid a degenerate u when normal ≈ y.
    const [nx, ny, nz] = rocket.normal;
    let ux, uy, uz;
    if (Math.abs(ny) < 0.9) { ux = ny; uy = -nx; uz = 0; }
    else                    { ux = 0;  uy = -nz; uz = ny; }
    const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= ulen; uy /= ulen; uz /= ulen;
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;

    const speed = params.shellSize;
    const n = Math.max(3, params.primaries | 0);
    // A small radial spread in speed gives the shell a soft thick rim
    // instead of a razor ring — reads as a fuller, rounder flower.
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = ux * ca + vx * sa;
      const dy = uy * ca + vy * sa;
      const dz = uz * ca + vz * sa;
      const sp = speed * (0.86 + Math.random() * 0.28);
      this.primaries.push({
        x: rocket.x, y: rocket.y, z: rocket.z,
        vx: dx * sp, vy: dy * sp, vz: dz * sp,
        color: rocket.color,
        age: 0,
        life: 1.6 + Math.random() * 0.7,
        splitAt: 0.5 + Math.random() * 0.3,
        split: false,
        trail: [],
        flick: Math.random() * Math.PI * 2,
      });
    }
  }

  split(shard, params) {
    const n = Math.max(0, params.secondaries | 0);
    for (let i = 0; i < n; i++) {
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
        life: 0.4 + Math.random() * 0.35,
      });
    }
  }

  update(ctx) {
    const { dt, params, audio } = ctx;
    const g = params.gravity;

    // Beats add a little extra cadence — a finale flourish when the music hits.
    let rate = params.launchRate;
    if (audio && audio.beat) rate += 1.5;
    this.launchAcc += rate * dt;
    let guard = 0;
    while (this.launchAcc >= 1 && guard < 8) { this.launch(ctx); this.launchAcc -= 1; guard++; }
    if (this.launchAcc > 4) this.launchAcc = 0;

    // Trail droop controls how long the weeping tail persists.
    const trailLen = 6 + Math.round(params.trail * 12); // up to ~18 stamps

    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.vy -= g * dt;
      r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
      r.trail.push(r.x, r.y, r.z);
      if (r.trail.length > 12) r.trail.splice(0, 3);
      if (r.vy <= 0) { this.burst(r, params); this.rockets.splice(i, 1); }
    }

    for (let i = this.primaries.length - 1; i >= 0; i--) {
      const s = this.primaries[i];
      // Drag bleeds outward speed so petals slow and the trails droop down —
      // gravity then dominates and bends them into the willow shape.
      s.vy -= g * 0.55 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.vx *= 0.965; s.vz *= 0.965; s.vy *= 0.985;
      s.age += dt;
      // Record the drooping path for this frame's trail stamp.
      s.trail.push(s.x, s.y, s.z);
      while (s.trail.length > trailLen * 3) s.trail.splice(0, 3);
      if (!s.split && s.age / s.life >= s.splitAt) {
        s.split = true;
        if (params.secondaries > 0) this.split(s, params);
      }
      if (s.age > s.life) this.primaries.splice(i, 1);
    }

    for (let i = this.secondaries.length - 1; i >= 0; i--) {
      const s = this.secondaries[i];
      s.vy -= g * 0.6 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.age += dt;
      if (s.age > s.life) this.secondaries.splice(i, 1);
    }
  }

  // Grade a petal color across its life: white-hot ignition (t≈1) cooling
  // through the petal hue to a dim warm ember (t≈0). Returns scaled RGB
  // already multiplied by overall brightness `k`.
  static grade(out3, color, t, k, utils) {
    // t: 1 at birth -> 0 at death.
    const hot = utils.smoothstep(0.55, 1.0, t);   // ignition flash near birth
    const r = color[0], g = color[1], b = color[2];
    // Toward white when hot; toward the saturated hue mid-life.
    let cr = r + (255 - r) * hot;
    let cg = g + (255 - g) * hot;
    let cb = b + (255 - b) * hot;
    // Late life: drift slightly warmer (embers redden) as it dims.
    const ember = utils.smoothstep(0.35, 0.0, t);
    cr = cr + (255 - cr) * ember * 0.3;
    cg = cg * (1 - ember * 0.35);
    cb = cb * (1 - ember * 0.6);
    out3[0] = cr * k;
    out3[1] = cg * k;
    out3[2] = cb * k;
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, t, utils, params } = ctx;
    out.fill(0);
    const glow = params.glow;
    const tmp = [0, 0, 0];

    // Rockets — bright climbing head with a short hot trail.
    for (const r of this.rockets) {
      const [cr, cg, cb] = r.color;
      const head = 1.6 * glow;
      splat(out, Nx, Ny, Nz, r.x, r.y, r.z, 255, 230 * 0.9 + cg * 0.1, 180);
      splat(out, Nx, Ny, Nz, r.x, r.y, r.z, cr * head, cg * head, cb * head);
      const tr = r.trail;
      for (let j = tr.length - 3, w = 0.5; j >= 0; j -= 3, w *= 0.6) {
        splat(out, Nx, Ny, Nz, tr[j], tr[j + 1], tr[j + 2], cr * w, cg * w, cb * w);
      }
    }

    // Primaries — the weeping petals. Stamp the head plus the drooping
    // trail, fading along the tail so each petal reads as a glowing streak.
    for (const s of this.primaries) {
      const life = s.age / s.life;
      const tt = 1 - life;                       // 1 birth -> 0 death
      const headK = (0.35 + tt * 0.65) * glow;   // bright head, never fully dark mid-flight
      // Twinkle so heads shimmer like real sparks.
      const tw = 0.82 + 0.18 * Math.sin(t * 16 + s.flick);
      ChrysanthemumFireworks.grade(tmp, s.color, tt, headK * tw, utils);
      splat(out, Nx, Ny, Nz, s.x, s.y, s.z, tmp[0], tmp[1], tmp[2]);

      // Drooping tail: older samples sit further back and dimmer.
      const tr = s.trail;
      const segs = tr.length / 3;
      let w = 0.62;
      for (let j = tr.length - 6, n = 1; j >= 0; j -= 3, n++, w *= 0.74) {
        const tailK = headK * w;
        if (tailK < 0.02) break;
        // Tail keeps the petal hue (no ignition flash) so the streak is
        // colored, with the head as the hot tip.
        ChrysanthemumFireworks.grade(tmp, s.color, Math.max(0, tt - n * 0.04), tailK, utils);
        splat(out, Nx, Ny, Nz, tr[j], tr[j + 1], tr[j + 2], tmp[0], tmp[1], tmp[2]);
        if (segs > 14 && (n & 1)) continue; // thin very long trails for cost
      }
    }

    // Secondaries — the crackling sparkle accents. Flash bright then snap out.
    for (const s of this.secondaries) {
      const tt = 1 - s.age / s.life;
      const k = Math.min(1, tt * 1.4);
      const bright = k * k * glow * 1.3;
      const fl = 0.7 + 0.3 * Math.sin(t * 40 + s.x * 3 + s.z * 2);
      const b = bright * fl;
      splat(out, Nx, Ny, Nz, s.x, s.y, s.z,
            255 * b, (s.color[1] * 0.5 + 200) * b * 0.9, (s.color[2] * 0.4 + 160) * b * 0.8);
    }
  }
}
