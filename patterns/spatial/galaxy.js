// Galaxy — a rotating logarithmic-spiral galaxy living in the cube.
//
// Hybrid renderer:
//   1) PER-VOXEL DENSITY FIELD. For every voxel we compute its cylindrical
//      coords in the XZ disk (radius + angle). A logarithmic-spiral density
//      function lights up the arms: stars cluster where the voxel's angle
//      matches the spiral winding for its radius. The disk has a soft vertical
//      (Y) thickness that flares slightly toward the rim, and the whole field
//      is dithered by 3D noise so the arms feel grainy and organic rather than
//      like clean ribbons. A bright gold/white core BULGE fills the center,
//      falling off to dark intergalactic space at the rim. Color grades from
//      warm gold in the core to cool blue in the outer arms.
//   2) BRIGHTER STAR POINTS. A handful of sub-voxel stars ride along the arms
//      at various radii and are splatted (trilinear, additive) so they bloom
//      as crisp hot points on top of the diffuse dust.
//
// The entire disk rotates slowly about the Y axis. Inner material winds faster
// than the rim (differential rotation) so the arms shear over time — never a
// static, repeating pinwheel.
//
// Disk plane = XZ (X right, Z depth), Y is up = galactic pole. Works for any
// Nx/Ny/Nz incl. flat Nz=1 (degenerates to a thin spiral in the X/Y face).

export const params = {
  speed:       { type: 'range', min: 0,    max: 3,   step: 0.01, default: 0.6,  label: 'Rotation speed' },
  arms:        { type: 'int',   min: 1,    max: 5,                default: 2,    label: 'Spiral arms' },
  twist:       { type: 'range', min: 1,    max: 8,   step: 0.05, default: 3.6,  label: 'Arm twist' },
  armWidth:    { type: 'range', min: 0.15, max: 1.2, step: 0.01, default: 0.55, label: 'Arm width' },
  coreSize:    { type: 'range', min: 0.05, max: 0.6, step: 0.01, default: 0.22, label: 'Core size' },
  coreGlow:    { type: 'range', min: 0.3,  max: 2.0, step: 0.01, default: 1.25, label: 'Core brightness' },
  thickness:   { type: 'range', min: 0.05, max: 1.0, step: 0.01, default: 0.32, label: 'Disk thickness' },
  diskBright:  { type: 'range', min: 0.2,  max: 2.0, step: 0.01, default: 1.0,  label: 'Disk brightness' },
  starCount:   { type: 'int',   min: 0,    max: 60,               default: 26,  label: 'Bright stars' },
  graininess:  { type: 'range', min: 0,    max: 1,   step: 0.01, default: 0.5,  label: 'Dust graininess' },
  coreColor:   { type: 'color', default: '#fff0c8' },
  armColor:    { type: 'color', default: '#5aa0ff' },
};

// Trilinear additive splat of a point (sub-voxel) into the grid.
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

export default class Galaxy {
  static name = 'Galaxy';

  setup() {
    this.angle = 0; // accumulated disk rotation (radians)
    this.stars = null;
    this.starSeed = -1;
  }

