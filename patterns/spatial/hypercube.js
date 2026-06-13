// Hypercube — a rotating 4D tesseract, glowing inside the cube.
//
// The tesseract has 16 vertices at (±1, ±1, ±1, ±1) and 32 edges — an edge
// joins two vertices that differ in exactly one coordinate. We tumble it in
// THREE 4D planes (XW, YW, ZW) at coprime rates, plus a gentle XY spin, so the
// shape never repeats and the famous "cube turning inside-out" inversion keeps
// folding through itself. Projection 4D → 3D is a perspective divide on W:
// vertices near the 4D camera (w → +persp) blow up huge and blaze bright,
// while the far inner cube shrinks and dims — that W-depth is the hero cue.
//
// Colour is a journey along the W axis: the near hull rides one end of a hue
// sweep, the far hull the other, with a slow global drift so the whole figure
// breathes through the spectrum instead of sitting on one tint. Edges are drawn
// as glowing tubes (bright core + soft halo) via trilinear splatting; vertices
// are over-driven into bright pulsing nodes. Beats pump the glow and goose the
// spin so it feels alive in a room.
//
// Works for any Nx/Ny/Nz including thin slabs (Nz=1..3): the figure is fit
// per-axis with a margin and all divides are guarded. Nothing throws.

export const params = {
  speed:          { type: 'range', min: 0,   max: 2,   step: 0.01, default: 0.5,  label: 'Spin speed' },
  perspective:    { type: 'range', min: 1.8, max: 6,   step: 0.05, default: 2.6,  label: 'W-distance' },
  hue:            { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.55, label: 'Base hue' },
  hueSpan:        { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.42, label: 'W hue spread' },
  hueDrift:       { type: 'range', min: -0.5,max: 0.5, step: 0.01, default: 0.05, label: 'Hue drift /s' },
  edgeBrightness: { type: 'range', min: 0.3, max: 2.0, step: 0.05, default: 1.0,  label: 'Edge glow' },
  showVertices:   { type: 'toggle', default: true },
  audioReact:     { type: 'toggle', default: true },
};

// 16 vertices of the unit tesseract, indexed so bit k = sign on axis k.
const VERTS = (() => {
  const v = [];
  for (let i = 0; i < 16; i++) {
    v.push([
      (i & 1) ? 1 : -1,
      (i & 2) ? 1 : -1,
      (i & 4) ? 1 : -1,
      (i & 8) ? 1 : -1,
    ]);
  }
  return v;
})();

// 32 edges — pairs of vertices that differ in exactly one axis.
const EDGES = (() => {
  const e = [];
  for (let i = 0; i < 16; i++) {
    for (let j = i + 1; j < 16; j++) {
      let diff = 0;
      for (let k = 0; k < 4; k++) if (VERTS[i][k] !== VERTS[j][k]) diff++;
      if (diff === 1) e.push([i, j]);
    }
  }
  return e;
})();

// Additive trilinear splat: deposit (r,g,b) across the 8 voxels around a
// fractional position, weighted by proximity. Clamps to 255 so overlapping
// strands bloom rather than wrap.
function splat(out, Nx, Ny, Nz, x, y, z, r, g, b) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  for (let dx = 0; dx <= 1; dx++) {
    const xx = x0 + dx;
    if (xx < 0 || xx >= Nx) continue;
    const wx = dx ? fx : 1 - fx;
    for (let dy = 0; dy <= 1; dy++) {
      const yy = y0 + dy;
      if (yy < 0 || yy >= Ny) continue;
      const wy = dy ? fy : 1 - fy;
      for (let dz = 0; dz <= 1; dz++) {
        const zz = z0 + dz;
        if (zz < 0 || zz >= Nz) continue;
        const w = wx * wy * (dz ? fz : 1 - fz);
        if (w <= 0) continue;
        const idx = (xx * Ny + yy) * Nz + zz;
        out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r * w);
        out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g * w);
        out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b * w);
      }
    }
  }
}

export default class Hypercube {
  static name = 'Hypercube';

  setup() {
    // Independent angle accumulators so each 4D plane drifts at its own rate.
    this.aXW = 0.0;
    this.aYW = 0.7;
    this.aZW = 1.9;
    this.aXY = 0.0;
    this.beat = 0; // decaying beat envelope
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, dt, t, params, utils } = ctx;
    out.fill(0);

    const audio = ctx.audio || { energy: 0, low: 0, high: 0, beat: false };
    const react = params.audioReact;

