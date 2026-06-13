// Sparks — explosive, white-hot embers erupting up from the base plane.
//
// Particles burst out of the floor in fountains (with the occasional big
// explosive pop), arc up under gravity + air drag, and trail glowing tails.
// Each ember is forged white-hot, blooms through orange, then bleeds to a
// deep dying red as it cools — all riding a fast per-particle flicker so the
// volume crackles like a live fire. Audio beats trigger extra eruptions.

export const params = {
  rate:     { type: 'range', min: 1,   max: 200, step: 1,    default: 70,  label: 'Spawn rate' },
  burst:    { type: 'range', min: 0,   max: 40,  step: 1,    default: 14,  label: 'Burst size' },
  gravity:  { type: 'range', min: 0,   max: 30,  step: 0.1,  default: 11,  label: 'Gravity' },
  launch:   { type: 'range', min: 2,   max: 30,  step: 0.1,  default: 15,  label: 'Launch speed' },
  spread:   { type: 'range', min: 0,   max: 4,   step: 0.01, default: 1.6, label: 'Spread' },
  life:     { type: 'range', min: 0.3, max: 4,   step: 0.01, default: 1.4, label: 'Lifetime' },
  drag:     { type: 'range', min: 0,   max: 4,   step: 0.01, default: 0.9, label: 'Air drag' },
  flicker:  { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.55, label: 'Flicker' },
  heat:     { type: 'range', min: 0.5, max: 3,   step: 0.01, default: 1.7, label: 'Heat / glow' },
  audio:    { type: 'range', min: 0,   max: 2,   step: 0.01, default: 1.0, label: 'Audio kick' },
};

// Trail samples kept per particle (head + tail splat positions).
const TRAIL = 5;

export default class Sparks {
  static name = 'Sparks';

  setup() {
    this.parts = [];
    this.spawnAcc = 0;
    this.seed = 1;
    this.lastBeat = -1;
  }

  // Cheap deterministic-ish RNG so motion stays lively without Math.random bias.
  rnd() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  spawn(Nx, Nz, params, vigor) {
    const halfX = (Nx - 1) / 2;
    const halfZ = (Nz - 1) / 2;
    // Embers erupt from a small jittered hot-spot wandering across the floor.
    const ox = (this.rnd() - 0.5) * Math.max(1, Nx * 0.4);
    const oz = (this.rnd() - 0.5) * Math.max(1, Nz * 0.4);
    const launch = params.launch * vigor;
    const p = {
      x: halfX + ox + (this.rnd() - 0.5) * 0.6,
      y: this.rnd() * 0.4,
      z: halfZ + oz + (this.rnd() - 0.5) * 0.6,
      vx: (this.rnd() - 0.5) * params.spread * 2,
      vy: launch * (0.7 + this.rnd() * 0.6),
      vz: (this.rnd() - 0.5) * params.spread * 2,
      age: 0,
      life: params.life * (0.6 + this.rnd() * 0.8),
      // Per-particle flicker phase + speed → no two embers pulse together.
      fph: this.rnd() * Math.PI * 2,
      fsp: 18 + this.rnd() * 26,
      seed: this.rnd() * 1000,
      tx: null, ty: null, tz: null, tn: 0,
    };
    p.tx = new Float32Array(TRAIL);
    p.ty = new Float32Array(TRAIL);
    p.tz = new Float32Array(TRAIL);
    this.parts.push(p);
  }

  update(ctx) {
    const { dt, t, Nx, Ny, Nz, params, audio } = ctx;
    const a = audio || { energy: 0, low: 0, beat: false };
    const dtc = Math.min(dt, 0.05); // clamp huge frame gaps so sims stay stable

    // Steady fountain.
    let rate = params.rate * (1 + (a.energy || 0) * params.audio * 0.8);
    this.spawnAcc += rate * dtc;
    let guard = 0;
    while (this.spawnAcc >= 1 && guard < 400) {
      this.spawn(Nx, Nz, params, 1);
      this.spawnAcc -= 1;
      guard++;
    }

    // Explosive eruptions on every audio beat (and a faint idle pulse so it
    // still pops without audio plugged in).
    let burstNow = 0;
    if (a.beat) burstNow += params.burst * (1 + (a.low || 0) * params.audio);
    // Idle self-burst on a slow organic cadence when there's no real beat.
    const idle = 0.5 + 0.5 * Math.sin(t * 1.7) * Math.sin(t * 0.41 + 1.3);
    if (!a.beat && idle > 0.985) burstNow += params.burst * 0.8;
    const nb = Math.min(60, burstNow | 0);
    for (let k = 0; k < nb; k++) this.spawn(Nx, Nz, params, 1.25 + this.rnd() * 0.5);

    const g = params.gravity;
    const drag = params.drag;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      // Roll the trail history (newest first).
      for (let s = TRAIL - 1; s > 0; s--) {
        p.tx[s] = p.tx[s - 1]; p.ty[s] = p.ty[s - 1]; p.tz[s] = p.tz[s - 1];
      }
      p.tx[0] = p.x; p.ty[0] = p.y; p.tz[0] = p.z;
      if (p.tn < TRAIL) p.tn++;

      // Gentle swirling turbulence so embers flutter instead of falling on rails.
      const tn = ctx.utils.noise3d(p.x * 0.25 + p.seed, p.y * 0.25, p.z * 0.25 - t * 0.6);
      const tn2 = ctx.utils.noise3d(p.z * 0.3 - p.seed, p.x * 0.3, p.y * 0.3 + t * 0.5);
      p.vx += tn * 6 * dtc;
      p.vz += tn2 * 6 * dtc;
      p.vy -= g * dtc;
      // Air drag bleeds energy → arcs feel weighted and embers settle.
      const df = Math.max(0, 1 - drag * dtc);
      p.vx *= df; p.vy *= df; p.vz *= df;

      p.x += p.vx * dtc;
      p.y += p.vy * dtc;
      p.z += p.vz * dtc;
      p.age += dtc;

      if (p.age > p.life || p.y < -0.6 || p.y > Ny + 1 ||
          p.x < -1.5 || p.x > Nx + 0.5 || p.z < -1.5 || p.z > Nz + 0.5) {
        this.parts.splice(i, 1);
      }
    }

