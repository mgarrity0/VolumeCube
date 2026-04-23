// Metaballs — N moving scalar-field sources summed and thresholded.
//
// Each blob contributes r² / d² to an implicit field; we threshold the
// sum to produce a blobby isosurface and soften the boundary with
// smoothstep so the edge reads as a translucent skin rather than a hard
// voxel cut. The "per-blob" color mode weights the hue contribution by
// each blob's field strength so the seams where two blobs merge produce
// a natural color blend.
//
// Motion is parameterized by phase offsets + three independent axis
// frequencies per blob — cheaper than integrating velocity and produces
// smooth, looped motion that never escapes the cube.

export const params = {
  count:      { type: 'int',   min: 1,   max: 12,  default: 5, label: 'Blob count' },
  size:       { type: 'range', min: 0.3, max: 2,   step: 0.05, default: 1.1 },
  speed:      { type: 'range', min: 0,   max: 3,   step: 0.01, default: 0.6 },
  threshold:  { type: 'range', min: 0.3, max: 3,   step: 0.05, default: 1.1 },
  softness:   { type: 'range', min: 0.05, max: 2,  step: 0.05, default: 0.6 },
  colorMode:  { type: 'select', options: ['rainbow', 'thermal', 'solid', 'per-blob'], default: 'per-blob' },
  solidColor: { type: 'color', default: '#80c0ff' },
};

export default class Metaballs {
  static name = 'Metaballs';

  setup() {
    // Pre-seed 12 blob "personalities" — we sample as many as `count`
    // each frame so changing the slider keeps the existing blobs stable.
    this.seed = [];
    for (let i = 0; i < 12; i++) {
      this.seed.push({
        phaseX: Math.random() * Math.PI * 2,
        phaseY: Math.random() * Math.PI * 2,
        phaseZ: Math.random() * Math.PI * 2,
        freqX: 0.3 + Math.random() * 0.6,
        freqY: 0.4 + Math.random() * 0.6,
        freqZ: 0.5 + Math.random() * 0.6,
        hue: Math.random(),
      });
    }
  }

  render(ctx, out) {
    const { t, Nx, Ny, Nz, params, utils } = ctx;
    const count = Math.min(params.count, this.seed.length);
    const halfX = (Nx - 1) / 2;
    const halfY = (Ny - 1) / 2;
    const halfZ = (Nz - 1) / 2;
    // Radius keyed to the smallest axis so blobs stay inside the volume.
    const halfMin = Math.min(halfX, halfY, halfZ);
    const radius = params.size * halfMin * 0.55;
    const r2 = radius * radius;
    const thresh = params.threshold;
    const soft = Math.max(0.01, params.softness);
    const [sr, sg, sb] = utils.parseColor(params.solidColor);

    // Pre-compute blob positions for this frame so the per-voxel inner
    // loop is just arithmetic.
    const bx = new Float32Array(count);
    const by = new Float32Array(count);
    const bz = new Float32Array(count);
    const bh = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const s = this.seed[i];
      bx[i] = halfX + Math.sin(t * params.speed * s.freqX + s.phaseX) * halfX * 0.7;
      by[i] = halfY + Math.sin(t * params.speed * s.freqY + s.phaseY) * halfY * 0.7;
      bz[i] = halfZ + Math.sin(t * params.speed * s.freqZ + s.phaseZ) * halfZ * 0.7;
      bh[i] = s.hue;
    }

    for (let x = 0; x < Nx; x++) {
      for (let y = 0; y < Ny; y++) {
        for (let z = 0; z < Nz; z++) {
          let field = 0;
          let hueAcc = 0, weightAcc = 0;
          for (let i = 0; i < count; i++) {
            const dx = x - bx[i];
            const dy = y - by[i];
            const dz = z - bz[i];
            const d2 = dx * dx + dy * dy + dz * dz + 0.001;
            const c = r2 / d2;
            field += c;
            hueAcc += bh[i] * c;
            weightAcc += c;
          }
          const alpha = utils.smoothstep(thresh - soft, thresh + soft, field);
          const idx = (x * Ny + y) * Nz + z;
          if (alpha < 0.01) {
            out[idx * 3 + 0] = 0;
            out[idx * 3 + 1] = 0;
            out[idx * 3 + 2] = 0;
            continue;
          }
          let r, g, b;
          if (params.colorMode === 'solid') {
            r = sr * alpha; g = sg * alpha; b = sb * alpha;
          } else if (params.colorMode === 'per-blob') {
            const hue = hueAcc / (weightAcc + 0.001);
            const c = utils.hsv(hue, 0.85, alpha);
            r = c[0]; g = c[1]; b = c[2];
          } else if (params.colorMode === 'thermal') {
            // Cold-to-hot ramp: deep blue → magenta → yellow → near-white.
            const k = utils.clamp((field - thresh) / (2 * soft + 1), 0, 1);
            r = (0.2 + 0.8 * k) * 255 * alpha;
            g = k * k * 255 * alpha;
            b = (0.9 - 0.6 * k) * 255 * alpha;
          } else {
            // Rainbow keyed to field intensity with a slow global drift.
            let hue = ((field - thresh) * 0.15 + t * 0.05) % 1;
            if (hue < 0) hue += 1;
            const c = utils.hsv(hue, 0.9, alpha);
            r = c[0]; g = c[1]; b = c[2];
          }
          out[idx * 3 + 0] = Math.min(255, r);
          out[idx * 3 + 1] = Math.min(255, g);
          out[idx * 3 + 2] = Math.min(255, b);
        }
      }
    }
  }
}