    // Beat envelope: snap up on a beat, decay smoothly. Drives glow + a tiny
    // rotation kick so the tesseract "pops" on the music.
    if (react && audio.beat) this.beat = 1;
    this.beat *= Math.exp(-dt * 3.5);
    const energy = react ? (audio.energy || 0) : 0;

    // Advance the four rotation planes at coprime-ish multiples so the motion
    // never lands back on itself. Energy gently speeds the whole tumble.
    const sp = params.speed * (1 + energy * 0.6);
    this.aXW += sp * 1.00 * dt;
    this.aYW += sp * 0.61 * dt;
    this.aZW += sp * 0.43 * dt;
    this.aXY += sp * 0.27 * dt;

    const cXW = Math.cos(this.aXW), sXW = Math.sin(this.aXW);
    const cYW = Math.cos(this.aYW), sYW = Math.sin(this.aYW);
    const cZW = Math.cos(this.aZW), sZW = Math.sin(this.aZW);
    const cXY = Math.cos(this.aXY), sXY = Math.sin(this.aXY);

    const persp = params.perspective;

    // Project all 16 vertices: rotate in 4D, then perspective-divide on W.
    // Track the largest projected radius on each axis so we can fit per-axis.
    const proj = new Array(16);
    let maxAbsX = 1e-4, maxAbsY = 1e-4, maxAbsZ = 1e-4;
    for (let i = 0; i < 16; i++) {
      let x = VERTS[i][0], y = VERTS[i][1], z = VERTS[i][2], w = VERTS[i][3];

      // XW plane.
      let nx = x * cXW - w * sXW;
      let nw = x * sXW + w * cXW;
      x = nx; w = nw;
      // YW plane.
      let ny = y * cYW - w * sYW;
      nw = y * sYW + w * cYW;
      y = ny; w = nw;
      // ZW plane — this trio is what makes the cube fold inside-out.
      let nz = z * cZW - w * sZW;
      nw = z * sZW + w * cZW;
      z = nz; w = nw;
      // 3D XY spin so the silhouette is never an axis-aligned square.
      nx = x * cXY - y * sXY;
      ny = x * sXY + y * cXY;
      x = nx; y = ny;

      // 4D → 3D perspective divide. Guard the denominator so a vertex passing
      // through the 4D camera plane can't blow up to Infinity.
      const denom = persp - w;
      const k = persp / (Math.abs(denom) < 0.25 ? (denom < 0 ? -0.25 : 0.25) : denom);
      const px = x * k, py = y * k, pz = z * k;
      proj[i] = { x: px, y: py, z: pz, w };

      const ax = Math.abs(px), ay = Math.abs(py), az = Math.abs(pz);
      if (ax > maxAbsX) maxAbsX = ax;
      if (ay > maxAbsY) maxAbsY = ay;
      if (az > maxAbsZ) maxAbsZ = az;
    }

    // Per-axis fit with margin so the figure fills the cube without clipping,
    // even on thin slabs (Nz=1 collapses the Z splats to one plane).
    const cxV = (Nx - 1) * 0.5;
    const cyV = (Ny - 1) * 0.5;
    const czV = (Nz - 1) * 0.5;
    const margin = 0.92;
    const sX = Nx > 1 ? (cxV * margin) / maxAbsX : 0;
    const sY = Ny > 1 ? (cyV * margin) / maxAbsY : 0;
    const sZ = Nz > 1 ? (czV * margin) / maxAbsZ : 0;

    const toVox = (p) => ({
      x: cxV + p.x * sX,
      y: cyV + p.y * sY,
      z: czV + p.z * sZ,
    });

    // Colour: hue runs along the W axis (near hull vs far hull) with a slow
    // drift so the whole figure breathes through the spectrum.
    const drift = t * params.hueDrift;
    const baseHue = params.hue + drift;
    const span = params.hueSpan;

    // wToShade maps the interpolated 4D W (∈[-~1,~1]) to a 0..1 depth: 1 = near
    // (toward camera, big & bright), 0 = far (deep inside, small & dim).
    const wToShade = (w) => {
      const d = persp - w;
      // Larger projection factor ⇒ nearer in 4D. Normalise to a calm 0..1.
      const k = persp / (Math.abs(d) < 0.25 ? 0.25 : Math.abs(d));
      return utils.clamp((k - 0.6) / 2.2, 0, 1);
    };

    const glow = params.edgeBrightness * (1 + this.beat * 0.8);

