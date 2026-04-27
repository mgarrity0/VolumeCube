// Jellyfish — pulsing translucent bell with trailing wavy tentacles.
//
// The bell is an oblate ellipsoid centered at (0, bellY, 0) in cube
// coords [-1, 1]; it breathes by scaling its radii with a sine pulse.
// Below the rim, an outward-flaring "skirt" band continues the body
// into the upper-mid volume.
//
// Tentacles: `tentacleCount` strands hang from the bell rim, sampled
// densely along their length and splatted as soft trails. Each strand
// sways in the tangent-to-rim direction with phase offset by index, so
// the school of tentacles ripples like real medusa locomotion.
//
// Color is a bioluminescent hue band (cyan→magenta) that drifts slowly
// and shifts subtly along the body's vertical extent.

export const params = {
  bellY:           { type: 'range', min: -0.3, max: 0.6,  step: 0.01,  default: 0.3,  label: 'Bell height (Y)' },
  bellRadius:      { type: 'range', min: 0.2,  max: 0.7,  step: 0.01,  default: 0.45 },
  bellThickness:   { type: 'range', min: 0.1,  max: 0.5,  step: 0.01,  default: 0.25, label: 'Bell vertical' },
  pulseAmp:        { type: 'range', min: 0,    max: 0.3,  step: 0.01,  default: 0.12, label: 'Pulse amplitude' },
  pulseRate:       { type: 'range', min: 0,    max: 3,    step: 0.05,  default: 0.7,  label: 'Pulse rate (Hz)' },
  tentacleCount:   { type: 'int',   min: 4,    max: 16,                default: 8 },
  tentacleLength:  { type: 'range', min: 0.3,  max: 1.6,  step: 0.02,  default: 1.2 },
  tentacleSpeed:   { type: 'range', min: 0,    max: 4,    step: 0.05,  default: 1.2,  label: 'Tentacle wave Hz' },
  tentacleAmp:     { type: 'range', min: 0,    max: 0.3,  step: 0.01,  default: 0.14, label: 'Tentacle wave amp' },
  tentacleBright:  { type: 'range', min: 0.1,  max: 1,    step: 0.01,  default: 0.7 },
  hueBase:         { type: 'range', min: 0,    max: 1,    step: 0.005, default: 0.78, label: 'Base hue' },
  hueRange:        { type: 'range', min: 0,    max: 0.5,  step: 0.005, default: 0.18, label: 'Hue spread (along Y)' },
  hueDrift:        { type: 'range', min: 0,    max: 1,    step: 0.005, default: 0.05, label: 'Hue drift (rev/sec)' },
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

export default class Jellyfish {
  static name = 'Jellyfish';

  render(ctx, out) {
    const { Nx, Ny, Nz, t, params, utils } = ctx;
    out.fill(0);

    const pulse = 1 + params.pulseAmp * Math.sin(t * params.pulseRate * Math.PI * 2);
    const RH = params.bellRadius * pulse;
    const RV = params.bellThickness * pulse;
    const bellY = params.bellY;
    const hueBase = params.hueBase;

    // ---- Bell body (per-voxel, restricted to the bell's vertical band) ----
    for (let x = 0; x < Nx; x++) {
      const cx = Nx > 1 ? (x / (Nx - 1)) * 2 - 1 : 0;
      for (let y = 0; y < Ny; y++) {
        const cy = Ny > 1 ? (y / (Ny - 1)) * 2 - 1 : 0;
        const dyB = cy - bellY;
        if (dyB > RV * 1.05) continue;             // above the dome cap
        if (dyB < -RV * 1.8) continue;             // below the skirt base
        for (let z = 0; z < Nz; z++) {
          const cz = Nz > 1 ? (z / (Nz - 1)) * 2 - 1 : 0;
          const r2 = cx * cx + cz * cz;
          let bell = 0;

          if (dyB >= 0) {
            // Dome: oblate ellipsoid filled with a center-bright falloff
            // so the bell reads as translucent jelly rather than a hard shell.
            const norm = r2 / (RH * RH) + (dyB * dyB) / (RV * RV);
            bell = utils.smoothstep(1.0, 0.2, norm);
          } else {
            // Skirt: thin band that flares outward as it descends from the rim.
            const skirtY = -dyB / Math.max(1e-3, RV * 1.6); // 0 at rim, 1 at base
            const skirtR = RH * (1 + 0.18 * skirtY);
            const dr = Math.abs(Math.sqrt(r2) - skirtR);
            const ring = utils.smoothstep(0.16, 0.04, dr);
            const fade = utils.smoothstep(1.0, 0.2, skirtY);
            bell = ring * fade * 0.7;
          }

          if (bell > 0) {
            const hue = hueBase + (cy - bellY) * params.hueRange + t * params.hueDrift;
            const c = utils.hsv(((hue % 1) + 1) % 1, 0.65, 1);
            const idx = (x * Ny + y) * Nz + z;
            out[idx * 3 + 0] = c[0] * bell;
            out[idx * 3 + 1] = c[1] * bell;
            out[idx * 3 + 2] = c[2] * bell;
          }
        }
      }
    }

    // ---- Tentacles (parametric strands, splatted at sub-voxel intervals) ----
    const numT = params.tentacleCount;
    const tLen = params.tentacleLength;
    const baseY = bellY - RV * 0.1; // attach just below the bell rim

    for (let i = 0; i < numT; i++) {
      const baseAngle = (i / numT) * Math.PI * 2;
      const ax = Math.cos(baseAngle);
      const az = Math.sin(baseAngle);
      const baseX = ax * RH * 0.85;
      const baseZ = az * RH * 0.85;
      // Perpendicular axis around the rim — wave plane for this tentacle.
      const px = -az, pz = ax;
      const phaseI = i * 0.6;

      const segs = 28;
      for (let s = 0; s <= segs; s++) {
        const u = s / segs;
        const phase = t * params.tentacleSpeed * Math.PI * 2 - u * 5 + phaseI;
        // Wave amplitude grows downstream; small inward drift so tips taper toward axis.
        const amp = params.tentacleAmp * u;
        const cx = baseX + amp * Math.sin(phase) * px - ax * 0.05 * u;
        const cy = baseY - tLen * u;
        const cz = baseZ + amp * Math.sin(phase) * pz - az * 0.05 * u;

        const vx = (cx + 1) * 0.5 * (Nx - 1);
        const vy = (cy + 1) * 0.5 * (Ny - 1);
        const vz = (cz + 1) * 0.5 * (Nz - 1);
        if (vy < 0 || vy >= Ny) continue;

        const fade = (1 - u * 0.4) * params.tentacleBright;
        const hue = hueBase + 0.05 + t * params.hueDrift;
        const c = utils.hsv(((hue % 1) + 1) % 1, 0.6, 1);
        splat(out, Nx, Ny, Nz, vx, vy, vz, c[0] * fade, c[1] * fade, c[2] * fade);
      }
    }
  }
}
