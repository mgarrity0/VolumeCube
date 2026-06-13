// Life 3D — Bays' 3D cellular automaton rendered as a breathing organism.
//
// Rules are B/S notation over the 26-cell Moore neighborhood. The Bays
// (1987) survey found B5678/S45678 stable enough to sustain complex
// long-lived patterns; a few alternate rules are included for variety.
// Boundaries wrap toroidally so the population doesn't starve at the edges.
//
// Pure on/off rendering makes 3D Life look like a solid block of noise —
// you can't see the structures evolving, and a dense rule lights most of
// the cube to a flat brightness. Three things fix that here:
//
//   1. AGE → HUE JOURNEY. Each live cell tracks how many consecutive steps
//      it has survived. Newborn cells flash hot and bright; as they mature
//      they drift along a hue arc and cool, so a cluster reads as a living
//      body with a glowing growth front and a settled, darker core.
//
//   2. SMOOTH LIFE. Discrete CA steps strobe. We keep the previous frame's
//      brightness per voxel and ease toward the target each render, so cells
//      bloom in and fade out instead of popping — the cube breathes.
//
//   3. DARKNESS WITH DEPTH. Dead space stays truly black for contrast. A
//      soft membrane halo (driven by how many live neighbors a dead cell
//      touches) lets bright bodies bleed a faint glow into the surrounding
//      void, giving the organism a translucent skin without washing the
//      cube out to grey.
//
// Auto-reseed: if the population dies out or freezes in a still-life for too
// many steps, we reseed with fresh noise so the pattern stays alive.

const RULES = {
  'B5678/S45678 (Bays)': { birth: new Set([5, 6, 7, 8]),    survive: new Set([4, 5, 6, 7, 8]) },
  'B4/S34':              { birth: new Set([4]),             survive: new Set([3, 4]) },
  'B5/S45':              { birth: new Set([5]),             survive: new Set([4, 5]) },
  'Amoeba (B567/S567)':  { birth: new Set([5, 6, 7]),       survive: new Set([5, 6, 7]) },
  'Clouds (B678/S5678)': { birth: new Set([6, 7, 8]),       survive: new Set([5, 6, 7, 8]) },
};

export const params = {
  // Default rule favours sparser, more legible structures over the dense
  // Bays cloud, so the cube reads as clusters in space rather than a block.
  rule:        { type: 'select', options: Object.keys(RULES), default: 'B4/S34' },
  stepRate:    { type: 'range', min: 1,    max: 30,  step: 0.5, default: 6, label: 'Steps / sec' },
  seedDensity: { type: 'range', min: 0.1,  max: 0.6, step: 0.01, default: 0.28 },
  colorByAge:  { type: 'toggle', default: true },
  youngColor:  { type: 'color', default: '#aaff5a' },  // hot growth front (fallback)
  oldColor:    { type: 'color', default: '#3a30ff' },  // cool settled core (fallback)
  hueShift:    { type: 'range', min: 0, max: 1, step: 0.01, default: 0.0, label: 'Hue drift' },
  membrane:    { type: 'range', min: 0, max: 1, step: 0.01, default: 0.55, label: 'Halo glow' },
  bloom:       { type: 'range', min: 1, max: 12, step: 0.1, default: 6, label: 'Bloom speed' },
};

function seedBuf(count, density) {
  const buf = new Uint8Array(count);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.random() < density ? 1 : 0;
  return buf;
}

export default class Life3D {
  static name = 'Life 3D';

  setup(ctx) {
    this.Nx = ctx.Nx; this.Ny = ctx.Ny; this.Nz = ctx.Nz;
    const total = this.Nx * this.Ny * this.Nz;
    const density = ctx.params ? ctx.params.seedDensity : 0.28;
    this.state = seedBuf(total, density);
    this.age = new Uint8Array(this.state.length);
    for (let i = 0; i < this.state.length; i++) this.age[i] = this.state[i];
    // Live-neighbour count of every cell, kept so the halo membrane and the
    // step() both reuse one pass; refreshed each CA step.
    this.nbr = new Uint8Array(this.state.length);
    // Smoothed per-voxel brightness [0..1] for the breathing crossfade.
    this.glow = new Float32Array(this.state.length);
    this.refreshNeighbors();
    this.stepAcc = 0;
    this.stableFor = 0;
    this.lastPop = -1;
    this.stepPhase = 0;       // 0..1 progress toward the next CA step (for easing)
  }