    // --- Edges as glowing tubes -------------------------------------------
    // Per-step brightness kept modest; trilinear spread + halo build the core.
    for (let e = 0; e < EDGES.length; e++) {
      const a = proj[EDGES[e][0]];
      const b = proj[EDGES[e][1]];
      const va = toVox(a), vb = toVox(b);
      const dx = vb.x - va.x, dy = vb.y - va.y, dz = vb.z - va.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const steps = Math.max(2, Math.ceil(len * 1.5));
      for (let s = 0; s <= steps; s++) {
        const tt = s / steps;
        const x = va.x + dx * tt;
        const y = va.y + dy * tt;
        const z = va.z + dz * tt;

        // Interpolate 4D W to drive colour + depth fade.
        const w = a.w + (b.w - a.w) * tt;
        const shade = wToShade(w);
        // Near edges blaze, far edges recede — high dynamic range in depth.
        const val = (0.28 + 0.72 * shade) * glow;
        const sat = 1 - 0.25 * shade; // near = a touch whiter/hotter
        const h = baseHue + span * (shade - 0.5);
        const col = utils.hsv(((h % 1) + 1) % 1, utils.clamp(sat, 0, 1), 1);

        const core = val * 150;
        const cr = col[0] / 255 * core;
        const cg = col[1] / 255 * core;
        const cb = col[2] / 255 * core;
        splat(out, Nx, Ny, Nz, x, y, z, cr, cg, cb);

        // Soft 1-voxel halo to fatten the strand into a glowing tube.
        const halo = core * 0.35;
        const hr = col[0] / 255 * halo;
        const hg = col[1] / 255 * halo;
        const hb = col[2] / 255 * halo;
        splat(out, Nx, Ny, Nz, x + 0.7, y, z, hr, hg, hb);
        splat(out, Nx, Ny, Nz, x - 0.7, y, z, hr, hg, hb);
        splat(out, Nx, Ny, Nz, x, y + 0.7, z, hr, hg, hb);
        splat(out, Nx, Ny, Nz, x, y - 0.7, z, hr, hg, hb);
        if (Nz > 1) {
          splat(out, Nx, Ny, Nz, x, y, z + 0.7, hr, hg, hb);
          splat(out, Nx, Ny, Nz, x, y, z - 0.7, hr, hg, hb);
        }
      }
    }

    // --- Vertices as bright pulsing nodes ---------------------------------
    if (params.showVertices) {
      // Gentle per-vertex pulse at coprime rates so the 16 nodes twinkle
      // independently rather than blinking in unison.
      for (let i = 0; i < 16; i++) {
        const v = toVox(proj[i]);
        const shade = wToShade(proj[i].w);
        const h = baseHue + span * (shade - 0.5);
        // Nodes pulse and pop on the beat; nearer nodes are brighter & bigger.
        const pulse = 0.75 + 0.25 * Math.sin(t * 2.3 + i * 1.7);
        const node = (0.55 + 0.9 * shade) * pulse * glow;
        const col = utils.hsv(((h % 1) + 1) % 1, 0.85 - 0.3 * shade, 1);
        const amp = node * 230;
        const cr = col[0] / 255 * amp;
        const cg = col[1] / 255 * amp;
        const cb = col[2] / 255 * amp;
        // Heavy central splat for a hot core, plus a tight halo for a soft node.
        splat(out, Nx, Ny, Nz, v.x, v.y, v.z, cr, cg, cb);
        splat(out, Nx, Ny, Nz, v.x, v.y, v.z, cr * 0.6, cg * 0.6, cb * 0.6);
        const hr = cr * 0.3, hg = cg * 0.3, hb = cb * 0.3;
        splat(out, Nx, Ny, Nz, v.x + 0.8, v.y, v.z, hr, hg, hb);
        splat(out, Nx, Ny, Nz, v.x - 0.8, v.y, v.z, hr, hg, hb);
        splat(out, Nx, Ny, Nz, v.x, v.y + 0.8, v.z, hr, hg, hb);
        splat(out, Nx, Ny, Nz, v.x, v.y - 0.8, v.z, hr, hg, hb);
        if (Nz > 1) {
          splat(out, Nx, Ny, Nz, v.x, v.y, v.z + 0.8, hr, hg, hb);
          splat(out, Nx, Ny, Nz, v.x, v.y, v.z - 0.8, hr, hg, hb);
        }
      }
    }
  }
}
