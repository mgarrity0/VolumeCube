// Lightning — branching strikes from the top face down to the floor.
//
// Each bolt is a polyline built by random-walking down the Y axis with
// jittered X/Z perturbations. At each main-bolt segment we may spawn a
// short secondary branch (single-level, dies fast). Bolts have a sharp
// flash → exponential-decay envelope; a brief ambient flash brightens
// every voxel during the peak so the cube reads like a room being lit
// by the strike, not just a bolt floating in dark.
//
// The "isBranch" flag on each segment dims the branch trail to ~45% of
// the trunk so the eye still follows the main bolt.

export const params = {
  strikeRate:   { type: 'range', min: 0.2, max: 5,    step: 0.05, default: 1.0,  label: 'Strikes/sec' },
  boltLife:     { type: 'range', min: 0.1, max: 1.5,  step: 0.02, default: 0.5,  label: 'Bolt life (sec)' },
  branchChance: { type: 'range', min: 0,   max: 0.4,  step: 0.01, default: 0.18 },
  jitter:       { type: 'range', min: 0,   max: 1.5,  step: 0.02, default: 0.5,  label: 'Path jitter' },
  flashAmount:  { type: 'range', min: 0,   max: 0.5,  step: 0.01, default: 0.12, label: 'Ambient flash' },
  boltColor:    { type: 'color', default: '#e0d8ff' },
  flashColor:   { type: 'color', default: '#8090ff' },
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

function generateBolt(Nx, Ny, Nz, branchChance, jitter) {
  const segs = []; // [x0, y0, z0, x1, y1, z1, isBranch]
  // Strike origin: somewhere near the top face, not always dead-center.
  const startX = Nx / 2 + (Math.random() - 0.5) * Nx * 0.4;
  const startZ = Nz / 2 + (Math.random() - 0.5) * Nz * 0.4;
  const startY = Ny - 0.5;

  function walk(x, y, z, isBranch, branchProb) {
    while (y > 0) {
      const yStep = 0.5 + Math.random() * 0.7;
      const ny = Math.max(0, y - yStep);
      const nx = Math.max(-0.5, Math.min(Nx - 0.5, x + (Math.random() - 0.5) * jitter * 4));
      const nz = Math.max(-0.5, Math.min(Nz - 0.5, z + (Math.random() - 0.5) * jitter * 4));
      segs.push([x, y, z, nx, ny, nz, isBranch]);
      // Spawn a single-level branch from current trunk point.
      if (!isBranch && Math.random() < branchProb && y < Ny - 1) {
        walk(x, y, z, true, 0);
      }
      x = nx; y = ny; z = nz;
      // Branches die early — they're just spritzes off the trunk.
      if (isBranch && Math.random() < 0.4) break;
    }
  }
  walk(startX, startY, startZ, false, branchChance);
  return segs;
}

export default class Lightning {
  static name = 'Lightning';

  setup() {
    this.bolts = [];
    this.nextStrikeT = 0.2; // brief warm-up before first strike
  }

  update(ctx) {
    const { dt, t, Nx, Ny, Nz, params } = ctx;

    if (t >= this.nextStrikeT) {
      this.bolts.push({
        segs: generateBolt(Nx, Ny, Nz, params.branchChance, params.jitter),
        age: 0,
        life: params.boltLife * (0.7 + Math.random() * 0.6),
      });
      this.nextStrikeT = t + (0.4 + Math.random() * 0.8) / Math.max(0.1, params.strikeRate);
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
    let ambientFlash = 0;

    for (const bolt of this.bolts) {
      const ageT = bolt.age / bolt.life;
      // Sharp 5% rise, power-decay over the rest.
      const intensity = ageT < 0.05
        ? ageT / 0.05
        : Math.pow(1 - (ageT - 0.05) / 0.95, 1.8);
      // Ambient room-flash only during the first quarter of the strike.
      if (ageT < 0.25) ambientFlash = Math.max(ambientFlash, (1 - ageT / 0.25) * params.flashAmount);

      for (const seg of bolt.segs) {
        const x0 = seg[0], y0 = seg[1], z0 = seg[2];
        const x1 = seg[3], y1 = seg[4], z1 = seg[5];
        const isBranch = seg[6];
        const k = isBranch ? 0.45 : 1.0;
        const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const n = Math.max(2, Math.ceil(len * 2));
        for (let i = 0; i <= n; i++) {
          const u = i / n;
          splat(out, Nx, Ny, Nz, x0 + dx * u, y0 + dy * u, z0 + dz * u,
                br * intensity * k, bg * intensity * k, bb * intensity * k);
        }
      }
    }

    // Apply room-flash on top of bolts.
    if (ambientFlash > 0) {
      const total = Nx * Ny * Nz;
      for (let i = 0; i < total; i++) {
        out[i * 3 + 0] = Math.min(255, out[i * 3 + 0] + fr * ambientFlash);
        out[i * 3 + 1] = Math.min(255, out[i * 3 + 1] + fg * ambientFlash);
        out[i * 3 + 2] = Math.min(255, out[i * 3 + 2] + fb * ambientFlash);
      }
    }
  }
}