  reseed(density) {
    const total = this.Nx * this.Ny * this.Nz;
    this.state = seedBuf(total, density);
    this.age = new Uint8Array(this.state.length);
    for (let i = 0; i < this.state.length; i++) this.age[i] = this.state[i];
    this.refreshNeighbors();
    this.stableFor = 0;
    this.lastPop = -1;
  }

  // 26-neighbour live count for the current state, with toroidal wrap.
  refreshNeighbors() {
    const { Nx, Ny, Nz } = this;
    const cur = this.state;
    const nbr = this.nbr;
    const xn = new Int32Array(3), yn = new Int32Array(3), zn = new Int32Array(3);
    for (let x = 0; x < Nx; x++) {
      xn[0] = (x - 1 + Nx) % Nx; xn[1] = x; xn[2] = (x + 1) % Nx;
      for (let y = 0; y < Ny; y++) {
        yn[0] = (y - 1 + Ny) % Ny; yn[1] = y; yn[2] = (y + 1) % Ny;
        for (let z = 0; z < Nz; z++) {
          zn[0] = (z - 1 + Nz) % Nz; zn[1] = z; zn[2] = (z + 1) % Nz;
          let n = 0;
          for (let a = 0; a < 3; a++) {
            const xi = xn[a];
            for (let b = 0; b < 3; b++) {
              const yi = yn[b];
              for (let c = 0; c < 3; c++) {
                if (a === 1 && b === 1 && c === 1) continue;
                if (cur[(xi * Ny + yi) * Nz + zn[c]]) n++;
              }
            }
          }
          nbr[(x * Ny + y) * Nz + z] = n;
        }
      }
    }
  }

  step(rule) {
    const cur = this.state;
    const curAge = this.age;
    const nbr = this.nbr;
    const next = new Uint8Array(cur.length);
    const nextAge = new Uint8Array(cur.length);
    let pop = 0;
    for (let idx = 0; idx < cur.length; idx++) {
      const n = nbr[idx];
      const alive = cur[idx] === 1;
      const willLive = alive ? rule.survive.has(n) : rule.birth.has(n);
      if (willLive) {
        next[idx] = 1;
        nextAge[idx] = Math.min(255, (alive ? curAge[idx] : 0) + 1);
        pop++;
      }
    }
    this.state = next;
    this.age = nextAge;
    this.refreshNeighbors();
    if (pop === 0) { this.reseed(0.28); return; }
    if (pop === this.lastPop) this.stableFor++;
    else this.stableFor = 0;
    this.lastPop = pop;
    // Still-life detection: if the population hasn't changed for many steps,
    // the sim is stuck — reseed to keep things visually alive.
    if (this.stableFor > 40) this.reseed(0.28);
  }

  update(ctx) {
    const { dt, Nx, Ny, Nz, params } = ctx;
    if (this.Nx !== Nx || this.Ny !== Ny || this.Nz !== Nz) this.setup(ctx);
    const rule = RULES[params.rule] ?? RULES['B4/S34'];
    // A beat nudges the clock so the organism pulses on the music when present.
    const beatKick = (ctx.audio && ctx.audio.beat) ? 0.35 : 0;
    this.stepAcc += (params.stepRate + beatKick * params.stepRate) * dt;
    // stepPhase tracks how far we are toward the next discrete step so render()
    // can ease young cells in — reset whenever a step actually fires.
    this.stepPhase = Math.min(1, this.stepAcc);
    let steps = 0;
    while (this.stepAcc >= 1 && steps < 3) {
      this.step(rule);
      this.stepAcc -= 1;
      this.stepPhase = 0;
      steps++;
    }
  }

