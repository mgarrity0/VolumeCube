// Hilbert Curve — a luminous comet tracing a true 3D space-filling curve.
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
// The look: a blinding white-hot comet HEAD races along the curve, dragging
// a long rainbow TAIL whose hue journeys as it fades. The head blooms into
// its curve-neighbors so it reads as a glowing orb through the cube's bloom.
// A faint, slowly-breathing rainbow ramp keyed to path index reveals the
// whole fractal at rest — bright enough to see the structure, dark enough
// that the comet still pops. The whole thing pulses to the beat.

export const params = {
  speed:     { type: 'range', min: 1,  max: 400, step: 1, default: 110, label: 'Cells / sec' },
  trailLen:  { type: 'int',   min: 4,  max: 160, default: 60, label: 'Tail length' },
  hueSpan:   { type: 'range', min: 0,  max: 3,   step: 0.05, default: 1.1, label: 'Tail rainbow span' },
  headColor: { type: 'color', default: '#fff4e0', label: 'Comet core' },
  bloom:     { type: 'range', min: 0,  max: 1,   step: 0.01, default: 0.6, label: 'Head bloom' },
  showFull:  { type: 'toggle', default: true, label: 'Reveal full curve' },
  fullLevel: { type: 'range', min: 0,  max: 0.6, step: 0.005, default: 0.16, label: 'Fractal glow' },
  audioReact:{ type: 'toggle', default: true, label: 'React to audio' },
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
  const path = [];   // path[k] = buffer index of the k-th curve cell
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
    this.head = 0;          // continuous position along path (float)
    this.lastT = ctx.t;     // for dt-independent advance with audio
  }

  render(ctx, out) {
    const { t, Nx, Ny, Nz, params, utils, audio } = ctx;
    if (this.Nx !== Nx || this.Ny !== Ny || this.Nz !== Nz || !this.path) this.setup(ctx);
    const path = this.path;
    const total = path.length;
    out.fill(0);
    if (total === 0) return;

    const energy = (params.audioReact && audio) ? audio.energy : 0;
    const beat   = (params.audioReact && audio && audio.beat) ? 1 : 0;

    // --- Advance the comet head along the curve ----------------------------
    // Use accumulated time so speed tweaks stay smooth; audio energy gives the
    // comet a little extra urgency, and beats give a visible kick.
    let dt = t - this.lastT;
    if (!(dt >= 0) || dt > 0.5) dt = 0;       // guard NaN / pauses / scrubs
    this.lastT = t;
    const speed = params.speed * (1 + 0.6 * energy);
    this.head = (this.head + speed * dt) % total;
    const head = this.head;

    // --- Reveal the full fractal at a low, breathing rainbow level ----------
    // Coprime sines give an organic, non-repeating shimmer; depth (Z) adds a
    // front-to-back gradient so the volume reads as 3D rather than flat.
    if (params.showFull && params.fullLevel > 0) {
      const baseHueDrift = 0.04 * t;
      const breathe = 0.55 + 0.45 * Math.sin(t * 0.37);
      const lvl = params.fullLevel * (0.6 + 0.4 * breathe) * (1 + 0.35 * energy);
      const invNz = Nz > 1 ? 1 / (Nz - 1) : 0;
      const invTotal = 1 / total;
      for (let k = 0; k < total; k++) {
        const idx = path[k];
        const z = idx % Nz;
        const depth = z * invNz;                 // 0 (front) .. 1 (back)
        const hue = k * invTotal + baseHueDrift;
        // Travelling shimmer wave riding along the path index.
        const wave = 0.5 + 0.5 * Math.sin(k * 0.6 - t * 2.3);
        const v = lvl * (0.45 + 0.55 * wave) * (1 - 0.45 * depth);
        const c = utils.hsv(hue, 0.92, Math.min(0.5, v));
        out[idx * 3 + 0] = c[0];
        out[idx * 3 + 1] = c[1];
        out[idx * 3 + 2] = c[2];
      }
    }

    // --- Comet tail: a long rainbow streak that fades behind the head -------
    // Each step back along the curve drops one notch in brightness and shifts
    // hue, so the tail is a moving spectrum rather than one flat tint.
    const trailLen = Math.max(1, params.trailLen | 0);
    const headHueBase = (t * 0.13) % 1;          // the comet's "current" color
    const hueSpan = params.hueSpan;
    const invTrail = 1 / trailLen;
    const beatBoost = 1 + 0.8 * beat;

    for (let d = 0; d < trailLen; d++) {
      let kf = head - d;
      if (kf < 0) kf += total;
      const ki = Math.floor(kf) % total;
      const idx = path[ki];

      const a = 1 - d * invTrail;               // 1 at head -> 0 at tail end
      // Sharp, bright falloff: cubic-ish so the head is a hot point, the tail
      // a long ember.
      const intensity = a * a * (0.35 + 0.65 * a) * beatBoost;

      // Hue rides backward along the tail for the rainbow streak.
      const hue = headHueBase + (d * invTrail) * hueSpan;
      const sat = 0.95 - 0.35 * a;               // head desaturates toward white
      let c = utils.hsv(hue, sat, 1);
      let r = c[0] * intensity;
      let g = c[1] * intensity;
      let b = c[2] * intensity;

      // The leading cells blend toward the hot core color for a white-hot tip.
      if (d < 3) {
        const core = utils.parseColor(params.headColor);
        const mixAmt = (3 - d) / 3;              // 1 at head -> 0
        r = r + (core[0] - r) * mixAmt * 0.85;
        g = g + (core[1] - g) * mixAmt * 0.85;
        b = b + (core[2] - b) * mixAmt * 0.85;
      }

      addMax(out, idx, r, g, b);
    }

    // --- Head bloom: spill the comet into its curve-neighbors ---------------
    // Curve-adjacent cells are spatial neighbors (Hilbert locality), so
    // brightening them around the head fakes a glowing orb under the cube's
    // natural bloom — a real depth cue rather than a single lit voxel.
    const bloom = params.bloom;
    if (bloom > 0) {
      const hi = Math.floor(head) % total;
      const core = utils.parseColor(params.headColor);
      const span = 5;                            // cells on each side of head
      for (let o = -span; o <= span; o++) {
        if (o === 0) continue;
        let kk = (hi + o) % total;
        if (kk < 0) kk += total;
        const idx = path[kk];
        const falloff = bloom * (1 - Math.abs(o) / (span + 1));
        const g2 = falloff * falloff * 220;
        addMax(out, idx, core[0] * (g2 / 255), core[1] * (g2 / 255), core[2] * (g2 / 255));
      }
      // The head cell itself: blinding white-hot, pumped by the beat.
      const hidx = path[hi];
      const punch = 1 + 0.9 * beat + 0.4 * energy;
      addMax(out, hidx, Math.min(255, core[0] * punch),
                        Math.min(255, core[1] * punch),
                        Math.min(255, core[2] * punch));
    }
  }
}

// Max-blend a color into the output buffer, clamped to 0..255 and finite.
function addMax(out, idx, r, g, b) {
  const i = idx * 3;
  r = r > 0 ? (r < 255 ? r : 255) : 0;
  g = g > 0 ? (g < 255 ? g : 255) : 0;
  b = b > 0 ? (b < 255 ? b : 255) : 0;
  if (r > out[i]) out[i] = r;
  if (g > out[i + 1]) out[i + 1] = g;
  if (b > out[i + 2]) out[i + 2] = b;
}