  // Build a stable set of stars distributed along the spiral arms. Each star
  // gets a base radius + an arm assignment; its angle is derived from the arm
  // so it sits ON the spiral, plus a little jitter so it isn't perfectly glued.
  buildStars(count, arms) {
    const stars = [];
    // Simple deterministic LCG so the same count/arms reproduce the same field.
    let s = 0x9e3779b9 ^ (count * 2654435761) ^ (arms * 40503);
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const arm = i % Math.max(1, arms);
      // Bias radius toward the mid-disk (sqrt push outward from the core).
      const radius = 0.12 + Math.sqrt(rnd()) * 0.95;
      const angJitter = (rnd() - 0.5) * 0.7;
      stars.push({
        arm,
        radius,
        angJitter,
        // brighter, hotter stars are rarer
        bright: 0.45 + rnd() * rnd() * 0.55,
        twinkle: rnd() * Math.PI * 2,
      });
    }
    this.stars = stars;
  }

  update(ctx) {
    const { dt, params } = ctx;
    // Slow disk rotation. Differential shear is applied per-radius at render.
    this.angle += dt * params.speed * 0.45;

    const key = params.starCount * 16 + params.arms;
    if (this.stars === null || this.starSeed !== key) {
      this.buildStars(params.starCount, params.arms);
      this.starSeed = key;
    }
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, t, params, utils } = ctx;
    const { clamp, smoothstep, mix, hsv, noise3d, parseColor } = utils;
    out.fill(0);

    const coreCol = parseColor(params.coreColor);
    const armCol  = parseColor(params.armColor);

    const arms   = Math.max(1, params.arms);
    const twist  = params.twist;
    const armW   = params.armWidth;
    const coreSz = params.coreSize;
    const thick  = params.thickness;
    const grain  = params.graininess;

    // Voxel-space centers + half-extents (guard 1-thick axes).
    const cxV = (Nx - 1) * 0.5;
    const cyV = (Ny - 1) * 0.5;
    const czV = (Nz - 1) * 0.5;
    const halfX = Nx > 1 ? (Nx - 1) * 0.5 : 1;
    const halfY = Ny > 1 ? (Ny - 1) * 0.5 : 1;
    const halfZ = Nz > 1 ? (Nz - 1) * 0.5 : 1;
    // Use the smaller of the in-plane half-extents so radius=1 reaches the rim.
    const planeHalf = Math.min(halfX, halfZ) || 1;

    const ang = this.angle;
    // Spiral coefficient: log spiral angle = twist * ln(radius) at unit scale.
    // We compare each voxel's (rotated) angle to the nearest arm phase.

    for (let x = 0; x < Nx; x++) {
      const px = (x - cxV) / planeHalf;        // -1..1-ish across disk
      for (let z = 0; z < Nz; z++) {
        const pz = (z - czV) / planeHalf;
        let radius = Math.hypot(px, pz);
        // Disk angle in the XZ plane.
        const theta = Math.atan2(pz, px);

        // Differential rotation: inner spins faster than rim. Subtract the
        // disk rotation (with a radius-dependent boost) so arms wind in time.
        const omega = ang * (1 + 0.9 / (0.25 + radius));
        // Logarithmic spiral arm phase. Stars cluster where this is near 0.
        const spin = twist * Math.log(0.18 + radius);
        let phase = theta - spin - omega;
        // Fold into nearest arm: how far (in radians) from an arm ridge.
        let armPhase = phase * arms;
        // Distance to nearest multiple of 2π, normalized to 0..1 across a gap.
        let m = armPhase / (Math.PI * 2);
        m = m - Math.floor(m);            // 0..1
        let d = Math.min(m, 1 - m) * 2;   // 0 at ridge, 1 at mid-gap

        // Arm ridge intensity: sharp bright spine, soft shoulders.
        const ridge = Math.pow(smoothstep(armW, 0, d), 1.4);

        // Radial falloff: arms live in a mid-disk annulus, fading to dark rim.
        const rim = smoothstep(1.15, 0.55, radius);     // dark beyond rim
        const inner = smoothstep(coreSz * 0.4, coreSz * 1.3, radius); // hollow under core handled separately

        // Dust graininess: 3D noise modulates the diffuse density so the arms
        // look like clustered stars, not painted ribbons. Rotates with disk.
        const nz = noise3d(
          px * 2.2 + Math.cos(ang) * 0.6,
          radius * 2.6,
          pz * 2.2 + Math.sin(ang) * 0.6
        );
        const grainMul = 1 + grain * (nz * 0.9);

        // Arm color: gold near core → blue toward rim.
        const armT = clamp(smoothstep(coreSz, 1.0, radius), 0, 1);
        const armRGB = mix(coreCol, armCol, armT);

        // Diffuse disk brightness for this column (pre vertical profile).
        let diskI = ridge * rim * inner * grainMul * params.diskBright;
        if (diskI < 0) diskI = 0;

        // Core bulge: smooth gaussian-ish gold blob, independent of arms.
        const coreI = Math.exp(-(radius * radius) / (coreSz * coreSz)) * params.coreGlow;

        for (let y = 0; y < Ny; y++) {
          const py2 = Ny > 1 ? (y - cyV) / halfY : 0; // -1..1 vertical
          // Disk vertical profile: thickness grows mildly with radius (flare).
          const localThick = thick * (0.7 + radius * 0.6);
          const vprof = Math.exp(-(py2 * py2) / (localThick * localThick + 1e-4));
          // Core is rounder (less flattened) — give it a fuller vertical glow.
          const coreVprof = Math.exp(-(py2 * py2) / (0.5 * 0.5));

          let r = 0, g = 0, b = 0;

          // Diffuse arms (color-graded).
          const dI = diskI * vprof;
          if (dI > 0) {
            r += armRGB[0] * dI;
            g += armRGB[1] * dI;
            b += armRGB[2] * dI;
          }

          // Core bulge glow (warm).
          const cI = coreI * coreVprof;
          if (cI > 0) {
            r += coreCol[0] * cI;
            g += coreCol[1] * cI;
            b += coreCol[2] * cI;
          }

          if (r === 0 && g === 0 && b === 0) continue;
          const idx = (x * Ny + y) * Nz + z;
          out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r);
          out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g);
          out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b);
        }
      }
    }

    // ---- Bright star points riding the arms (additive sub-voxel splats) ----
    const stars = this.stars;
    if (stars && stars.length) {
      for (let i = 0; i < stars.length; i++) {
        const st = stars[i];
        const radius = st.radius;
        // Place the star ON its arm's spiral ridge at its radius, then add the
        // same differential rotation the field uses so stars track the arms.
        const omega = ang * (1 + 0.9 / (0.25 + radius));
        const spin = twist * Math.log(0.18 + radius);
        const armBase = (st.arm / arms) * Math.PI * 2;
        const theta = armBase + spin + omega + st.angJitter;

        const px = Math.cos(theta) * radius;
        const pz = Math.sin(theta) * radius;

        // Back to voxel coords.
        const vx = cxV + px * planeHalf;
        const vz = czV + pz * planeHalf;
        // Stars sit near the disk plane with tiny vertical scatter.
        const vy = cyV + Math.sin(st.twinkle + radius * 6) * (Ny > 1 ? thick * halfY * 0.4 : 0);

        if (vx < -1 || vx > Nx || vz < -1 || vz > Nz) continue;

        // Twinkle + radial color grade (gold core stars, blue rim stars).
        const tw = 0.6 + 0.4 * Math.sin(t * 3.0 + st.twinkle);
        const armT = clamp(smoothstep(coreSz, 1.0, radius), 0, 1);
        const col = mix(coreCol, armCol, armT * 0.85);
        // Hot white-ish boost so stars read brighter than the dust.
        const amp = st.bright * tw * 255;
        const r = Math.min(255, col[0] * 0.4 / 255 * amp + amp * 0.55);
        const g = Math.min(255, col[1] * 0.4 / 255 * amp + amp * 0.55);
        const b = Math.min(255, col[2] * 0.4 / 255 * amp + amp * 0.55);

        splat(out, Nx, Ny, Nz, vx, vy, vz, r, g, b);
      }
    }
  }
}
