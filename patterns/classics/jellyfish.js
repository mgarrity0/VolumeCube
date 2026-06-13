// Jellyfish — a translucent, bioluminescent medusa drifting through the dark.
//
// The bell is an oblate ellipsoid that BREATHES with an asymmetric pulse
// (snap-contract, slow-relax) like real medusan jet locomotion. It reads as
// translucent jelly: a soft center glow, a bright Fresnel-style rim where the
// dome turns away from us, and a faint inner nucleus of complementary warm
// light. Below the rim a flaring skirt continues the body downward.
//
// Tentacles: `tentacleCount` luminous strands trail from the rim, splatted as
// soft additive trails so they leave glowing wakes. Each strand sways in its
// tangent-to-rim plane with a downstream-travelling wave (phase offset by
// index) so the school ripples like a living animal. Tips bleed toward a
// hotter hue and taper inward toward the axis.
//
// Bioluminescent drift: the whole creature wanders gently through the volume —
// rising/falling and easing front-to-back via coprime sines + noise — and a
// scatter of plankton sparks glimmers in the surrounding water.
//
// Color is a cyan -> magenta -> violet hue journey along the body, drifting
// slowly over time, with a warm complementary nucleus for depth.

export const params = {
  bellY:           { type: 'range', min: -0.3, max: 0.6,  step: 0.01,  default: 0.28, label: 'Bell height (Y)' },
  bellRadius:      { type: 'range', min: 0.2,  max: 0.7,  step: 0.01,  default: 0.46 },
  bellThickness:   { type: 'range', min: 0.1,  max: 0.5,  step: 0.01,  default: 0.27, label: 'Bell vertical' },
  pulseAmp:        { type: 'range', min: 0,    max: 0.3,  step: 0.01,  default: 0.16, label: 'Pulse amplitude' },
  pulseRate:       { type: 'range', min: 0,    max: 3,    step: 0.05,  default: 0.55, label: 'Pulse rate (Hz)' },
  drift:           { type: 'range', min: 0,    max: 1,    step: 0.01,  default: 0.5,  label: 'Drift amount' },
  tentacleCount:   { type: 'int',   min: 4,    max: 16,                default: 9 },
  tentacleLength:  { type: 'range', min: 0.3,  max: 1.6,  step: 0.02,  default: 1.3 },
  tentacleSpeed:   { type: 'range', min: 0,    max: 4,    step: 0.05,  default: 1.0,  label: 'Tentacle wave Hz' },
  tentacleAmp:     { type: 'range', min: 0,    max: 0.3,  step: 0.01,  default: 0.16, label: 'Tentacle wave amp' },
  tentacleBright:  { type: 'range', min: 0.1,  max: 1,    step: 0.01,  default: 0.85 },
  sparks:          { type: 'range', min: 0,    max: 1,    step: 0.01,  default: 0.45, label: 'Plankton sparks' },
  hueBase:         { type: 'range', min: 0,    max: 1,    step: 0.005, default: 0.52, label: 'Base hue' },
  hueRange:        { type: 'range', min: 0,    max: 0.6,  step: 0.005, default: 0.34, label: 'Hue spread (along Y)' },
  hueDrift:        { type: 'range', min: 0,    max: 1,    step: 0.005, default: 0.04, label: 'Hue drift (rev/sec)' },
  glow:            { type: 'range', min: 0.5,  max: 2,    step: 0.01,  default: 1.15, label: 'Glow' },
};

// Soft trilinear additive splat with optional radius-1 bloom for luminous trails.
function splat(out, Nx, Ny, Nz, x, y, z, r, g, b, bloom) {
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
  if (!bloom) return;
  // Cheap one-voxel bloom: dim halo at the nearest cell's 6 neighbours.
  const cxv = Math.round(x), cyv = Math.round(y), czv = Math.round(z);
  const hr = r * bloom, hg = g * bloom, hb = b * bloom;
  const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let k = 0; k < 6; k++) {
    const xx = cxv + nb[k][0], yy = cyv + nb[k][1], zz = czv + nb[k][2];
    if (xx < 0 || xx >= Nx || yy < 0 || yy >= Ny || zz < 0 || zz >= Nz) continue;
    const idx = (xx * Ny + yy) * Nz + zz;
    out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + hr);
    out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + hg);
    out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + hb);
  }
}

const wrap1 = (h) => ((h % 1) + 1) % 1;

export default class Jellyfish {
  static name = 'Jellyfish';

