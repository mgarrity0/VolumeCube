// Fireworks — glowing rockets arc upward trailing sparks, then detonate into
// big radial shells that bloom, drift, and rain down as fading embers.
//
// Three particle states drive the identity:
//   'rocket'  arcs up with a bright head + a comet trail of fading sparks,
//   'shard'   the burst — a dense spherical shell that expands, glows hot at
//             the core, then cools through its palette color and gutters out,
//   'ember'   slow glittering fragments that keep falling after the shell fades.
//
// Everything is deposited with a soft radial glow splat (additive, sub-voxel)
// so heads bloom into their neighbors the way real bloom reads on the cube.
// A flash of light fills the volume at the instant of each detonation.

export const params = {
  launchRate: { type: 'range', min: 0.2, max: 5,  step: 0.05, default: 2.2, label: 'Launch Rate' },
  shellSize:  { type: 'range', min: 2,   max: 12, step: 0.1,  default: 6.5, label: 'Shell Size' },
  gravity:    { type: 'range', min: 0,   max: 15, step: 0.1,  default: 5.5, label: 'Gravity' },
  glow:       { type: 'range', min: 0.6, max: 2.5, step: 0.05, default: 1.5, label: 'Glow' },
  trails:     { type: 'toggle', default: true,  label: 'Comet Trails' },
  palette:    { type: 'select', options: ['mixed', 'warm', 'cool', 'mono', 'rainbow'], default: 'mixed' },
};

const PAL = {
  mixed:   [[255, 70, 70], [255, 200, 60], [70, 170, 255], [190, 80, 255], [70, 255, 150], [255, 110, 200]],
  warm:    [[255, 70, 50], [255, 150, 40], [255, 220, 120], [255, 100, 30]],
  cool:    [[70, 150, 255], [150, 80, 255], [60, 255, 220], [120, 220, 255]],
  mono:    [[255, 255, 255], [210, 220, 255], [255, 240, 210]],
  rainbow: null, // generated per-shell from a hue
};

// Soft glowing splat: deposits a small radial kernel (radius ~1.4 voxels) of
// additive light around a sub-voxel position. The falloff is smooth so heads
// bloom instead of looking like single hard pixels.
function glowSplat(out, Nx, Ny, Nz, x, y, z, r, g, b, rad) {
  const x0 = Math.floor(x - rad), x1 = Math.floor(x + rad);
  const y0 = Math.floor(y - rad), y1 = Math.floor(y + rad);
  const z0 = Math.floor(z - rad), z1 = Math.floor(z + rad);
  const inv = 1 / (rad * rad);
  for (let xx = x0; xx <= x1; xx++) {
    if (xx < 0 || xx >= Nx) continue;
    const ddx = (xx - x) * (xx - x);
    for (let yy = y0; yy <= y1; yy++) {
      if (yy < 0 || yy >= Ny) continue;
      const ddy = (yy - y) * (yy - y);
      for (let zz = z0; zz <= z1; zz++) {
        if (zz < 0 || zz >= Nz) continue;
        const d2 = ddx + ddy + (zz - z) * (zz - z);
        // Smooth quadratic falloff to zero at the kernel edge.
        let w = 1 - d2 * inv;
        if (w <= 0) continue;
        w *= w; // sharpen the core, soften the halo
        const idx = ((xx * Ny + yy) * Nz + zz) * 3;
        const a = out[idx] + r * w; out[idx] = a > 255 ? 255 : a;
        const c = out[idx + 1] + g * w; out[idx + 1] = c > 255 ? 255 : c;
        const e = out[idx + 2] + b * w; out[idx + 2] = e > 255 ? 255 : e;
      }
    }
  }
}

export default class Fireworks {
  static name = 'Fireworks';

  setup() {
    this.rockets = [];
    this.shards = [];
    this.embers = [];
    this.launchAcc = 0;
    this.flash = 0;        // global detonation flash, decays each frame
    this.flashColor = [255, 255, 255];
  }

  // Pick a shell color. Rainbow rotates the hue over time for a hue journey.
  shellColor(ctx) {
    const p = ctx.params.palette;
    if (p === 'rainbow') {
      const h = (ctx.t * 0.13 + Math.random() * 0.25) % 1;
      return ctx.utils.hsv(h, 0.85, 1);
    }
    const pal = PAL[p] ?? PAL.mixed;
    return pal[(Math.random() * pal.length) | 0];
  }

