// Orbits — gravitational N-body ballet inside the cube.
//
// One or two massive, glowing attractors sit near the center and bob gently.
// A cloud of lighter bodies falls around them on elliptical paths, integrated
// with simple softened Newtonian gravity in many substeps per frame so the
// curves stay smooth at any speed. Each body keeps a short trail history that
// is splatted (trilinear, additive) into the voxel grid and color-graded by
// SPEED: hot white/orange at perihelion (fast, near a star), cooling through
// gold to deep cyan/blue at aphelion (slow, far away). The attractors pulse
// with a bright core and a soft falloff halo.
//
// Self-stable: any body that escapes the cube (or stalls / falls into a core)
// is re-seeded onto a fresh near-circular orbit, so the system never empties
// out and never collapses to a frozen pile. Works for any Nx/Ny/Nz incl. Nz=1
// (gravity & rendering gracefully flatten into the available plane).

export const params = {
  speed:     { type: 'range', min: 0,    max: 3,    step: 0.01, default: 1.0,  label: 'Time scale' },
  bodies:    { type: 'int',   min: 8,    max: 90,               default: 42,   label: 'Orbiting bodies' },
  twoStars:  { type: 'toggle',                                  default: true, label: 'Binary system' },
  gravity:   { type: 'range', min: 0.2,  max: 6,    step: 0.05, default: 2.2,  label: 'Gravity strength' },
  trailLen:  { type: 'int',   min: 2,    max: 28,               default: 16,   label: 'Trail length' },
  starGlow:  { type: 'range', min: 0,    max: 3,    step: 0.05, default: 1.4,  label: 'Star brightness' },
  bobble:    { type: 'range', min: 0,    max: 1,    step: 0.01, default: 0.45, label: 'Star bob' },
  trailGlow: { type: 'range', min: 0.3,  max: 3,    step: 0.05, default: 1.25, label: 'Trail brightness' },
};

// Trilinear additive splat of a colored point into the voxel buffer.
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
        const idx = ((xx * Ny + yy) * Nz + zz) * 3;
        out[idx]     = Math.min(255, out[idx]     + r * w);
        out[idx + 1] = Math.min(255, out[idx + 1] + g * w);
        out[idx + 2] = Math.min(255, out[idx + 2] + b * w);
      }
    }
  }
}

export default class Orbits {
  static name = 'Orbits';

  setup(ctx) {
    const { Nx, Ny, Nz } = ctx;
    this.cx = (Nx - 1) * 0.5;
    this.cy = (Ny - 1) * 0.5;
    this.cz = (Nz - 1) * 0.5;
    // Characteristic radius of the playable volume (used for orbit scaling
    // and escape detection). For Nz=1 the depth term drops out naturally.
    this.R = 0.5 * Math.max(2, Math.min(Nx, Ny, Nz > 1 ? Nz : Infinity));
    if (!isFinite(this.R)) this.R = 0.5 * Math.min(Nx, Ny);

    this.flat = Nz <= 1; // 2D mode: keep everything in the z=0 plane.
    this.stars = [];
    this.bodies = [];
    this.seedStars(ctx);
    const n = ctx.params.bodies | 0;
    for (let i = 0; i < n; i++) this.bodies.push(this.spawnBody(ctx));
  }

  // Total gravitational mass scale; tuned so orbits fill the cube nicely.
  muTotal(ctx) {
    return ctx.params.gravity * this.R * this.R * this.R * 0.06;
  }

  seedStars(ctx) {
    const two = !!ctx.params.twoStars;
    this.stars.length = 0;
    if (two) {
      // Binary: two stars on opposite sides of center, share the total mass.
      const sep = this.R * 0.42;
      this.stars.push({ phase: Math.random() * 6.283, off: sep, m: 0.55, hue: 0.06 });
      this.stars.push({ phase: Math.random() * 6.283, off: -sep, m: 0.45, hue: 0.62 });
    } else {
      this.stars.push({ phase: Math.random() * 6.283, off: 0, m: 1.0, hue: 0.08 });
    }
  }

  // Current world-space positions of the stars (with gentle bob + binary spin).
  starPositions(ctx) {
    const { t, params } = ctx;
    const bob = params.bobble * this.R * 0.18;
    const out = [];
    if (this.stars.length === 2) {
      // Slow mutual rotation of the binary about the center.
      const spin = t * 0.25 * params.speed;
      for (let i = 0; i < 2; i++) {
        const s = this.stars[i];
        const ang = spin + (i === 0 ? 0 : Math.PI);
        const r = Math.abs(s.off);
        const x = this.cx + Math.cos(ang) * r;
        const y = this.cy + Math.sin(t * 0.7 + s.phase) * bob;
        const z = this.flat ? 0 : this.cz + Math.sin(ang) * r * 0.6;
        out.push({ x, y, z, m: s.m, hue: s.hue });
      }
    } else {
      const s = this.stars[0];
      out.push({
        x: this.cx + Math.sin(t * 0.5 + s.phase) * bob * 0.6,
        y: this.cy + Math.sin(t * 0.9 + s.phase) * bob,
        z: this.flat ? 0 : this.cz + Math.cos(t * 0.6 + s.phase) * bob * 0.6,
        m: s.m, hue: s.hue,
      });
    }
    return out;
  }

