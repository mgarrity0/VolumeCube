// Metaballs — N moving scalar-field sources summed into a glowing isosurface.
//
// Each blob contributes r² / d² to an implicit field. We threshold the sum
// to carve a blobby surface out of pure black, then add an INNER GLOW: past
// the surface the field keeps climbing, and we map that excess to a bright,
// near-white hot core so every blob reads as a distinct luminous body rather
// than a flat fill. A tight smoothstep skin gives crisp, bloom-friendly edges;
// beyond the skin the voxel is truly off (0,0,0) so the darkness between blobs
// stays black and the shapes pop from across a room.
//
// Color is per-blob by default: each source owns a hue and the merge seams
// blend hues by field weight, so two blobs touching produce a natural gradient.
// A slow global hue drift keeps the palette on a journey instead of one tint.
//
// Motion uses three coprime axis frequencies + phase offsets per blob (summed
// sines) so blobs wander the FULL depth of the volume — front-to-back, not just
// in a plane — on smooth, non-repeating, looped paths that never escape the cube.

export const params = {
  count:      { type: 'int',   min: 1,    max: 12,  default: 5, label: 'Blob count' },
  size:       { type: 'range', min: 0.3,  max: 2,   step: 0.05, default: 1.0 },
  speed:      { type: 'range', min: 0,    max: 3,   step: 0.01, default: 0.7 },
  threshold:  { type: 'range', min: 0.6,  max: 4,   step: 0.05, default: 1.9 },
  softness:   { type: 'range', min: 0.05, max: 1.5, step: 0.05, default: 0.45 },
  glow:       { type: 'range', min: 0,    max: 1,   step: 0.02, default: 0.7, label: 'Core glow' },
  colorMode:  { type: 'select', options: ['per-blob', 'rainbow', 'thermal', 'solid'], default: 'per-blob' },
  solidColor: { type: 'color', default: '#3aa0ff' },
};

export default class Metaballs {
  static name = 'Metaballs';

  setup() {
    // Pre-seed 12 blob "personalities" — we sample as many as `count` each
    // frame so changing the slider keeps the existing blobs stable. Hues are
    // spread around the wheel (golden-angle) so the default palette is varied
    // and the complementary accents read instead of muddying together.
    this.seed = [];
    const golden = 0.61803398875;
    for (let i = 0; i < 12; i++) {
      this.seed.push({
        phaseX: Math.random() * Math.PI * 2,
        phaseY: Math.random() * Math.PI * 2,
        phaseZ: Math.random() * Math.PI * 2,
        // Coprime-ish primary rates plus a small secondary wobble per axis so
        // paths sweep the whole volume and never settle into a flat orbit.
        freqX:  0.31 + Math.random() * 0.42,
        freqY:  0.43 + Math.random() * 0.40,
        freqZ:  0.53 + Math.random() * 0.44,
        wobX:   0.17 + Math.random() * 0.20,
        wobY:   0.19 + Math.random() * 0.20,
        wobZ:   0.23 + Math.random() * 0.20,
        phW:    Math.random() * Math.PI * 2,
        hue:    (i * golden) % 1,
      });
    }
  }

  render(ctx, out) {
    const { t, Nx, Ny, Nz, params, utils, audio } = ctx;
    out.fill(0);

    const count = Math.max(1, Math.min(params.count | 0, this.seed.length));
    const halfX = (Nx - 1) / 2;
    const halfY = (Ny - 1) / 2;
    const halfZ = (Nz - 1) / 2;

    // Radius keyed to the LARGER axes (not the smallest) so blobs keep real
    // presence on thin rigs (e.g. 10x10x3 or even 10x10x1) where the Z extent
    // is tiny — otherwise the field can never reach threshold and the cube goes
    // dark. We average the two largest half-extents. Beat gives a subtle pulse.
    const beat = audio ? audio.energy * 0.18 : 0;
    const halves = [halfX, halfY, halfZ].sort((a, b) => b - a);
    const charHalf = Math.max(0.75, (halves[0] + halves[1]) * 0.5);
    const radius = params.size * charHalf * (0.46 + beat);
    const r2 = radius * radius;

    const thresh = Math.max(0.2, params.threshold);
    const soft = Math.max(0.02, params.softness);
    const glow = utils.clamp(params.glow, 0, 1);
    const sc = utils.parseColor(params.solidColor);
    const mode = params.colorMode;

    const spd = params.speed;
    const hueDrift = t * 0.04;

    // Travel fractions: how far a blob roams from center on each axis. We push
    // the depth (z) travel hard so blobs visibly cross front-to-back. On a thin
    // Z rig the absolute travel is small but still spans the available layers.
    const travX = halfX * 0.74;
    const travY = halfY * 0.74;
    const travZ = halfZ * 0.82;

    // Pre-compute blob positions + hues for this frame so the per-voxel inner
    // loop is pure arithmetic.
    const bx = new Float32Array(count);
    const by = new Float32Array(count);
    const bz = new Float32Array(count);
    const bh = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const s = this.seed[i];
      const px = Math.sin(t * spd * s.freqX + s.phaseX) * 0.7
               + Math.sin(t * spd * s.wobX + s.phW) * 0.3;
      const py = Math.sin(t * spd * s.freqY + s.phaseY) * 0.7
               + Math.sin(t * spd * s.wobY + s.phW * 1.3) * 0.3;
      const pz = Math.sin(t * spd * s.freqZ + s.phaseZ) * 0.7
               + Math.sin(t * spd * s.wobZ + s.phW * 0.7) * 0.3;
      bx[i] = halfX + px * travX;
      by[i] = halfY + py * travY;
      bz[i] = halfZ + pz * travZ;
      bh[i] = (s.hue + hueDrift) % 1;
    }

