// DNA Helix — a double helix spiralling up the Y axis.
//
// Two phosphate backbones (offset 180°) are traced parametrically along Y as
// glowing tubes of soft splatted points, in two complementary hues. At regular
// intervals along the helix a base-pair "rung" connects the strands: a short
// bright bar, colored by one of 4 base-pair colors (A·T / T·A / G·C / C·G).
// The whole structure slowly rotates about Y for read-from-any-angle 3D, and
// the rungs pulse so the ladder breathes. Empty space stays black so the helix
// floats in the dark and blooms cleanly.
//
// Rendering: we walk a fine parameter t along Y, computing each backbone's
// (x,z) from sin/cos of the helix phase, and splat glowing points with
// trilinear deposit. Rungs are sampled as a line between the two backbones at
// the same height. Everything is additive so crossings and cores bloom hot.

export const params = {
  speed:    { type: 'range', min: 0,   max: 3,   step: 0.01, default: 1.0,  label: 'Rotation speed' },
  turns:    { type: 'range', min: 1,   max: 4,   step: 0.05, default: 2.0,  label: 'Helical turns' },
  radius:   { type: 'range', min: 0.2, max: 0.5, step: 0.01, default: 0.34, label: 'Helix radius' },
  thick:    { type: 'range', min: 0.4, max: 2.0, step: 0.05, default: 0.85, label: 'Strand thickness' },
  rungs:    { type: 'int',   min: 4,   max: 16,              default: 9,    label: 'Base pairs' },
  pulse:    { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.6,  label: 'Rung pulse' },
  bright:   { type: 'range', min: 0.5, max: 2,   step: 0.05, default: 1.25, label: 'Brightness' },
  hueA:     { type: 'color', default: '#18b6ff' },
  hueB:     { type: 'color', default: '#ff7a18' },
};

// Four base-pair colors (A, T, G, C) — punchy, saturated, clearly distinct.
const BASES = [
  [80, 255, 120],   // A — green
  [255, 70, 110],   // T — magenta-red
  [255, 220, 60],   // G — gold
  [110, 150, 255],  // C — periwinkle blue
];

function splat(out, Nx, Ny, Nz, x, y, z, r, g, b) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  for (let dx = 0; dx <= 1; dx++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dz = 0; dz <= 1; dz++) {
        const xx = x0 + dx, yy = y0 + dy, zz = z0 + dz;
        if (xx < 0 || xx >= Nx || yy < 0 || yy >= Ny || zz < 0 || zz >= Nz) continue;
        const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
        if (w <= 0) continue;
        const idx = (xx * Ny + yy) * Nz + zz;
        out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r * w);
        out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g * w);
        out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b * w);
      }
    }
  }
}

export default class DnaHelix {
  static name = 'DNA Helix';

  setup(ctx) {
    this.phase = 0; // accumulated rotation so speed changes don't jump
  }

  update(ctx) {
    this.phase += ctx.dt * ctx.params.speed * 0.6;
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, t, params, utils } = ctx;
    out.fill(0);

    const cxV = (Nx - 1) * 0.5;
    const czV = (Nz - 1) * 0.5;
    // Half-extents in voxels; guard the degenerate (size 1) axes.
    const rx = Nx > 1 ? (Nx - 1) * 0.5 : 0;
    const rz = Nz > 1 ? (Nz - 1) * 0.5 : 0;
    const rRadius = Math.min(rx > 0 ? rx : rz, rz > 0 ? rz : rx) || 1;

    const radius = params.radius * rRadius * 2; // params.radius is fraction of half-extent
    const thick = params.thick;
    const bright = params.bright * 255;
    const rot = this.phase !== undefined ? this.phase : t * params.speed * 0.6;

    const cA = utils.parseColor(params.hueA);
    const cB = utils.parseColor(params.hueB);

    // Vertical span: leave a small margin top/bottom so tips don't clip flat.
    const yLo = 0.5;
    const yHi = Ny - 1.5 > yLo ? Ny - 1.5 : Ny - 1;
    const ySpan = yHi - yLo;
    const totalTwist = params.turns * Math.PI * 2;

    // --- Backbones: walk a dense parameter along Y and splat both strands ---
    // Enough samples that the tubes read as continuous even when rotated.
    const steps = Math.max(40, Ny * 8);
    // Per-point energy: tuned so a single voxel lights hot but tube stays tight.
    const strandGain = bright * (0.55 + 0.6 / Math.max(0.4, thick));
    const sigma2 = 2 * thick * thick; // gaussian falloff width for radial blur

    for (let s = 0; s <= steps; s++) {
      const f = s / steps;            // 0..1 up the helix
      const y = yLo + f * ySpan;
      const ang = f * totalTwist + rot;

      // Slight brightness shimmer travelling up the strands = "alive".
      const shimmer = 0.78 + 0.22 * Math.sin(f * 9 + t * 2.0);

      for (let strand = 0; strand < 2; strand++) {
        const a = ang + (strand ? Math.PI : 0); // 180° offset
        const px = cxV + Math.cos(a) * radius;
        const pz = czV + Math.sin(a) * radius;
        const col = strand ? cB : cA;
        const g0 = strandGain * shimmer;
        splat(out, Nx, Ny, Nz, px, y, pz, col[0] / 255 * g0, col[1] / 255 * g0, col[2] / 255 * g0);

        // Soft radial halo for a tube look when thickness is high.
        if (thick > 0.6) {
          const hw = 0.35 * thick; // halo offset toward center
          const hx = cxV + Math.cos(a) * (radius - hw);
          const hz = czV + Math.sin(a) * (radius - hw);
          const hg = g0 * 0.4 * Math.exp(-1 / sigma2);
          splat(out, Nx, Ny, Nz, hx, y, hz, col[0] / 255 * hg, col[1] / 255 * hg, col[2] / 255 * hg);
        }
      }
    }

    // --- Base-pair rungs: bright bars bridging the two strands ---
    const nRungs = params.rungs;
    const rungSamples = Math.max(6, Math.ceil(radius * 4));
    for (let k = 0; k < nRungs; k++) {
      // Place rungs evenly between the strand tips, half a slot in from each end.
      const f = (k + 0.5) / nRungs;
      const y = yLo + f * ySpan;
      const ang = f * totalTwist + rot;

      // Endpoints of this rung on each backbone.
      const ax = cxV + Math.cos(ang) * radius;
      const az = czV + Math.sin(ang) * radius;
      const bx = cxV + Math.cos(ang + Math.PI) * radius;
      const bz = czV + Math.sin(ang + Math.PI) * radius;

      // Color by base pair; pulse them out of phase so the ladder breathes.
      const base = BASES[k % 4];
      const pulse = 1 - params.pulse + params.pulse * (0.5 + 0.5 * Math.sin(t * 3.0 + k * 1.7));
      const rg = bright * 0.9 * pulse;

      for (let j = 0; j <= rungSamples; j++) {
        const u = j / rungSamples;
        const x = ax + (bx - ax) * u;
        const z = az + (bz - az) * u;
        // Brighter toward the strand ends where it meets the glowing tube,
        // with a hot mid so the rung reads as a solid bar.
        const edge = 0.6 + 0.4 * Math.sin(u * Math.PI);
        const g0 = rg * edge;
        splat(out, Nx, Ny, Nz, x, y, z, base[0] / 255 * g0, base[1] / 255 * g0, base[2] / 255 * g0);
      }
    }
  }
}