  launch(ctx) {
    const { Nx, Ny, Nz, params } = ctx;
    const color = this.shellColor(ctx);
    const halfX = (Nx - 1) / 2;
    const halfZ = (Nz - 1) / 2;
    // Aim the apex high in the volume so bursts fill the upper cube.
    const targetY = Math.max(1, Ny * (0.6 + Math.random() * 0.32));
    const vy = Math.sqrt(2 * params.gravity * targetY) || targetY;
    const spread = 0.6;
    this.rockets.push({
      x: halfX + (Math.random() - 0.5) * Nx * 0.45,
      y: 0,
      z: halfZ + (Math.random() - 0.5) * Nz * 0.45,
      vx: (Math.random() - 0.5) * spread,
      vy,
      vz: (Math.random() - 0.5) * spread,
      color,
      trail: [],
      twinkle: Math.random() * 6.283,
    });
  }

  burst(rocket, ctx) {
    const { params } = ctx;
    const minDim = Math.max(2, Math.min(ctx.Nx, ctx.Ny, ctx.Nz));
    // Scale particle count to the rig — dense enough to read as a full shell.
    const COUNT = Math.round(46 + minDim * 6);
    const baseSpeed = params.shellSize;
    for (let i = 0; i < COUNT; i++) {
      // Even-ish unit-sphere distribution.
      const u = 2 * Math.random() - 1;
      const phi = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const sx = s * Math.cos(phi);
      const sy = u;
      const sz = s * Math.sin(phi);
      // A spread of speeds gives the shell thickness instead of a thin ring.
      const speed = baseSpeed * (0.45 + Math.random() * 0.75);
      this.shards.push({
        x: rocket.x, y: rocket.y, z: rocket.z,
        vx: sx * speed, vy: sy * speed, vz: sz * speed,
        color: rocket.color,
        age: 0,
        life: 1.0 + Math.random() * 0.9,
        flick: Math.random() * 6.283,
      });
    }
    // Trailing embers that linger and rain down after the shell dies.
    const EM = Math.round(COUNT * 0.4);
    for (let i = 0; i < EM; i++) {
      const u = 2 * Math.random() - 1;
      const phi = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const speed = baseSpeed * (0.15 + Math.random() * 0.4);
      this.embers.push({
        x: rocket.x, y: rocket.y, z: rocket.z,
        vx: s * Math.cos(phi) * speed,
        vy: u * speed,
        vz: s * Math.sin(phi) * speed,
        color: rocket.color,
        age: 0,
        life: 2.0 + Math.random() * 1.8,
        flick: Math.random() * 6.283,
      });
    }
    // Detonation flash — a sharp transient, not a sustained fill.
    this.flash = Math.min(1.0, this.flash + 0.7);
    this.flashColor = rocket.color;
  }

  update(ctx) {
    const { dt, Nx, Ny, Nz, params } = ctx;
    // Clamp dt so a hitch (tab refocus) can't fling particles out of the volume.
    const h = Math.min(dt, 0.05);
    const g = params.gravity;

    // Audio gives launches a kick on the beat without requiring audio to run.
    const beatBoost = (ctx.audio && ctx.audio.beat) ? 2 : 0;
    this.launchAcc += (params.launchRate + beatBoost * params.launchRate) * h;
    let guard = 0;
    while (this.launchAcc >= 1 && guard++ < 8) {
      this.launch(ctx);
      this.launchAcc -= 1;
    }

    // Rockets: arc up, shed a comet trail, detonate at apex.
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      if (params.trails) {
        r.trail.push(r.x, r.y, r.z);
        if (r.trail.length > 21) r.trail.splice(0, 3); // keep ~7 points
      }
      r.vy -= g * h;
      r.x += r.vx * h; r.y += r.vy * h; r.z += r.vz * h;
      if (r.vy <= 0 || r.y >= Ny - 0.5) {
        this.burst(r, ctx);
        this.rockets.splice(i, 1);
      }
    }

