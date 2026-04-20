// Life 3D — Bays' 3D cellular automaton with age-based coloring.
//
// Rules are B/S notation over the 26-cell Moore neighborhood. The Bays
// (1987) survey found B5678/S45678 stable enough to sustain complex
// long-lived patterns, so that's the default; a few alternate rules are
// included for variety. Boundaries wrap toroidally so the population
// doesn't starve at the edges.
//
// Pure on/off rendering makes 3D Life look like random noise — you can't
// see the cohesive structures evolving. Coloring live cells by *age*
// (how many consecutive steps they've been alive) makes the clusters
// legible: new cells flash young, established bodies settle into old.
//
// Auto-reseed: if population dies out or stalls in a still-life for too
// many steps, we reseed with fresh random noise so the pattern stays
// visually alive.

const RULES = {
  'B5678/S45678 (Bays)': { birth: new Set([5, 6, 7, 8]),    survive: new Set([4, 5, 6, 7, 8]) },
  'B4/S34':              { birth: new Set([4]),             survive: new Set([3, 4]) },
  'B5/S45':              { birth: new Set([5]),             survive: new Set([4, 5]) },
  'Amoeba (B567/S567)':  { birth: new Set([5, 6, 7]),       survive: new Set([5, 6, 7]) },
  'Clouds (B678/S5678)': { birth: new Set([6, 7, 8]),       survive: new Set([5, 6, 7, 8]) },
};

export const params = {
  rule:        { type: 'select', options: Object.keys(RULES), default: 'B5678/S45678 (Bays)' },
  stepRate:    { type: 'range', min: 1,    max: 30,  step: 0.5, default: 8, label: 'Steps / sec' },
  seedDensity: { type: 'range', min: 0.1,  max: 0.6, step: 0.01, default: 0.3 },
  colorByAge:  { type: 'toggle', default: true },
  youngColor:  { type: 'color', default: '#80ffd0' },
  oldColor:    { type: 'color', default: '#ff60a0' },
};

function seedBuf(N, density) {
  const buf = new Uint8Array(N * N * N);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.random() < density ? 1 : 0;
  return buf;
}

export default class Life3D {
  static name = 'Life 3D';

  setup(ctx) {
    this.N = ctx.N;
    this.state = seedBuf(ctx.N, ctx.params.seedDensity);
    this.age = new Uint8Array(this.state.length);
    for (let i = 0; i < this.state.length; i++) this.age[i] = this.state[i];
    this.stepAcc = 0;
    this.stableFor = 0;
    this.lastPop = -1;
  }

  reseed(density) {
    this.state = seedBuf(this.N, density);
    this.age = new Uint8Array(this.state.length);
    for (let i = 0; i < this.state.length; i++) this.age[i] = this.state[i];
    this.stableFor = 0;
    this.lastPop = -1;
  }

  step(rule) {
    const N = this.N;
    const cur = this.state;
    const curAge = this.age;
    const next = new Uint8Array(cur.length);
    const nextAge = new Uint8Array(cur.length);
    let pop = 0;
    // Pre-built neighbor tables so the per-voxel count stays allocation-free.
    const xn = new Int32Array(3), yn = new Int32Array(3), zn = new Int32Array(3);
    for (let x = 0; x < N; x++) {
      xn[0] = (x - 1 + N) % N; xn[1] = x; xn[2] = (x + 1) % N;
      for (let y = 0; y < N; y++) {
        yn[0] = (y - 1 + N) % N; yn[1] = y; yn[2] = (y + 1) % N;
        for (let z = 0; z < N; z++) {
          zn[0] = (z - 1 + N) % N; zn[1] = z; zn[2] = (z + 1) % N;
          // 26-neighbor count — the inner loop dominates step() cost at N=10+.
          let n = 0;
          for (let a = 0; a < 3; a++) {
            const xi = xn[a];
            for (let b = 0; b < 3; b++) {
              const yi = yn[b];
              for (let c = 0; c < 3; c++) {
                if (a === 1 && b === 1 && c === 1) continue;
                if (cur[(xi * N + yi) * N + zn[c]]) n++;
              }
            }
          }
          const idx = (x * N + y) * N + z;
          const alive = cur[idx] === 1;
          const willLive = alive ? rule.survive.has(n) : rule.birth.has(n);
          if (willLive) {
            next[idx] = 1;
            nextAge[idx] = Math.min(255, (alive ? curAge[idx] : 0) + 1);
            pop++;
          }
        }
      }
    }
    this.state = next;
    this.age = nextAge;
    if (pop === 0) { this.reseed(0.3); return; }
    if (pop === this.lastPop) this.stableFor++;
    else this.stableFor = 0;
    this.lastPop = pop;
    // Still-life detection: if the population hasn't changed for many steps,
    // the sim is stuck — reseed to keep things visually alive.
    if (this.stableFor > 40) this.reseed(0.3);
  }

  update(ctx) {
    const { dt, N, params } = ctx;
    if (this.N !== N) this.setup(ctx);
    const rule = RULES[params.rule] ?? RULES['B5678/S45678 (Bays)'];
    this.stepAcc += params.stepRate * dt;
    // Cap iterations per frame so a big cube + high stepRate can't stall the
    // render loop on a slow machine.
    let steps = 0;
    while (this.stepAcc >= 1 && steps < 3) {
      this.step(rule);
      this.stepAcc -= 1;
      steps++;
    }
  }

  render(ctx, out) {
    const { params, utils } = ctx;
    const [yr, yg, yb] = utils.parseColor(params.youngColor);
    const [or_, og, ob] = utils.parseColor(params.oldColor);
    for (let i = 0; i < this.state.length; i++) {
      if (!this.state[i]) {
        out[i * 3 + 0] = 0;
        out[i * 3 + 1] = 0;
        out[i * 3 + 2] = 0;
        continue;
      }
      if (params.colorByAge) {
        // Age saturates at ~20 steps — past that cells read as "mature".
        const k = Math.min(1, this.age[i] / 20);
        out[i * 3 + 0] = yr + (or_ - yr) * k;
        out[i * 3 + 1] = yg + (og - yg) * k;
        out[i * 3 + 2] = yb + (ob - yb) * k;
      } else {
        out[i * 3 + 0] = yr;
        out[i * 3 + 1] = yg;
        out[i * 3 + 2] = yb;
      }
    }
  }
}
