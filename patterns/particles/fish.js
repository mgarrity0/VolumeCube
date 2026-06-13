// Fish — a school of fish swimming around the volume.
//
// Each fish is a 3D boid: it steers by the three classic flocking rules
// (separation, alignment, cohesion) plus a little wander and a smooth
// turn-away from the cube walls, so the school swirls, splits, and
// regroups as a living shoal rather than a fixed formation.
//
// A fish is drawn as a short oriented streak along its heading: a bright
// near-white head tapering back through its body hue into a dim tail, so
// you can read which way each one is going. Glows are deposited with
// additive trilinear splatting (sub-voxel) so bodies bloom softly and the
// empty water between them stays dark for depth.
//
// Defaults render a warm tropical school of ~24 fish; `hueSpread` fans
// the school across a slice of the color wheel, and a couple of "lead"
// fish take an accent hue so the eye has something to follow.

export const params = {
  count:      { type: 'int',   min: 4,   max: 60,             default: 24,  label: 'School size' },
  speed:      { type: 'range', min: 0.5, max: 8,   step: 0.1, default: 3.0, label: 'Swim speed' },
  schooling:  { type: 'range', min: 0,   max: 2,   step: 0.05, default: 1.0, label: 'Schooling' },
  wander:     { type: 'range', min: 0,   max: 2,   step: 0.05, default: 0.6, label: 'Wander' },
  bodyLength: { type: 'range', min: 1,   max: 4,   step: 0.1, default: 2.2, label: 'Body length' },
  bright:     { type: 'range', min: 0.2, max: 1,   step: 0.02, default: 0.85, label: 'Brightness' },
  hue:        { type: 'range', min: 0,   max: 1,   step: 0.005, default: 0.07, label: 'School hue' },
  hueSpread:  { type: 'range', min: 0,   max: 0.5, step: 0.01, default: 0.12, label: 'Hue spread' },
  accentHue:  { type: 'range', min: 0,   max: 1,   step: 0.005, default: 0.55, label: 'Lead-fish hue' },
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

export default class Fish {
  static name = 'Fish';

  setup(ctx) {
    const { Nx, Ny, Nz, params } = ctx;
    const n = params.count | 0;
    this.fish = [];
    for (let i = 0; i < n; i++) {
      // Spawn somewhere inside the volume with a random heading.
      const dir = randDir();
      this.fish.push({
        x: Math.random() * Math.max(1, Nx - 1),
        y: Math.random() * Math.max(1, Ny - 1),
        z: Math.random() * Math.max(1, Nz - 1),
        vx: dir[0], vy: dir[1], vz: dir[2],
        // Per-fish hue offset within the school's spread, and a wander phase.
        hueOff: (Math.random() * 2 - 1),
        wphase: Math.random() * 1000,
        // ~1 in 6 is a brighter "lead" fish in the accent hue.
        lead: Math.random() < 0.16,
      });
    }
    this.count = n;
  }

  update(ctx) {
    const { Nx, Ny, Nz, dt, t, params } = ctx;
    const fish = this.fish;
    if (!fish || fish.length !== (params.count | 0)) {
      // Count changed via the slider — reseed.
      this.setup(ctx);
      return;
    }
    const speed = params.speed;
    const school = params.schooling;
    const wander = params.wander;
    const n = fish.length;

    // Neighborhood radii in voxels.
    const perceive = 3.5;
    const sepDist = 1.8;
    const maxTurn = 6.0 * dt; // radians-ish steering cap per second

    for (let i = 0; i < n; i++) {
      const f = fish[i];
      // Accumulators for the three flocking rules.
      let sepx = 0, sepy = 0, sepz = 0;
      let alx = 0, aly = 0, alz = 0;
      let cox = 0, coy = 0, coz = 0;
      let neigh = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const g = fish[j];
        const dx = g.x - f.x, dy = g.y - f.y, dz = g.z - f.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > perceive * perceive || d2 < 1e-4) continue;
        const d = Math.sqrt(d2);
        neigh++;
        alx += g.vx; aly += g.vy; alz += g.vz;     // alignment: match headings
        cox += g.x;  coy += g.y;  coz += g.z;       // cohesion: steer to center
        if (d < sepDist) {                          // separation: push apart
          sepx -= dx / d; sepy -= dy / d; sepz -= dz / d;
        }
      }

      let ax = 0, ay = 0, az = 0;
      if (neigh > 0) {
        // Cohesion toward neighbor centroid.
        cox = cox / neigh - f.x; coy = coy / neigh - f.y; coz = coz / neigh - f.z;
        ax += (alx / neigh) * 0.5 * school;
        ay += (aly / neigh) * 0.5 * school;
        az += (alz / neigh) * 0.5 * school;
        ax += cox * 0.05 * school;
        ay += coy * 0.05 * school;
        az += coz * 0.05 * school;
      }
      ax += sepx * 1.4; ay += sepy * 1.4; az += sepz * 1.4;

      // Wander: smooth meander from coprime sines + a touch of noise.
      const wp = f.wphase + t;
      ax += Math.sin(wp * 1.3) * wander;
      ay += Math.sin(wp * 0.7 + 2.1) * wander * 0.6;  // gentler vertical drift
      az += Math.sin(wp * 1.1 + 4.2) * wander;

      // Wall avoidance: smooth turn back inward near each face. Scales with
      // the axis size so thin axes (small Nz) don't trap the fish.
      const m = 2.5;
      ax += wallPush(f.x, Nx, m);
      ay += wallPush(f.y, Ny, m);
      az += wallPush(f.z, Nz, m);

      // Apply steering as a capped turn, then renormalize to swim speed.
      f.vx += ax * maxTurn; f.vy += ay * maxTurn; f.vz += az * maxTurn;
      let vmag = Math.hypot(f.vx, f.vy, f.vz);
      if (vmag < 1e-4) { const d = randDir(); f.vx = d[0]; f.vy = d[1]; f.vz = d[2]; vmag = 1; }
      f.vx = (f.vx / vmag) * speed;
      f.vy = (f.vy / vmag) * speed;
      f.vz = (f.vz / vmag) * speed;

      // Integrate, with a hard clamp so a fish can never leave the box.
      f.x = clampf(f.x + f.vx * dt, 0, Nx - 1);
      f.y = clampf(f.y + f.vy * dt, 0, Ny - 1);
      f.z = clampf(f.z + f.vz * dt, 0, Math.max(0, Nz - 1));
    }
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, params, utils } = ctx;
    out.fill(0);
    const fish = this.fish;
    if (!fish) return;

    const bodyLen = params.bodyLength;
    const bright = params.bright * 255;
    const segs = 5;                         // body samples head→tail

    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      const vmag = Math.hypot(f.vx, f.vy, f.vz) || 1;
      const hx = f.vx / vmag, hy = f.vy / vmag, hz = f.vz / vmag;

      // Body hue: school hue + this fish's offset, or the accent hue for leads.
      const hue = f.lead
        ? params.accentHue
        : params.hue + f.hueOff * params.hueSpread;

      for (let s = 0; s < segs; s++) {
        // s=0 head (at +heading), s=segs-1 tail (behind).
        const along = (0.5 - s / (segs - 1)) * bodyLen;   // +half..-half
        const px = f.x + hx * along;
        const py = f.y + hy * along;
        const pz = f.z + hz * along;
        const tt = s / (segs - 1);                        // 0 head → 1 tail
        // Head bright + desaturated (near white), tail dim + saturated.
        const sat = utils.clamp(0.35 + tt * 0.65, 0, 1);
        const val = (1 - tt * 0.8) * (f.lead ? 1.1 : 1.0);
        const [r, g, b] = utils.hsv(hue, sat, Math.min(1, val));
        const k = bright * (1 - tt * 0.65);
        splat(out, Nx, Ny, Nz, px, py, pz, (r / 255) * k, (g / 255) * k, (b / 255) * k);
      }
    }
  }
}

function wallPush(p, dim, margin) {
  if (dim <= 1) return 0;                  // flat axis — nothing to avoid
  const lo = margin, hi = dim - 1 - margin;
  if (p < lo) return (lo - p) / margin;    // push toward +
  if (p > hi) return -(p - hi) / margin;   // push toward -
  return 0;
}

function clampf(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function randDir() {
  // Uniform-ish direction on the unit sphere.
  const theta = Math.acos(2 * Math.random() - 1);
  const phi = Math.random() * Math.PI * 2;
  return [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
}
