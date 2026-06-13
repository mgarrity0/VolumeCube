// Fireflies — a swarm of warm glowing points wandering a dark night volume.
//
// Each firefly drifts on smooth 3D-noise-driven paths (a curl-ish flow so it
// never travels in a straight line) and blinks on its own slow phase, fading
// softly in and out. Fireflies loosely SYNC: each nudges its blink phase
// toward the swarm's average, so blinks drift in and out of unison the way
// real Photinus fireflies do. A gentle pull toward a slowly-roaming center
// keeps the swarm cohesive. Each blink is rendered as a soft warm glow orb
// (radial falloff splatted into a small voxel neighborhood) with a hot core,
// so through bloom they read as floating embers in deep darkness.

export const params = {
  count:     { type: 'int',   min: 4,   max: 80,  default: 26,  label: 'Fireflies' },
  speed:     { type: 'range', min: 0,   max: 3,   step: 0.01, default: 1.0,  label: 'Drift speed' },
  glow:      { type: 'range', min: 0.4, max: 3,   step: 0.01, default: 1.45, label: 'Glow size' },
  blinkRate: { type: 'range', min: 0.05, max: 2,  step: 0.01, default: 0.5,  label: 'Blink rate' },
  sync:      { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.45, label: 'Sync' },
  cohesion:  { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.3,  label: 'Cohesion' },
  warm:      { type: 'color', default: '#ffcf4a', label: 'Glow color' },
  brightness:{ type: 'range', min: 0.3, max: 2,   step: 0.01, default: 1.0,  label: 'Brightness' },
};

const TAU = Math.PI * 2;

export default class Fireflies {
  static name = 'Fireflies';

  setup(ctx) {
    const { Nx, Ny, Nz, params } = ctx;
    this.t = 0;
    this.flies = [];
    const target = Math.max(1, Math.round(params.count));
    for (let i = 0; i < target; i++) this.flies.push(this.newFly(Nx, Ny, Nz, i, target));
  }

  newFly(Nx, Ny, Nz, seed, total) {
    return {
      x: Math.random() * Math.max(1, Nx - 1),
      y: Math.random() * Math.max(1, Ny - 1),
      z: Math.random() * Math.max(1, Nz - 1),
      // independent sampling offsets into the noise field per axis/fly
      seed: (seed + 0.5) * 13.37 + Math.random() * 7.0,
      // own blink clock + speed; staggered phases so the swarm shimmers
      phase: Math.random() * TAU,
      blinkSpeed: 0.65 + Math.random() * 0.7,
      // warmth jitter: some fireflies a touch greener-yellow, some amber
      hueJit: (Math.random() - 0.5) * 0.06,
      // glow scale jitter so the swarm has depth (near/far reads)
      sizeJit: 0.7 + Math.random() * 0.6,
    };
  }

  update(ctx) {
    const { dt, Nx, Ny, Nz, params, utils } = ctx;
    const noise = utils.noise3d;
    this.t += dt;
    const t = this.t;

    // Resize pool to current count.
    const target = Math.max(1, Math.round(params.count));
    while (this.flies.length < target) this.flies.push(this.newFly(Nx, Ny, Nz, this.flies.length, target));
    while (this.flies.length > target) this.flies.pop();

    const spanX = Math.max(1, Nx - 1);
    const spanY = Math.max(1, Ny - 1);
    const spanZ = Math.max(1, Nz - 1);

    // Roaming swarm center: a slow noise-wandered attractor point.
    const cx = (0.5 + 0.42 * noise(t * 0.05, 11.2, 0.0)) * spanX;
    const cy = (0.5 + 0.40 * noise(2.0, t * 0.055, 7.3)) * spanY;
    const cz = (0.5 + 0.42 * noise(5.1, 1.4, t * 0.05)) * spanZ;

    // Mean blink phase (circular mean) for loose synchronization.
    let sx = 0, sy = 0;
    for (const f of this.flies) { sx += Math.cos(f.phase); sy += Math.sin(f.phase); }
    const meanPhase = Math.atan2(sy, sx);

    const drift = params.speed;
    const blink = params.blinkRate;
    const syncK = params.sync;
    const cohK = params.cohesion;
    const nScale = 0.22; // spatial frequency of the flow field

    for (const f of this.flies) {
      // --- Smooth noise-driven velocity (a divergence-light flow) ---
      const nx = f.x * nScale, ny = f.y * nScale, nz = f.z * nScale;
      const s = f.seed;
      // Sample three decorrelated noise fields, then build a swirl by
      // cross-mixing so paths curve rather than run straight.
      const a = noise(nx + s, ny, nz + t * 0.18);
      const b = noise(ny - s, nz, nx - t * 0.16);
      const c = noise(nz + s * 0.5, nx, ny + t * 0.2);
      let vx = (a - c) * 1.3;
      let vy = (b - a) * 1.3 + 0.12; // faint upward bias, fireflies hover/rise
      let vz = (c - b) * 1.3;

      // --- Cohesion: gentle pull toward the roaming center ---
      vx += (cx - f.x) * 0.12 * cohK;
      vy += (cy - f.y) * 0.12 * cohK;
      vz += (cz - f.z) * 0.12 * cohK;

      const v = drift * dt * 2.2;
      f.x += vx * v;
      f.y += vy * v;
      f.z += vz * v;

      // Soft reflecting bounds so they linger inside the volume.
      f.x = reflect(f.x, spanX);
      f.y = reflect(f.y, spanY);
      f.z = reflect(f.z, spanZ);

      // --- Blink phase advance + loose phase attraction toward mean ---
      f.phase += blink * f.blinkSpeed * dt * TAU;
      if (syncK > 0) {
        let d = meanPhase - f.phase;
        // shortest angular distance
        d = Math.atan2(Math.sin(d), Math.cos(d));
        f.phase += d * syncK * dt * 1.6;
      }
      if (f.phase > 1e6) f.phase -= 1e6; // keep finite over long runs
    }
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, params, utils } = ctx;
    out.fill(0);

