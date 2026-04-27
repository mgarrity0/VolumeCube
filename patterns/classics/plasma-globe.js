// Plasma Globe — branching electric tendrils from a bright core to the cube faces.
//
// Each tendril is a polyline from the cube center to a random point on the
// nearest cube face, with `segments-2` interior points jittered for the
// jagged "lightning-in-a-jar" look. Tendrils have a quick rise + slow fade
// life cycle; new ones spawn at `flickerRate` Hz, replacing the oldest, so
// the globe is always alive with shifting arcs.
//
// A bright unblended core sits at the cube center; tendrils accumulate
// additively over it via splat, which gives the hot-white flash where
// they emerge.

export const params = {
  tendrils:    { type: 'int',   min: 2,   max: 12,   default: 5 },
  flickerRate: { type: 'range', min: 0.1, max: 5,    step: 0.05, default: 1.5, label: 'Discharge rate (Hz)' },
  segments:    { type: 'int',   min: 4,   max: 20,   default: 10 },
  jitter:      { type: 'range', min: 0,   max: 0.5,  step: 0.01, default: 0.18, label: 'Path jitter (frac)' },
  fadeTime:    { type: 'range', min: 0.2, max: 3,    step: 0.05, default: 0.8, label: 'Tendril life (sec)' },
  coreSize:    { type: 'range', min: 0,   max: 3,    step: 0.05, default: 0.9, label: 'Core radius (voxels)' },
  coreColor:   { type: 'color', default: '#ffffff' },
  arcColor:    { type: 'color', default: '#aa66ff' },
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

function spawnTendril(Nx, Ny, Nz, params) {
  const cx = (Nx - 1) / 2, cy = (Ny - 1) / 2, cz = (Nz - 1) / 2;
  // Rejection-free uniform direction on the unit sphere.
  const theta = Math.acos(2 * Math.random() - 1);
  const phi = Math.random() * Math.PI * 2;
  const dx = Math.sin(theta) * Math.cos(phi);
  const dy = Math.cos(theta);
  const dz = Math.sin(theta) * Math.sin(phi);

  // Walk from center until we hit a cube face — find the smallest t along
  // the ray that intersects any of the six bounding planes.
  const halfX = cx, halfY = cy, halfZ = cz;
  const tx = halfX / Math.max(1e-3, Math.abs(dx));
  const ty = halfY / Math.max(1e-3, Math.abs(dy));
  const tz = halfZ / Math.max(1e-3, Math.abs(dz));
  const tMax = Math.min(tx, ty, tz);

  const ex = cx + dx * tMax;
  const ey = cy + dy * tMax;
  const ez = cz + dz * tMax;

  // Build a polyline center → end, each interior midpoint jittered randomly
  // in voxel space. Endpoints stay clean so arcs anchor to core and face.
  const segs = Math.max(2, params.segments | 0);
  const j = params.jitter;
  const points = [[cx, cy, cz]];
  for (let i = 1; i < segs; i++) {
    const u = i / segs;
    const mx = cx + (ex - cx) * u + (Math.random() - 0.5) * j * Nx;
    const my = cy + (ey - cy) * u + (Math.random() - 0.5) * j * Ny;
    const mz = cz + (ez - cz) * u + (Math.random() - 0.5) * j * Nz;
    points.push([mx, my, mz]);
  }
  points.push([ex, ey, ez]);

  return {
    points,
    age: 0,
    life: params.fadeTime * (0.7 + Math.random() * 0.6),
  };
}

export default class PlasmaGlobe {
  static name = 'Plasma Globe';

  setup() {
    this.tendrils = [];
    this.spawnAcc = 0;
  }

  update(ctx) {
    const { dt, Nx, Ny, Nz, params } = ctx;

    // Maintain the requested population — fill in if we're below target,
    // periodically retire the oldest to keep the look churning.
    while (this.tendrils.length < params.tendrils) {
      this.tendrils.push(spawnTendril(Nx, Ny, Nz, params));
    }

    this.spawnAcc += params.flickerRate * dt;
    while (this.spawnAcc >= 1) {
      let oldestI = 0, oldestAge = -1;
      for (let i = 0; i < this.tendrils.length; i++) {
        if (this.tendrils[i].age > oldestAge) { oldestAge = this.tendrils[i].age; oldestI = i; }
      }
      if (this.tendrils.length >= params.tendrils) this.tendrils.splice(oldestI, 1);
      this.tendrils.push(spawnTendril(Nx, Ny, Nz, params));
      this.spawnAcc -= 1;
    }

    for (let i = this.tendrils.length - 1; i >= 0; i--) {
      this.tendrils[i].age += dt;
      if (this.tendrils[i].age >= this.tendrils[i].life) this.tendrils.splice(i, 1);
    }
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, params, utils } = ctx;
    out.fill(0);

    const cx = (Nx - 1) / 2, cy = (Ny - 1) / 2, cz = (Nz - 1) / 2;
    const [coreR, coreG, coreB] = utils.parseColor(params.coreColor);
    const [aR, aG, aB] = utils.parseColor(params.arcColor);

    // Bright core — small radial falloff around the cube center.
    const cr = params.coreSize;
    if (cr > 0) {
      const ix0 = Math.max(0, Math.floor(cx - cr - 1));
      const ix1 = Math.min(Nx - 1, Math.ceil(cx + cr + 1));
      const iy0 = Math.max(0, Math.floor(cy - cr - 1));
      const iy1 = Math.min(Ny - 1, Math.ceil(cy + cr + 1));
      const iz0 = Math.max(0, Math.floor(cz - cr - 1));
      const iz1 = Math.min(Nz - 1, Math.ceil(cz + cr + 1));
      for (let x = ix0; x <= ix1; x++) {
        for (let y = iy0; y <= iy1; y++) {
          for (let z = iz0; z <= iz1; z++) {
            const dx = x - cx, dy = y - cy, dz = z - cz;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const k = utils.smoothstep(cr * 1.6, 0, d);
            if (k <= 0) continue;
            const idx = (x * Ny + y) * Nz + z;
            out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + coreR * k);
            out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + coreG * k);
            out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + coreB * k);
          }
        }
      }
    }

    // Tendrils.
    for (const tend of this.tendrils) {
      const ageT = tend.age / tend.life;
      // Quick rise (5%) then power-curve decay so each arc flashes then fades.
      const intensity = ageT < 0.05
        ? ageT / 0.05
        : Math.pow(1 - (ageT - 0.05) / 0.95, 1.5);

      const pts = tend.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0, z0] = pts[i];
        const [x1, y1, z1] = pts[i + 1];
        const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const n = Math.max(2, Math.ceil(len * 1.5));
        for (let j = 0; j <= n; j++) {
          const u = j / n;
          splat(out, Nx, Ny, Nz, x0 + dx * u, y0 + dy * u, z0 + dz * u,
                aR * intensity, aG * intensity, aB * intensity);
        }
      }
    }
  }
}