  // Create one orbiting body on a near-circular orbit at a random radius,
  // with velocity ~ sqrt(mu/r) perpendicular to the radius vector (3D).
  spawnBody(ctx) {
    const mu = this.muTotal(ctx);
    const r = this.R * (0.45 + Math.random() * 0.85);
    // Random direction on a sphere (or circle in flat mode).
    let dx, dy, dz;
    if (this.flat) {
      const a = Math.random() * 6.283;
      dx = Math.cos(a); dy = Math.sin(a); dz = 0;
    } else {
      // Bias the inclination toward the viewing plane so motion reads as
      // depth-rich loops rather than a flat disk.
      const u = Math.random() * 2 - 1;
      const a = Math.random() * 6.283;
      const s = Math.sqrt(1 - u * u);
      dx = s * Math.cos(a); dy = s * Math.sin(a); dz = u * 0.85;
    }
    const px = this.cx + dx * r;
    const py = this.cy + dy * r;
    const pz = (this.flat ? 0 : this.cz) + dz * r;

    // Orbital speed for a (near) circular orbit, with a little eccentricity
    // injected by random scaling so paths are ellipses, not perfect circles.
    const vmag = Math.sqrt(mu / Math.max(0.5, r)) * (0.78 + Math.random() * 0.5);
    // Pick a velocity direction perpendicular to the radius vector.
    let ax, ay, az;
    if (this.flat) {
      ax = -dy; ay = dx; az = 0;
    } else {
      // Cross radius with a fixed-ish axis, fall back if near-parallel.
      let refx = 0, refy = 0, refz = 1;
      if (Math.abs(dz) > 0.9) { refx = 1; refy = 0; refz = 0; }
      ax = dy * refz - dz * refy;
      ay = dz * refx - dx * refz;
      az = dx * refy - dy * refx;
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al; ay /= al; az /= al;
    }
    return {
      x: px, y: py, z: pz,
      vx: ax * vmag, vy: ay * vmag, vz: az * vmag,
      trail: [],          // flat [x,y,z,spd, ...] newest pushed at end
      age: 0,
    };
  }

  update(ctx) {
    const { dt, params, Nx, Ny, Nz } = ctx;

    // Re-seed stars if the binary toggle changed.
    const wantTwo = !!params.twoStars;
    if ((this.stars.length === 2) !== wantTwo) this.seedStars(ctx);

    // Match body count to the param.
    const want = params.bodies | 0;
    while (this.bodies.length < want) this.bodies.push(this.spawnBody(ctx));
    while (this.bodies.length > want) this.bodies.pop();

    const speed = params.speed;
    if (speed <= 0) return; // paused — keep current frame frozen.

    const mu = this.muTotal(ctx);
    const stars = this.starPositions(ctx);
    // Softening length: avoids singular forces near a star core.
    const soft2 = (this.R * 0.16) * (this.R * 0.16);
    const maxTrail = Math.max(2, params.trailLen | 0);

    // Many substeps keep elliptical arcs smooth even at high speed.
    const substeps = Math.max(4, Math.ceil(48 * Math.min(1.5, speed)));
    const h = (dt * speed) / substeps;

    // Escape / collapse bounds.
    const escapeR = this.R * 2.6;
    const escR2 = escapeR * escapeR;

    for (let bi = 0; bi < this.bodies.length; bi++) {
      const b = this.bodies[bi];
      let { x, y, z, vx, vy, vz } = b;

      for (let s = 0; s < substeps; s++) {
        // Accumulate softened gravity from each star (semi-implicit Euler:
        // update velocity then position for better energy behavior).
        let ax = 0, ay = 0, az = 0;
        for (let k = 0; k < stars.length; k++) {
          const st = stars[k];
          const rx = st.x - x, ry = st.y - y, rz = this.flat ? 0 : st.z - z;
          const d2 = rx * rx + ry * ry + rz * rz + soft2;
          const inv = 1 / d2;
          const invDist = Math.sqrt(inv);
          const f = mu * st.m * inv * invDist; // mu*m / (d2)^1.5
          ax += rx * f; ay += ry * f; az += rz * f;
        }
        vx += ax * h; vy += ay * h; vz += az * h;
        x += vx * h; y += vy * h; z += vz * h;
        if (this.flat) { z = 0; vz = 0; }
      }

      b.x = x; b.y = y; b.z = z; b.vx = vx; b.vy = vy; b.vz = vz;
      b.age += dt * speed;

      // Speed magnitude for color grading (perihelion hot, aphelion cool).
      const spd = Math.hypot(vx, vy, vz);

      // Record trail sample.
      const tr = b.trail;
      tr.push(x, y, z, spd);
      const cap = maxTrail * 4;
      if (tr.length > cap) tr.splice(0, tr.length - cap);

      // Self-stabilize: re-seed escapees, NaNs, or near-frozen stragglers.
      const dxc = x - this.cx, dyc = y - this.cy, dzc = this.flat ? 0 : z - this.cz;
      const distCenter2 = dxc * dxc + dyc * dyc + dzc * dzc;
      const bad =
        !isFinite(x) || !isFinite(y) || !isFinite(z) ||
        distCenter2 > escR2 ||
        (b.age > 1.5 && spd < 1e-3);
      if (bad) this.bodies[bi] = this.spawnBody(ctx);
    }
  }