    const [wr, wg, wb] = utils.parseColor(params.warm);
    const bright = params.brightness;
    // Glow radius in voxels (scaled to the cube size, min ~1).
    const baseR = params.glow * Math.max(1, ctx.N * 0.12);

    for (const f of this.flies) {
      // Blink intensity: a sharp-ish flash that fades out, on the firefly's
      // own phase. Use a raised cosine to the power for a hot pop + soft tail.
      let lum = 0.5 + 0.5 * Math.cos(f.phase);   // 0..1, peaks at phase ~ 0
      lum = Math.pow(lum, 2.4);                  // crisp flash, dark between
      if (lum < 0.012) continue;                 // off: sculpt dark space

      const intensity = lum * bright;
      const r = baseR * f.sizeJit;
      const rInt = Math.max(1, Math.ceil(r));
      const inv2 = 1 / (r * r);

      // Per-firefly warm tint: amber core, slight hue jitter, hot near peak.
      // Hotter blinks push toward white at the core for a glowing ember look.
      const heat = lum; // 0..1
      const cr = wr + (255 - wr) * heat * 0.55;
      // hue jitter shifts green a touch; clamp so the tint never goes negative
      const cg = Math.max(0, wg + (255 - wg) * heat * 0.35 + f.hueJit * 60);
      const cb = wb + heat * heat * 110;          // subtle bluish-white hot core

      const x0 = Math.floor(f.x), y0 = Math.floor(f.y), z0 = Math.floor(f.z);

      for (let dx = -rInt; dx <= rInt; dx++) {
        const x = x0 + dx;
        if (x < 0 || x >= Nx) continue;
        const ddx = (x + 0.5) - (f.x + 0.5);
        for (let dy = -rInt; dy <= rInt; dy++) {
          const y = y0 + dy;
          if (y < 0 || y >= Ny) continue;
          const ddy = (y + 0.5) - (f.y + 0.5);
          for (let dz = -rInt; dz <= rInt; dz++) {
            const z = z0 + dz;
            if (z < 0 || z >= Nz) continue;
            const ddz = (z + 0.5) - (f.z + 0.5);

            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            const q = d2 * inv2;        // 0 at center, 1 at radius
            if (q >= 1) continue;
            // Smooth radial falloff with a bright concentrated core.
            let fall = 1 - q;
            fall = fall * fall;          // soft edge
            const core = fall * fall;    // extra punch in the middle
            const w = (fall * 0.45 + core * 1.4) * intensity;
            if (w <= 0) continue;

            const idx = (x * Ny + y) * Nz + z;
            const b3 = idx * 3;
            out[b3 + 0] = Math.max(0, Math.min(255, out[b3 + 0] + cr * w));
            out[b3 + 1] = Math.max(0, Math.min(255, out[b3 + 1] + cg * w));
            out[b3 + 2] = Math.max(0, Math.min(255, out[b3 + 2] + cb * w));
          }
        }
      }
    }
  }
}

// Reflect a coordinate back into [0, span] so fireflies bounce gently off
// the cube faces instead of escaping or piling on the walls.
function reflect(p, span) {
  if (span <= 0) return 0;
  let v = p;
  // Handle multiple reflections in one step (small dt makes this rare).
  const period = 2 * span;
  v = v % period;
  if (v < 0) v += period;
  if (v > span) v = period - v;
  return v;
}