    // Safety cap so a cranked rate can't grow the array unbounded.
    if (this.parts.length > 1400) this.parts.splice(0, this.parts.length - 1400);
  }

  // Trilinear deposit of an additive RGB splat at fractional (px,py,pz).
  deposit(out, Nx, Ny, Nz, px, py, pz, r, gC, b) {
    const x0 = Math.floor(px), y0 = Math.floor(py), z0 = Math.floor(pz);
    const fx = px - x0, fy = py - y0, fz = pz - z0;
    for (let dx = 0; dx <= 1; dx++) {
      const x = x0 + dx; if (x < 0 || x >= Nx) continue;
      const wx = dx ? fx : 1 - fx;
      for (let dy = 0; dy <= 1; dy++) {
        const y = y0 + dy; if (y < 0 || y >= Ny) continue;
        const wy = dy ? fy : 1 - fy;
        for (let dz = 0; dz <= 1; dz++) {
          const z = z0 + dz; if (z < 0 || z >= Nz) continue;
          const w = wx * wy * (dz ? fz : 1 - fz);
          if (w <= 0) continue;
          const idx = ((x * Ny + y) * Nz + z) * 3;
          out[idx]     = Math.min(255, out[idx]     + r * w);
          out[idx + 1] = Math.min(255, out[idx + 1] + gC * w);
          out[idx + 2] = Math.min(255, out[idx + 2] + b * w);
        }
      }
    }
  }

  // Map normalized lifetime 0..1 → hot ember color, scaled by intensity.
  // 0   = white-hot core
  // ~.3 = blazing orange
  // ~.7 = glowing red
  // 1   = dying ember (deep red → black)
  emberColor(t, intensity) {
    const tail = 1 - t;
    // Red stays strong almost the whole life.
    const r = 255 * Math.min(1, tail * 1.4 + 0.05);
    // Green drops fast → white→orange→red transition.
    const g = 255 * Math.pow(tail, 1.9) * 0.95;
    // Blue only present in the first white-hot instant.
    const b = 255 * Math.pow(tail, 7) * 0.9;
    return [r * intensity, g * intensity, b * intensity];
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, t, params } = ctx;
    out.fill(0);
    const heat = params.heat;
    const flickAmt = params.flicker;

    for (const p of this.parts) {
      const lt = p.age / p.life; // 0..1
      // Fast per-particle flicker — embers crackle and breathe.
      const flick = 1 - flickAmt * (0.5 + 0.5 * Math.sin(p.fph + t * p.fsp)) *
                        (0.5 + 0.5 * Math.sin(p.fph * 1.7 + t * p.fsp * 0.6));
      // Heads flare brightest at birth, then fade out smoothly.
      const fade = Math.pow(1 - lt, 0.6);
      const headI = heat * fade * Math.max(0.15, flick);

      const [hr, hg, hb] = this.emberColor(lt, headI);

      // Glowing head.
      this.deposit(out, Nx, Ny, Nz, p.x, p.y, p.z, hr, hg, hb);

      // Fading tail: each older sample dimmer + slightly cooler (older = redder).
      for (let s = 1; s < p.tn; s++) {
        const f = 1 - s / TRAIL;            // 0..1 along the tail
        const tailI = headI * f * f * 0.7;  // quadratic falloff
        if (tailI < 0.01) continue;
        // Tail reads as a slightly later (cooler) slice of the same ember.
        const tlt = Math.min(1, lt + s * 0.06);
        const [tr, tg, tb] = this.emberColor(tlt, tailI);
        this.deposit(out, Nx, Ny, Nz, p.tx[s], p.ty[s], p.tz[s], tr, tg, tb);
      }
    }
  }
}