  render(ctx, out) {
    const { params, utils, t } = ctx;
    const { clamp, smoothstep, hsv } = utils;
    const state = this.state;
    const age = this.age;
    const nbr = this.nbr;
    const glow = this.glow;
    const total = state.length;

    // Fallback gradient endpoints (used when colorByAge is off).
    const [yr, yg, yb] = utils.parseColor(params.youngColor);
    const [or_, og, ob] = utils.parseColor(params.oldColor);

    // Per-frame bloom easing factor — higher bloom speed snaps faster.
    const dt = ctx.dt || 0.016;
    const ease = clamp((params.bloom || 6) * dt, 0.02, 1);

    // Gentle organic breathing of overall brightness (coprime sines + noise).
    const breath = 0.82
      + 0.10 * Math.sin(t * 0.37)
      + 0.06 * Math.sin(t * 0.91 + 1.7);
    const energy = ctx.audio ? ctx.audio.energy : 0;
    const live = breath + 0.18 * energy;

    const membrane = params.membrane;
    const hueDrift = params.hueShift;
    const byAge = params.colorByAge;

    for (let i = 0; i < total; i++) {
      // ---- target brightness for this voxel --------------------------------
      let target;
      if (state[i]) {
        // Live cell: full core, but the freshly-born growth front (low age,
        // mid-step) blooms in so it doesn't pop.
        target = 1;
      } else {
        // Dead cell: faint translucent membrane glow only for cells DEEP
        // inside a live cluster (many live neighbours). The onset is high and
        // crisp so the void stays black — only the immediate skin of a dense
        // body glows, never the open space between clusters.
        const n = nbr[i];
        if (n >= 7 && membrane > 0) {
          const h = smoothstep(7, 14, n);          // high, crisp onset
          target = membrane * 0.16 * h;
        } else {
          target = 0;
        }
      }

      // ---- ease the smoothed brightness toward the target ------------------
      const g = glow[i] + (target - glow[i]) * ease;
      glow[i] = g;

      const base = i * 3;
      if (g < 0.004) {            // truly off — keep darkness crisp
        out[base] = 0; out[base + 1] = 0; out[base + 2] = 0;
        continue;
      }

      // ---- colour ----------------------------------------------------------
      let r, gg, b;
      if (state[i] && byAge) {
        // Age drives a hue journey: newborns hot (warm green/amber), maturing
        // cells sweep through cyan toward a deep settled blue/violet core.
        const aNorm = clamp(age[i] / 22, 0, 1);
        // Hue arc ~0.22 (yellow-green) -> ~0.66 (blue), plus slow global drift.
        const hue = (0.22 + 0.46 * aNorm + hueDrift + 0.04 * Math.sin(t * 0.23 + i * 0.0007)) % 1;
        const sat = 0.78 + 0.22 * (1 - aNorm);     // young = punchier
        // Newborn cells flare brighter; mature cores sink darker for depth.
        const flare = (1 - aNorm) * (1 - this.stepPhase) * 0.35;
        const val = clamp((0.55 + 0.45 * (1 - aNorm) + flare) * live * g, 0, 1);
        const c = hsv(hue, sat, val);
        r = c[0]; gg = c[1]; b = c[2];
      } else if (state[i]) {
        // colorByAge off: simple young->old gradient on the live cells.
        const k = clamp(age[i] / 20, 0, 1);
        const v = live * g;
        r = (yr + (or_ - yr) * k) * v;
        gg = (yg + (og - yg) * k) * v;
        b = (yb + (ob - yb) * k) * v;
      } else {
        // Membrane halo: tint with the young-cell hue so the skin glows like
        // the body it wraps, but dim and cool.
        const haloHue = (0.5 + hueDrift + 0.04 * Math.sin(t * 0.23)) % 1;
        const c = hsv(haloHue, 0.85, clamp(g * live, 0, 1));
        r = c[0]; gg = c[1]; b = c[2];
      }

      out[base]     = clamp(r, 0, 255);
      out[base + 1] = clamp(gg, 0, 255);
      out[base + 2] = clamp(b, 0, 255);
    }
  }
}
