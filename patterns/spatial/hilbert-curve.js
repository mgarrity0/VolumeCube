// Hilbert Curve — animated trace of a true 3D space-filling curve.
//
// Uses Skilling's transposed-axes algorithm ("Programming the Hilbert
// curve", 2004) to generate the canonical 3D Hilbert curve through a
// 2^order cube. Unlike a per-layer 2D Hilbert, this genuinely interleaves
// all three axes — each recursion subdivides the volume into 8 octants
// visited in a Gray-code order, so the curve probes depth as it walks
// rather than filling one slab at a time.
//
// For non-power-of-two / non-cubic dimensions we generate the curve on
// the next-power-of-2 bounding cube and drop cells that fall outside
// (Nx, Ny, Nz). Hilbert locality keeps skips clustered, so the kept path
// is mostly continuous with only occasional small jumps — fine visually.
//
// The `showFull` toggle paints the whole curve at low brightness as a
// rainbow ramp keyed to path index, so the 3D fractal structure is
// legible at a glance even without the animated head.

export const params = {
  speed:     { type: 'range', min: 1,  max: 400, step: 1, default: 80, label: 'Cells / sec' },
  trailLen:  { type: 'int',   min: 1,  max: 100, default: 24 },
  headColor: { type: 'color', default: '#ffffff' },
  tailColor: { type: 'color', default: '#4080ff' },
  showFull:  { type: 'toggle', default: true, label: 'Show full curve' },
  fullLevel: { type: 'range', min: 0, max: 0.4, step: 0.005, default: 0.08, label: 'Curve brightness' },
};

// Skilling's Hilbert index → 3D axes.
// d ∈ [0, 8^order); returns [x, y, z] ∈ [0, 2^order)³.
// Consecutive d values produce adjacent (x,y,z) positions differing by
// exactly one step on exactly one axis — the defining Hilbert property.
function hilbertD2XYZ(d, order) {
  // Unpack d into the "transposed" representation: b bits across 3 words,
  // where the 3 bits at d's position (3i+2, 3i+1, 3i+0) become bit i of
  // X[0], X[1], X[2] respectively.
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < order; i++) {
    const g = (d >> (i * 3)) & 7;
    x |= ((g >> 2) & 1) << i;
    y |= ((g >> 1) & 1) << i;
    z |= ((g >> 0) & 1) << i;
  }
  // Gray decode.
  const t0 = z >> 1;
  z ^= y;
  y ^= x;
  x ^= t0;
  // Undo the rotations/reflections applied at each recursion level.
  // Skilling iterates the axes in reverse (z, y, x); the i=0 (x) case
  // collapses to a no-op when X[i]&Q is false, so it's inlined.
  const N = 1 << order;
  for (let Q = 2; Q < N; Q <<= 1) {
    const P = Q - 1;
    if (z & Q) x ^= P;
    else { const t = (x ^ z) & P; x ^= t; z ^= t; }
    if (y & Q) x ^= P;
    else { const t = (x ^ y) & P; x ^= t; y ^= t; }
    if (x & Q) x ^= P;
  }
  return [x, y, z];
}

function buildPath(Nx, Ny, Nz) {
  // Hilbert curve needs a 2^order cube; pick order to cover the largest axis.
  const maxDim = Math.max(Nx, Ny, Nz);
  const order = Math.max(1, Math.ceil(Math.log2(Math.max(2, maxDim))));
  const total = 1 << (order * 3);
  const path = [];
  for (let d = 0; d < total; d++) {
    const [x, y, z] = hilbertD2XYZ(d, order);
    if (x < Nx && y < Ny && z < Nz) {
      path.push((x * Ny + y) * Nz + z);
    }
  }
  return path;
}

export default class HilbertCurve {
  static name = 'Hilbert Curve';

  setup(ctx) {
    this.Nx = ctx.Nx; this.Ny = ctx.Ny; this.Nz = ctx.Nz;
    this.path = buildPath(ctx.Nx, ctx.Ny, ctx.Nz);
  }

  render(ctx, out) {
    const { t, Nx, Ny, Nz, params, utils } = ctx;
    if (this.Nx !== Nx || this.Ny !== Ny || this.Nz !== Nz || !this.path) this.setup(ctx);
    const total = this.path.length;
    out.fill(0);

    const [hr, hg, hb] = utils.parseColor(params.headColor);
    const [tr, tg, tb] = utils.parseColor(params.tailColor);

    // Faint full-curve rainbow so the fractal structure is visible at rest.
    if (params.showFull && params.fullLevel > 0) {
      for (let k = 0; k < total; k++) {
        const idx = this.path[k];
        const hue = k / total;
        const c = utils.hsv(hue, 0.85, params.fullLevel);
        out[idx * 3 + 0] = c[0];
        out[idx * 3 + 1] = c[1];
        out[idx * 3 + 2] = c[2];
      }
    }

    // Animated head + fading trail. Wraps modularly so the sweep is seamless.
    const head = (t * params.speed) % total;
    for (let d = 0; d < params.trailLen; d++) {
      let k = head - d;
      if (k < 0) k += total;
      const ki = Math.floor(k);
      if (ki < 0 || ki >= total) continue;
      const idx = this.path[ki];
      const a = 1 - d / params.trailLen;
      const intensity = a * a;
      const tr_ratio = d / params.trailLen;
      const r = (hr + (tr - hr) * tr_ratio) * intensity;
      const g = (hg + (tg - hg) * tr_ratio) * intensity;
      const b = (hb + (tb - hb) * tr_ratio) * intensity;
      // Max-blend over the base layer so the head stays bright even with showFull.
      out[idx * 3 + 0] = Math.min(255, Math.max(out[idx * 3 + 0], r));
      out[idx * 3 + 1] = Math.min(255, Math.max(out[idx * 3 + 1], g));
      out[idx * 3 + 2] = Math.min(255, Math.max(out[idx * 3 + 2], b));
    }
  }
}
