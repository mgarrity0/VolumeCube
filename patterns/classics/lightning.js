// Lightning — crisp branching strikes that stab from the top face to the floor.
//
// Each bolt is a polyline built by random-walking down the Y axis with
// jittered X/Z perturbations. At each main-bolt trunk point we may spawn a
// short secondary branch (single-level, dies fast). Bolts have an instant
// white-hot strike → fast exponential-decay envelope, with a couple of rapid
// re-strike "stutters" so each flash flickers like the real thing.
//
// The bolt itself is the hero: a blinding white core wrapped in a thin
// electric-blue glow, drawn with squared falloff so edges stay razor-crisp
// under bloom. The ambient room-flash is now a BRIEF, GLOW-FALLOFF wash that
// is brightest near the bolt and decays toward the cube edges — it lasts only
// a few frames at the strike peak, then the volume falls truly dark between
// strikes for maximum dynamic range. No more flat full-cube grey.

export const params = {
  strikeRate:   { type: 'range', min: 0.2, max: 5,    step: 0.05, default: 1.2,  label: 'Strikes/sec' },
  boltLife:     { type: 'range', min: 0.1, max: 1.5,  step: 0.02, default: 0.42, label: 'Bolt life (sec)' },
  branchChance: { type: 'range', min: 0,   max: 0.4,  step: 0.01, default: 0.20 },
  jitter:       { type: 'range', min: 0,   max: 1.5,  step: 0.02, default: 0.55, label: 'Path jitter' },
  flashAmount:  { type: 'range', min: 0,   max: 0.6,  step: 0.01, default: 0.30, label: 'Halo flash' },
  boltColor:    { type: 'color', default: '#eef0ff' },
  flashColor:   { type: 'color', default: '#5a78ff' },
};

// Additive trilinear splat of a point light into the 8 surrounding voxels.
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

function generateBolt(Nx, Ny, Nz, branchChance, jitter) {
  const segs = []; // [x0, y0, z0, x1, y1, z1, isBranch]
  // Strike origin: somewhere near the top face, not always dead-center.
  const startX = Nx / 2 + (Math.random() - 0.5) * Nx * 0.5;
  const startZ = Nz / 2 + (Math.random() - 0.5) * Nz * 0.5;
  const startY = Ny - 0.5;
  // Gentle bias toward a random landing point so the trunk has a clear path.
  const targetX = Math.random() * (Nx - 1);
  const targetZ = Math.random() * (Nz - 1);

  function walk(x, y, z, isBranch) {
    let steps = 0;
    while (y > 0 && steps < Ny * 3 + 8) {
      steps++;
      const yStep = 0.45 + Math.random() * 0.65;
      const ny = Math.max(0, y - yStep);
      // Trunk drifts toward its landing target; branches wander free.
      const fall = isBranch ? 0 : (1 - y / Math.max(1, Ny)) * 0.25;
      const biasX = isBranch ? 0 : (targetX - x) * fall;
      const biasZ = isBranch ? 0 : (targetZ - z) * fall;
      const nx = Math.max(0, Math.min(Nx - 1, x + biasX + (Math.random() - 0.5) * jitter * 4));
      const nz = Math.max(0, Math.min(Nz - 1, z + biasZ + (Math.random() - 0.5) * jitter * 4));
      segs.push([x, y, z, nx, ny, nz, isBranch]);
      // Spawn a single-level branch off the trunk (not too near the top).
      if (!isBranch && Math.random() < branchChance && y < Ny - 1) {
        walk(x, y, z, true);
      }
      x = nx; y = ny; z = nz;
      // Branches are short spritzes — they die fast.
      if (isBranch && Math.random() < 0.45) break;
    }
  }
  walk(startX, startY, startZ, false);
  // Centroid of the bolt, used to anchor the halo flash near the strike.
  let cx = 0, cy = 0, cz = 0;
  for (const s of segs) { cx += s[0]; cy += s[1]; cz += s[2]; }
  const n = Math.max(1, segs.length);
  return { segs, hx: cx / n, hy: cy / n, hz: cz / n };
}

export default class Lightning {
  static name = 'Lightning';

  setup() {
    this.bolts = [];
    this.nextStrikeT = 0.25; // brief warm-up before first strike
  }

