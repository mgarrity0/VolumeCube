// Hypercube — rotating 4D tesseract projected to 3D.
//
// The tesseract has 16 vertices at (±1, ±1, ±1, ±1) and 32 edges — an
// edge connects two vertices that differ in exactly one coordinate. We
// rotate in the XW and ZW planes (the "4th-dimension" rotations that
// produce the classic "cube turning inside out" look) plus a gentle XY
// spin so a stationary camera always sees fresh angles. Projection from
// 4D → 3D is a standard perspective divide on the W coordinate.
//
// Edges are rasterized by trilinear splatting the same way fireworks.js
// draws particles, which reads as smooth lines at voxel resolution.

export const params = {
  speed:         { type: 'range', min: 0,   max: 2,   step: 0.01, default: 0.45 },
  perspective:   { type: 'range', min: 1.8, max: 6,   step: 0.05, default: 3.0, label: 'W-distance' },
  colorNear:     { type: 'color', default: '#80c0ff' },
  colorFar:      { type: 'color', default: '#ff4080' },
  edgeBrightness:{ type: 'range', min: 0.3, max: 1.5, step: 0.05, default: 0.85 },
  showVertices:  { type: 'toggle', default: true },
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

export default class Hypercube {
  static name = 'Hypercube';

  setup() {
    this.angleXW = 0;
    this.angleZW = 0;
    this.angleXY = 0;
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, dt, params, utils } = ctx;
    out.fill(0);

    this.angleXW += params.speed * dt;
    this.angleZW += params.speed * 0.6 * dt;
    this.angleXY += params.speed * 0.3 * dt;

    const halfX = (Nx - 1) / 2;
    const halfY = (Ny - 1) / 2;
    const halfZ = (Nz - 1) / 2;
    // Fit the projected tesseract inside the shortest axis so nothing clips.
    const scale = Math.min(Nx, Ny, Nz) * 0.28;
    const persp = params.perspective;

    // Project all 16 vertices once so edges can look up endpoints.
    const projected = new Array(16);
    for (let i = 0; i < 16; i++) {
      let [x, y, z, w] = VERTS[i];
      // XW plane rotation.
      const c1 = Math.cos(this.angleXW), s1 = Math.sin(this.angleXW);
      const x1 = x * c1 - w * s1;
      const w1 = x * s1 + w * c1;
      x = x1; w = w1;
      // ZW plane rotation.
      const c2 = Math.cos(this.angleZW), s2 = Math.sin(this.angleZW);
      const z1 = z * c2 - w * s2;
      const w2 = z * s2 + w * c2;
      z = z1; w = w2;
      // XY spin so the projected shape is never a symmetric axis-aligned silhouette.
      const c3 = Math.cos(this.angleXY), s3 = Math.sin(this.angleXY);
      const x2 = x * c3 - y * s3;
      const y2 = x * s3 + y * c3;
      x = x2; y = y2;
      // 4D → 3D perspective divide. Vertices closer to w = +persp project larger.
      const k = 1 / (persp - w);
      projected[i] = { x: x * k * persp, y: y * k * persp, z: z * k * persp, w };
    }

    const [nr, ng, nb] = utils.parseColor(params.colorNear);
    const [fr, fg, fb] = utils.parseColor(params.colorFar);
    const bright = params.edgeBrightness;

    // Walk every edge, coloring by interpolated W so the 4D depth reads as a
    // color gradient — the "near" and "far" faces of the tesseract stay legible
    // even when their 3D positions overlap.
    for (const [a, b] of EDGES) {
      const va = projected[a], vb = projected[b];
      const dx = vb.x - va.x, dy = vb.y - va.y, dz = vb.z - va.z;
      const len3 = Math.sqrt(dx * dx + dy * dy + dz * dz) * scale;
      const steps = Math.max(2, Math.ceil(len3 * 2));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = halfX + (va.x + dx * t) * scale;
        const y = halfY + (va.y + dy * t) * scale;
        const z = halfZ + (va.z + dz * t) * scale;
        const wBlend = ((va.w + (vb.w - va.w) * t) + 1) * 0.5;
        const r = (nr + (fr - nr) * wBlend) * bright;
        const g = (ng + (fg - ng) * wBlend) * bright;
        const bc = (nb + (fb - nb) * wBlend) * bright;
        splat(out, Nx, Ny, Nz, x, y, z, r, g, bc);
      }
    }

    if (params.showVertices) {
      for (let i = 0; i < 16; i++) {
        const v = projected[i];
        const wBlend = (v.w + 1) * 0.5;
        const r = nr + (fr - nr) * wBlend;
        const g = ng + (fg - ng) * wBlend;
        const bc = nb + (fb - nb) * wBlend;
        // Double-splat to brighten vertex points above the line weight.
        splat(out, Nx, Ny, Nz, halfX + v.x * scale, halfY + v.y * scale, halfZ + v.z * scale, r, g, bc);
        splat(out, Nx, Ny, Nz, halfX + v.x * scale, halfY + v.y * scale, halfZ + v.z * scale, r, g, bc);
      }
    }
  }
}
