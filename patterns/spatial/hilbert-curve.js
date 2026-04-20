// Hilbert Curve — animated trace of a space-filling curve through the cube.
//
// Implementation note: the canonical 3D Hilbert curve is a pain to
// hand-roll, so this uses a per-Z-layer 2D Hilbert with alternating
// traversal direction. The first Z-slice walks the standard 2D Hilbert
// forward; the next slice walks it in reverse so the last cell of one
// slice is adjacent to the first cell of the next — keeping the overall
// path continuous. Not the textbook 3D Hilbert but still fully space-
// filling and locality-preserving, and the fractal self-similarity is
// beautifully visible as the head animates along.
//
// For cubes whose side isn't a power of two, we generate the 2D Hilbert
// for the next power of 2 ≥ N and skip out-of-bounds cells while walking
// the path — continuity is preserved on the kept cells.
//
// The `showFull` toggle paints the whole curve at low brightness as a
// rainbow ramp keyed to path index, so the structure is legible at a
// glance even without the animated head.

export const params = {
  speed:     { type: 'range', min: 1,  max: 400, step: 1, default: 80, label: 'Cells / sec' },
  trailLen:  { type: 'int',   min: 1,  max: 100, default: 24 },
  headColor: { type: 'color', default: '#ffffff' },
  tailColor: { type: 'color', default: '#4080ff' },
  showFull:  { type: 'toggle', default: true, label: 'Show full curve' },
  fullLevel: { type: 'range', min: 0, max: 0.4, step: 0.005, default: 0.08, label: 'Curve brightness' },
};

// 2D Hilbert index → (x, y) on a size×size grid. Classic Wikipedia impl.
function d2xy(size, d) {
  let rx, ry, t = d;
  let x = 0, y = 0;
  for (let s = 1; s < size; s *= 2) {
    rx = 1 & (t >> 1);
    ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      const tmp = x; x = y; y = tmp;
    }
    x += s * rx;
    y += s * ry;
    t >>= 2;
  }
  return [x, y];
}

function buildPath(N) {
  const order = Math.max(1, Math.ceil(Math.log2(Math.max(2, N))));
  const size = 1 << order;
  const plane = new Array(size * size);
  for (let d = 0; d < size * size; d++) plane[d] = d2xy(size, d);
  const path = [];
  for (let y = 0; y < N; y++) {
    // Alternate direction per Y-slice so consecutive slices link at a face.
    const forward = (y % 2) === 0;
    for (let k = 0; k < plane.length; k++) {
      const [px, pz] = forward ? plane[k] : plane[plane.length - 1 - k];
      if (px < N && pz < N) path.push((px * N + y) * N + pz);
    }
  }
  return path;
}

export default class HilbertCurve {
  static name = 'Hilbert Curve';

  setup(ctx) {
    this.N = ctx.N;
    this.path = buildPath(ctx.N);
  }

  render(ctx, out) {
    const { t, N, params, utils } = ctx;
    if (this.N !== N || !this.path) this.setup(ctx);
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