  // Map an orbital speed to a hot→cool color. Reference speed scales with the
  // characteristic circular velocity so grading is shape-independent.
  speedColor(ctx, spd, intensity) {
    const { utils, params } = ctx;
    const vref = Math.sqrt(this.muTotal(ctx) / Math.max(0.5, this.R * 0.7));
    // Normalize: fast (perihelion) -> ~1, slow (aphelion) -> ~0.
    const f = utils.clamp((spd / (vref * 1.6)), 0, 1);
    // Cool blue (aphelion) → cyan → gold → hot white-orange (perihelion).
    // Hue sweeps from ~0.60 (blue) down toward ~0.06 (orange) as f rises.
    const hue = 0.60 - 0.54 * Math.pow(f, 0.85);
    const sat = 1 - 0.55 * f * f;        // desaturate toward white when fast
    const val = (0.45 + 0.55 * f);        // brighter at perihelion
    const c = utils.hsv(((hue % 1) + 1) % 1, utils.clamp(sat, 0, 1), 1);
    const g = intensity * val * params.trailGlow * 255;
    return [c[0] / 255 * g, c[1] / 255 * g, c[2] / 255 * g];
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, params, utils } = ctx;
    out.fill(0);

    // --- Comet trails (drawn first so star cores overwrite-add on top) ---
    const bodiesArr = this.bodies;
    for (let bi = 0; bi < bodiesArr.length; bi++) {
      const tr = bodiesArr[bi].trail;
      const n = tr.length / 4;
      if (n === 0) continue;
      for (let i = 0; i < n; i++) {
        const x = tr[i * 4 + 0];
        const y = tr[i * 4 + 1];
        const z = tr[i * 4 + 2];
        const spd = tr[i * 4 + 3];
        // age 0 = oldest (faint tail), 1 = newest (bright head).
        const ageF = (i + 1) / n;
        const intensity = ageF * ageF; // quadratic fade toward the tail
        const [r, g, bl] = this.speedColor(ctx, spd, intensity);
        if (r < 0.5 && g < 0.5 && bl < 0.5) continue;
        splat(out, Nx, Ny, Nz, x, y, this.flat ? 0 : z, r, g, bl);
      }
    }

    // --- Stars: bright core + soft glowing halo ---
    const stars = this.starPositions(ctx);
    const glow = params.starGlow;
    if (glow > 0) {
      // Pulse the cores slightly so they read as "alive".
      const pulse = 0.85 + 0.15 * Math.sin(ctx.t * 2.3);
      const haloR = Math.max(1.0, this.R * 0.5);
      const haloR2 = haloR * haloR;
      for (let k = 0; k < stars.length; k++) {
        const st = stars[k];
        const baseC = utils.hsv(((st.hue % 1) + 1) % 1, 0.55, 1);
        // White-hot core color (blend star hue with white).
        const coreR = utils.mix([255, 255, 255], baseC, 0.35);

        // Halo: iterate voxels within a bounded box around the star.
        const minx = Math.max(0, Math.floor(st.x - haloR));
        const maxx = Math.min(Nx - 1, Math.ceil(st.x + haloR));
        const miny = Math.max(0, Math.floor(st.y - haloR));
        const maxy = Math.min(Ny - 1, Math.ceil(st.y + haloR));
        const sz = this.flat ? 0 : st.z;
        const minz = Math.max(0, Math.floor(sz - haloR));
        const maxz = Math.min(Nz - 1, Math.ceil(sz + haloR));
        for (let xx = minx; xx <= maxx; xx++) {
          const ddx = xx - st.x;
          for (let yy = miny; yy <= maxy; yy++) {
            const ddy = yy - st.y;
            for (let zz = minz; zz <= maxz; zz++) {
              const ddz = this.flat ? 0 : zz - sz;
              const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d2 > haloR2) continue;
              const d = Math.sqrt(d2);
              // Inverse-square-ish falloff with a soft, bright core.
              const fall = utils.smoothstep(1, 0, d / haloR);
              const halo = fall * fall * glow * st.m * pulse * 0.9;
              if (halo <= 0) continue;
              const idx = ((xx * Ny + yy) * Nz + zz) * 3;
              out[idx]     = Math.min(255, out[idx]     + baseC[0] * halo);
              out[idx + 1] = Math.min(255, out[idx + 1] + baseC[1] * halo);
              out[idx + 2] = Math.min(255, out[idx + 2] + baseC[2] * halo);
            }
          }
        }

        // Blazing core splat (sub-voxel, additive) — clamps to white.
        const coreI = glow * (0.9 + 0.6 * st.m) * pulse;
        splat(out, Nx, Ny, Nz, st.x, st.y, sz,
          coreR[0] * coreI, coreR[1] * coreI, coreR[2] * coreI);
      }
    }
  }
}