    // Edge band for the surface skin (crisp but anti-aliased).
    const edge0 = thresh - soft;
    const edge1 = thresh + soft;
    // Inner-glow span: how much field excess above the surface maps to a hot
    // white core. Scales with threshold so the core sits inside the body.
    const coreSpan = thresh * 1.4 + soft;

    for (let x = 0; x < Nx; x++) {
      for (let y = 0; y < Ny; y++) {
        for (let z = 0; z < Nz; z++) {
          let field = 0;
          let hueX = 0, hueY = 0, weightAcc = 0;
          for (let i = 0; i < count; i++) {
            const dx = x - bx[i];
            const dy = y - by[i];
            const dz = z - bz[i];
            const d2 = dx * dx + dy * dy + dz * dz + 0.35;
            const c = r2 / d2;
            field += c;
            // Accumulate hue as a 2D unit-vector sum so blends wrap correctly
            // around the color wheel (no ugly red→green-through-grey seams).
            const ang = bh[i] * Math.PI * 2;
            hueX += Math.cos(ang) * c;
            hueY += Math.sin(ang) * c;
            weightAcc += c;
          }

          // Surface membership — tight skin, hard black outside.
          const alpha = utils.smoothstep(edge0, edge1, field);
          if (alpha < 0.012) continue;

          // Inner glow: 0 at the skin, →1 deep inside the body. Drives a punchy
          // value ramp AND a desaturating push toward white-hot at the cores,
          // giving high dynamic range so blobs are bright bodies, not flat fills.
          const core = utils.smoothstep(edge1, edge1 + coreSpan, field);
          // Value: dim translucent skin → blazing core.
          const v = utils.clamp(0.22 + 0.78 * core, 0, 1) * alpha;
          // Saturation collapses toward the core when glow is high.
          const sat = utils.clamp(0.95 - glow * 0.85 * core, 0.05, 1);

          let r, g, b;
          if (mode === 'solid') {
            // Tint the body, blow the core toward white.
            const w = glow * core;
            r = (sc[0] * (1 - w) + 255 * w) / 255 * v * 255;
            g = (sc[1] * (1 - w) + 255 * w) / 255 * v * 255;
            b = (sc[2] * (1 - w) + 255 * w) / 255 * v * 255;
          } else if (mode === 'rainbow') {
            let hue = ((field - thresh) * 0.16 + hueDrift) % 1;
            if (hue < 0) hue += 1;
            const cc = utils.hsv(hue, sat, v);
            r = cc[0]; g = cc[1]; b = cc[2];
          } else if (mode === 'thermal') {
            // Cold blue rim → magenta → orange → white-hot core.
            const k = core;
            r = (0.15 + 0.85 * k) * v * 255;
            g = (k * k * 0.9) * v * 255;
            b = (0.95 - 0.55 * k) * v * 255;
          } else {
            // per-blob: circular-mean hue of the contributing blobs.
            let hue = Math.atan2(hueY, hueX) / (Math.PI * 2);
            if (hue < 0) hue += 1;
            const cc = utils.hsv(hue, sat, v);
            r = cc[0]; g = cc[1]; b = cc[2];
          }

          const idx = (x * Ny + y) * Nz + z;
          out[idx * 3 + 0] = r < 0 ? 0 : r > 255 ? 255 : r;
          out[idx * 3 + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
          out[idx * 3 + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
        }
      }
    }
  }
}