  render(ctx, out) {
    const { Nx, Ny, Nz, t, params, utils, audio } = ctx;
    out.fill(0);

    const beat = audio ? audio.energy || 0 : 0;
    const glow = params.glow;

    // ---- Asymmetric breathing pulse (fast contract, slow relax) ----
    // ph in [0,1): sharp swell near the start, gentle ease back.
    const ph = wrap1(t * params.pulseRate);
    const contract = Math.pow(Math.sin(Math.PI * Math.min(1, ph * 1.35)), 1.6);
    // Audio nudges the contraction a touch so it feels alive in a room.
    const pulse = 1 + params.pulseAmp * (contract * (1 + 0.4 * beat) - 0.35);
    const RH = params.bellRadius * pulse;
    const RV = params.bellThickness * pulse;

    // ---- Bioluminescent drift of the whole creature through the volume ----
    // Coprime sines + slow noise -> organic, non-repeating wander. Front-to-back
    // (Z) drift gives real depth, not just an in-plane bob.
    const dr = params.drift;
    const driftX = dr * (0.16 * Math.sin(t * 0.31) + 0.10 * Math.sin(t * 0.73 + 1.7));
    const driftY = dr * (0.10 * Math.sin(t * 0.23 + 0.6) + 0.05 * (1 - contract));
    const driftZ = dr * (0.18 * Math.sin(t * 0.19 + 2.3) + 0.10 * utils.noise3d(2.1, 0.0, t * 0.2));
    const bellY = params.bellY + driftY;
    const cX = driftX;          // horizontal center of the creature
    const cZ = driftZ;          // depth center
    const hueBase = params.hueBase;

    // ---- Bell body (per-voxel, restricted to the bell's vertical band) ----
    const RV2 = RV * RV;
    for (let x = 0; x < Nx; x++) {
      const cx = (Nx > 1 ? (x / (Nx - 1)) * 2 - 1 : 0) - cX;
      for (let y = 0; y < Ny; y++) {
        const cy = Ny > 1 ? (y / (Ny - 1)) * 2 - 1 : 0;
        const dyB = cy - bellY;
        if (dyB > RV * 1.15) continue;             // above the dome cap
        if (dyB < -RV * 2.0) continue;             // below the skirt base
        for (let z = 0; z < Nz; z++) {
          const cz = (Nz > 1 ? (z / (Nz - 1)) * 2 - 1 : 0) - cZ;
          const r2 = cx * cx + cz * cz;
          const rad = Math.sqrt(r2);
          let bell = 0;
          let rim = 0;
          let core = 0;

          if (dyB >= 0) {
            // Dome: oblate ellipsoid. Translucent center glow + Fresnel rim.
            const norm = r2 / (RH * RH) + (dyB * dyB) / RV2;
            // Soft jelly body: bright-ish at center, fading to the shell edge.
            bell = utils.smoothstep(1.05, 0.0, norm) * 0.55;
            // Fresnel rim: a luminous shell right at norm ~= 1 (the silhouette).
            rim = utils.smoothstep(0.55, 1.0, norm) * utils.smoothstep(1.18, 0.95, norm);
            // Warm nucleus: tiny complementary glow deep inside the dome.
            core = utils.smoothstep(0.22, 0.0, norm) * utils.smoothstep(0.0, 0.35, dyB / Math.max(1e-3, RV));
          } else {
            // Skirt: thin flaring band continuing the body down past the rim.
            const skirtY = -dyB / Math.max(1e-3, RV * 1.85); // 0 at rim, 1 at base
            const skirtR = RH * (1 + 0.22 * skirtY);
            const dEdge = Math.abs(rad - skirtR);
            const ring = utils.smoothstep(0.18, 0.03, dEdge);
            const fade = utils.smoothstep(1.0, 0.1, skirtY);
            // gentle ripple around the skirt rim for life
            const ripple = 0.85 + 0.15 * Math.sin(Math.atan2(cz, cx) * 4 + t * 2.0);
            bell = ring * fade * 0.6 * ripple;
            rim = ring * fade * 0.5;
          }

          const total = bell + rim + core;
          if (total > 0.002) {
            // Hue journeys cyan -> magenta -> violet from rim down to skirt.
            const hPos = (cy - bellY) / Math.max(1e-3, RV * 2.6);
            const hue = hueBase + hPos * params.hueRange + t * params.hueDrift;
            const bodyCol = utils.hsv(wrap1(hue), 0.75, 1);
            const rimCol = utils.hsv(wrap1(hue + 0.07), 0.45, 1);   // whiter, hotter rim
            const coreCol = utils.hsv(wrap1(hue + 0.5), 0.85, 1);   // complementary warm nucleus

            const idx = (x * Ny + y) * Nz + z;
            const r = (bodyCol[0] * bell + rimCol[0] * rim * 1.4 + coreCol[0] * core * 0.9) * glow;
            const g = (bodyCol[1] * bell + rimCol[1] * rim * 1.4 + coreCol[1] * core * 0.9) * glow;
            const b = (bodyCol[2] * bell + rimCol[2] * rim * 1.4 + coreCol[2] * core * 0.9) * glow;
            out[idx * 3 + 0] = Math.min(255, r);
            out[idx * 3 + 1] = Math.min(255, g);
            out[idx * 3 + 2] = Math.min(255, b);
          }
        }
      }
    }

    // ---- Tentacles (parametric luminous trails, sub-voxel splats) ----
    const numT = params.tentacleCount;
    const tLen = params.tentacleLength;
    const baseY = bellY - RV * 0.15; // attach just below the bell rim
    const segs = 30;
    const tBloom = 0.10 * glow;      // soft halo strength for trail glow

    for (let i = 0; i < numT; i++) {
      const baseAngle = (i / numT) * Math.PI * 2;
      const ax = Math.cos(baseAngle);
      const az = Math.sin(baseAngle);
      const baseX = cX + ax * RH * 0.88;
      const baseZ = cZ + az * RH * 0.88;
      // Perpendicular axis around the rim — primary wave plane for this tentacle.
      const px = -az, pz = ax;
      const phaseI = i * 0.7;
      // Each tentacle gets its own hue tint along the band for a richer school.
      const hueT = hueBase + params.hueRange * 0.5 + 0.06 * Math.sin(i * 1.3) + t * params.hueDrift;

      for (let s = 0; s <= segs; s++) {
        const u = s / segs;
        // Downstream-travelling wave; amplitude grows toward the tip.
        const phase = t * params.tentacleSpeed * Math.PI * 2 - u * 5.5 + phaseI;
        const amp = params.tentacleAmp * (u * 0.8 + 0.2 * u * u);
        // Secondary slower wave on the orthogonal axis -> 3D curling motion.
        const swirl = 0.45 * amp * Math.sin(phase * 0.6 + 1.1);
        const off = amp * Math.sin(phase);
        const cx = baseX + off * px + swirl * ax - ax * 0.06 * u;
        const cy = baseY - tLen * u;
        const cz = baseZ + off * pz + swirl * az - az * 0.06 * u;

        const vx = (cx + 1) * 0.5 * (Nx - 1);
        const vy = (cy + 1) * 0.5 * (Ny - 1);
        const vz = (cz + 1) * 0.5 * (Nz - 1);
        if (vy < 0 || vy >= Ny) continue;

        // Trail fade: bright at the bell, glowing taper toward the tip; a
        // travelling brightness pulse runs down each strand like a nerve flash.
        const flash = 0.7 + 0.3 * Math.sin(phase * 0.5 - u * 2.0);
        const fade = (1 - u * 0.35) * params.tentacleBright * flash;
        // Tips bleed to a hotter (shifted) hue.
        const hue = hueT + 0.18 * u;
        const sat = 0.7 - 0.35 * u;
        const c = utils.hsv(wrap1(hue), Math.max(0, sat), 1);
        const f = fade * glow;
        splat(out, Nx, Ny, Nz, vx, vy, vz, c[0] * f, c[1] * f, c[2] * f, tBloom * (1 - u * 0.5));
      }
    }

    // ---- Plankton sparks: drifting bioluminescent motes in the water ----
    const nSparks = Math.round(params.sparks * 26);
    for (let i = 0; i < nSparks; i++) {
      // Deterministic per-spark pseudo-random seeds.
      const sa = Math.sin(i * 12.9898) * 43758.5453;
      const sb = Math.sin(i * 78.233) * 12543.123;
      const r1 = sa - Math.floor(sa);
      const r2 = sb - Math.floor(sb);
      const speed = 0.05 + 0.12 * r1;
      // Slow upward drift, wrapping through the volume; gentle lateral sway.
      const sy = wrap1(r2 + t * speed);                      // [0,1) up the cube
      const sx = wrap1(r1 + 0.04 * Math.sin(t * 0.3 + i));   // lateral wander
      const sz = wrap1(r2 * 0.7 + r1 * 0.3 + 0.05 * Math.sin(t * 0.21 + i * 2.0));
      // Twinkle so they shimmer rather than sit static.
      const tw = 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(t * (1.5 + r1 * 2) + i * 1.7)), 3);
      const vx = sx * (Nx - 1);
      const vy = sy * (Ny - 1);
      const vz = sz * (Nz - 1);
      const hue = hueBase + 0.05 + 0.2 * r2 + t * params.hueDrift;
      const c = utils.hsv(wrap1(hue), 0.55, 1);
      const f = tw * 0.5 * glow;
      splat(out, Nx, Ny, Nz, vx, vy, vz, c[0] * f, c[1] * f, c[2] * f, 0.06 * glow);
    }
  }
}
