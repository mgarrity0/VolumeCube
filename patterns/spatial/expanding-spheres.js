// Expanding Spheres — bright concentric shells detonate outward from the cube's
// heart and sweep through the full volume. Each shell is a crisp, color-cycling
// surface with a hot inner edge and a soft outer bloom; shells are born on a
// steady, slightly organic cadence so 2-3 are always in flight, kissing the
// corners at their peak before fading to black. A pulsing core marks each birth.
//
// Identity preserved: radial shells expanding from center, hue-cycled, staggered
// cadence, optional center glow. Now far brighter, crisper, and more alive.

export const params = {
  period:     { type: 'range', min: 0.2, max: 5,   step: 0.01, default: 1.3, label: 'Cadence (s)' },
  thickness:  { type: 'range', min: 0.03, max: 0.6, step: 0.01, default: 0.16, label: 'Shell Thickness' },
  ringCount:  { type: 'int',   min: 1,   max: 6,   step: 1,    default: 3,   label: 'Shells In Flight' },
  hueShift:   { type: 'range', min: 0,   max: 2,   step: 0.01, default: 0.55, label: 'Hue Drift' },
  saturation: { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.92, label: 'Saturation' },
  centerGlow: { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.6,  label: 'Core Glow' },
  brightness: { type: 'range', min: 0.2, max: 2,   step: 0.01, default: 1.25, label: 'Brightness' },
};

export default {
  name: 'Expanding Spheres',

  render(ctx, xyz) {
    const { t, params, utils, audio } = ctx;
    const { cx, cy, cz } = xyz;
    const u = utils;

    // Radial distance from the cube centre. Corners sit at ~1.732 in centered
    // [-1,1] space; we let shells expand to RMAX so they kiss the corners at peak.
    const r = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const RMAX = 1.85;

    const period = Math.max(0.05, params.period);
    const half = Math.max(0.02, params.thickness) * 0.5;
    const count = Math.max(1, params.ringCount | 0);
    const beatBoost = audio && audio.beat ? 0.35 : 0;
    const energy = audio ? audio.energy : 0;

    let accR = 0, accG = 0, accB = 0;

    for (let i = 0; i < count; i++) {
      const offset = i / count;

      // Per-shell organic timing: coprime sine wobble nudges each birth so the
      // cadence never feels mechanical, then wraps to a clean 0..1 phase.
      const wob = 0.04 * Math.sin(t * 0.37 + i * 2.39) +
                  0.03 * Math.sin(t * 0.53 + i * 1.13);
      let phase = ((t / period) + offset + wob) % 1;
      if (phase < 0) phase += 1;

      const radius = phase * RMAX;
      const d = Math.abs(r - radius);
      if (d > half * 2.2) continue; // outside this shell's reach entirely

      // Crisp surface: a hot near-solid core band plus a soft outer bloom.
      const core = u.smoothstep(half, half * 0.25, d);          // sharp ridge
      const bloom = u.smoothstep(half * 2.2, half * 0.4, d);    // gentle halo
      let shell = core * 0.85 + bloom * 0.4;
      if (shell <= 0) continue;

      // Brighten as the shell first emerges, then fade toward the corners so we
      // keep darkness/depth and a clear high-dynamic-range edge.
      const rise = u.smoothstep(0, 0.12, phase);
      const fall = u.smoothstep(1.0, 0.35, phase);
      const env = rise * fall;
      shell *= env;
      if (shell <= 0) continue;

      // Hue: each shell carries its own colour and the whole set drifts over time
      // for a continuous hue journey; an audio nudge shifts the spectrum on energy.
      const hue = offset * 0.5 + params.hueShift * (t / period) * 0.5 + energy * 0.15;

      // Hot inner edge reads near-white; outer falloff stays saturated.
      const whiteHot = core * core; // only the sharp ridge goes pale
      const sat = u.clamp(params.saturation * (1 - whiteHot * 0.7), 0, 1);
      const val = u.clamp(shell * params.brightness + whiteHot * 0.25 + beatBoost * env, 0, 1.3);

      const [cr, cg, cb] = u.hsv(hue, sat, val);
      accR += cr; accG += cg; accB += cb;
    }

    // Pulsing core: a bright heart that flares each time a shell is born, marking
    // the cadence and anchoring the volume's centre.
    if (params.centerGlow > 0 && r < 0.6) {
      const birth = (t / period) % 1;             // 0 at each spawn
      const flare = 0.45 + 0.55 * Math.pow(1 - birth, 3); // sharp flash, slow decay
      const falloff = u.smoothstep(0.6, 0, r);
      const cv = params.centerGlow * flare * falloff * (1 + beatBoost);
      const chue = (params.hueShift * (t / period) * 0.5) % 1;
      const [gr, gg, gb] = u.hsv(chue, 0.35, u.clamp(cv, 0, 1.2));
      accR += gr; accG += gg; accB += gb;
    }

    return [
      accR < 255 ? accR : 255,
      accG < 255 ? accG : 255,
      accB < 255 ? accB : 255,
    ];
  },
};