    // Shards: expand, slow via drag, fall under reduced gravity.
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.vy -= g * 0.35 * h;
      s.x += s.vx * h; s.y += s.vy * h; s.z += s.vz * h;
      const drag = 0.97;
      s.vx *= drag; s.vy *= drag; s.vz *= drag;
      s.age += h;
      if (s.age > s.life) this.shards.splice(i, 1);
    }

    // Embers: heavier gravity, slow drift, twinkle out.
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i];
      e.vy -= g * 0.6 * h;
      e.x += e.vx * h; e.y += e.vy * h; e.z += e.vz * h;
      e.vx *= 0.985; e.vz *= 0.985;
      e.age += h;
      if (e.age > e.life || e.y < -1) this.embers.splice(i, 1);
    }

    // Decay the global flash fast so it reads as a momentary snap, then dark.
    this.flash *= Math.pow(0.0008, h); // very fast exponential fade (~1/8 per frame)

    // Safety cap so the arrays never grow unbounded under extreme params.
    if (this.shards.length > 4000) this.shards.splice(0, this.shards.length - 4000);
    if (this.embers.length > 4000) this.embers.splice(0, this.embers.length - 4000);
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, t } = ctx;
    out.fill(0);
    const glow = ctx.params.glow;
    const minDim = Math.max(2, Math.min(Nx, Ny, Nz));
    // Kernel radius scales gently with rig size; clamp so tiny Nz still works.
    const headRad = Math.max(1.2, minDim * 0.16);
    const sparkRad = Math.max(1.0, minDim * 0.12);

    // --- Detonation flash: a brief tinted volume-fill that snaps then fades. ---
    if (this.flash > 0.04) {
      const f = this.flash * this.flash * 22 * glow;
      // Tint toward the shell color (small white floor so it still pops bright).
      const ar = f * (0.2 + 0.8 * this.flashColor[0] / 255);
      const ag = f * (0.2 + 0.8 * this.flashColor[1] / 255);
      const ab = f * (0.2 + 0.8 * this.flashColor[2] / 255);
      for (let k = 0; k < out.length; k += 3) {
        let v = out[k] + ar; out[k] = v > 255 ? 255 : v;
        v = out[k + 1] + ag; out[k + 1] = v > 255 ? 255 : v;
        v = out[k + 2] + ab; out[k + 2] = v > 255 ? 255 : v;
      }
    }

    // --- Rockets: comet trail (oldest dim -> newest bright) + hot head. ---
    for (const r of this.rockets) {
      const c = r.color;
      const tw = 0.75 + 0.25 * Math.sin(t * 30 + r.twinkle);
      const n = r.trail.length / 3;
      for (let j = 0; j < n; j++) {
        const k = (j + 1) / n;          // 0..1, newest brightest
        const b = k * k * 90 * glow;
        glowSplat(out, Nx, Ny, Nz, r.trail[j * 3], r.trail[j * 3 + 1], r.trail[j * 3 + 2],
          (200 + c[0] * 0.2) * b / 255, (180 + c[1] * 0.2) * b / 255, (120 + c[2] * 0.2) * b / 255,
          sparkRad * 0.85);
      }
      // White-hot head with a hint of the shell color.
      const hb = 230 * glow * tw;
      glowSplat(out, Nx, Ny, Nz, r.x, r.y, r.z,
        (220 + c[0] * 0.15), (200 + c[1] * 0.2), (150 + c[2] * 0.25),
        headRad);
      // tiny over-bright core
      glowSplat(out, Nx, Ny, Nz, r.x, r.y, r.z, hb, hb, hb, headRad * 0.45);
    }

    // --- Shards: hot white core early, cools to palette color, fades out. ---
    for (const s of this.shards) {
      const life = s.age / s.life;       // 0..1
      const fade = 1 - life;
      const k = fade * fade;             // brightness envelope
      // Heat: bright/white right after the burst, cooling to the shell color.
      const heat = Math.max(0, 1 - life * 2.2);
      const flick = 0.7 + 0.3 * Math.sin(t * 24 + s.flick);
      const amp = k * 255 * glow * flick;
      const r = (s.color[0] * (1 - heat) + 255 * heat) * amp / 255;
      const g = (s.color[1] * (1 - heat) + 245 * heat) * amp / 255;
      const b = (s.color[2] * (1 - heat) + 220 * heat) * amp / 255;
      glowSplat(out, Nx, Ny, Nz, s.x, s.y, s.z, r, g, b, sparkRad);
    }

    // --- Embers: dim glittering motes, twinkle as they rain down. ---
    for (const e of this.embers) {
      const fade = 1 - e.age / e.life;
      const flick = 0.45 + 0.55 * Math.max(0, Math.sin(t * 18 + e.flick));
      const amp = fade * fade * 150 * glow * flick;
      glowSplat(out, Nx, Ny, Nz, e.x, e.y, e.z,
        e.color[0] * amp / 255, e.color[1] * amp / 255, e.color[2] * amp / 255,
        sparkRad * 0.7);
    }
  }
}