  update(ctx) {
    const { dt, t, Nx, Ny, Nz, params, audio } = ctx;

    // Audio beat (when present) can trigger an extra strike for liveliness.
    const beat = audio && audio.beat;

    if (t >= this.nextStrikeT || beat) {
      const b = generateBolt(Nx, Ny, Nz, params.branchChance, params.jitter);
      this.bolts.push({
        segs: b.segs,
        hx: b.hx, hy: b.hy, hz: b.hz,
        age: 0,
        life: params.boltLife * (0.7 + Math.random() * 0.6),
        // Phase offset so each bolt's stutter flicker is unique.
        seed: Math.random() * 100,
      });
      if (t >= this.nextStrikeT) {
        this.nextStrikeT = t + (0.35 + Math.random() * 0.9) / Math.max(0.1, params.strikeRate);
      }
    }

    for (let i = this.bolts.length - 1; i >= 0; i--) {
      this.bolts[i].age += dt;
      if (this.bolts[i].age > this.bolts[i].life) this.bolts.splice(i, 1);
    }
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, params, utils } = ctx;
    out.fill(0);

    const [br, bg, bb] = utils.parseColor(params.boltColor);
    const [fr, fg, fb] = utils.parseColor(params.flashColor);

    for (const bolt of this.bolts) {
      const ageT = bolt.age / Math.max(1e-4, bolt.life);

      // Envelope: near-instant strike, fast power-decay tail.
      let env = ageT < 0.04
        ? ageT / 0.04
        : Math.pow(1 - (ageT - 0.04) / 0.96, 2.4);

      // Stutter: a couple of rapid re-strikes early in the flash give the
      // bolt that nervous electric flicker instead of a smooth fade.
      const flick = 0.7 + 0.3 * Math.sin((ageT * 38 + bolt.seed) * 6.28318);
      const reStrike = ageT < 0.32 ? (0.85 + 0.15 * Math.sin(ageT * 90 + bolt.seed)) : 1;
      const intensity = env * flick * reStrike;
      if (intensity <= 0.001) continue;

      // --- Draw the bolt: blinding white core + thin electric-blue glow ---
      // Core is pushed toward white so it clips bright; glow carries the hue.
      const coreR = (br * 0.35 + 255 * 0.65) * intensity;
      const coreG = (bg * 0.35 + 255 * 0.65) * intensity;
      const coreB = (bb * 0.35 + 255 * 0.65) * intensity;
      const glowR = br * 0.5 * intensity;
      const glowG = bg * 0.5 * intensity;
      const glowB = bb * 0.5 * intensity;

      for (const seg of bolt.segs) {
        const x0 = seg[0], y0 = seg[1], z0 = seg[2];
        const x1 = seg[3], y1 = seg[4], z1 = seg[5];
        const isBranch = seg[6];
        const k = isBranch ? 0.5 : 1.0;
        const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const n = Math.max(2, Math.ceil(len * 3));
        for (let i = 0; i <= n; i++) {
          const u = i / n;
          const px = x0 + dx * u, py = y0 + dy * u, pz = z0 + dz * u;
          // Bright crisp core.
          splat(out, Nx, Ny, Nz, px, py, pz, coreR * k, coreG * k, coreB * k);
          // Thin colored glow on the +X/+Z neighbors for a touch of bleed.
          if (!isBranch) {
            splat(out, Nx, Ny, Nz, px + 0.6, py, pz, glowR, glowG, glowB);
            splat(out, Nx, Ny, Nz, px, py, pz + 0.6, glowR, glowG, glowB);
            splat(out, Nx, Ny, Nz, px - 0.6, py, pz, glowR, glowG, glowB);
          }
        }
      }

      // --- Brief halo flash anchored at the bolt, falling off with distance ---
      // Only fires in the first ~18% of the bolt's life (a few frames), and
      // its brightness drops with distance from the bolt centroid so the cube
      // never washes to flat grey. Edges of the volume stay dark.
      if (ageT < 0.18 && params.flashAmount > 0) {
        const haloEnv = (1 - ageT / 0.18);
        const peak = haloEnv * haloEnv * params.flashAmount; // sharp brief pop
        if (peak > 0.002) {
          const hx = bolt.hx, hy = bolt.hy, hz = bolt.hz;
          // Falloff radius scales with the LARGEST horizontal/vertical span so
          // thin slabs (small Nz) don't get washed edge-to-edge — the halo
          // stays a localized hero-glow, never a flat fill.
          const span = Math.min(Math.max(Nx, Ny), Math.max(Nx, Math.max(Ny, Nz)));
          const rad = Math.max(2, span * 0.5);
          const invR2 = 1 / (rad * rad);
          for (let x = 0; x < Nx; x++) {
            const ddx = x - hx;
            for (let y = 0; y < Ny; y++) {
              const ddy = y - hy;
              for (let z = 0; z < Nz; z++) {
                const ddz = z - hz;
                const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                // Smooth inverse-square-ish falloff, clamped to 0 at the edge.
                let g = 1 - d2 * invR2;
                if (g <= 0) continue;
                g = g * g * peak;
                const idx = (x * Ny + y) * Nz + z;
                out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + fr * g);
                out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + fg * g);
                out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + fb * g);
              }
            }
          }
        }
      }
    }
  }
}
