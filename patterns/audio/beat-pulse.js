// Beat Pulse — the whole cube SLAMS on every detected beat, then decays.
//
// On a beat the core flashes to a bright white-hot shock and a saturated
// shell BLOOMS outward through the volume, thinning as it ages. The hue
// hops to a new color each beat (complementary accents on the trailing
// edge), low-band energy swells the core, mid-band ripples the shell, and
// high-band sparkles dust the surface. Between beats a slow breathing
// ember keeps the cube alive on mild/steady input — never black, never
// frozen. Drives entirely off ctx.audio.{energy,low,mid,high,beat}.

export const params = {
  decay:    { type: 'range', min: 0.2, max: 6,   step: 0.01, default: 2.6, label: 'Beat Decay' },
  radius:   { type: 'range', min: 0.2, max: 2.5, step: 0.01, default: 0.7, label: 'Shell Thickness' },
  baseLow:  { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.16, label: 'Ember Floor' },
  hueShift: { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.17, label: 'Hue Hop' },
  punch:    { type: 'range', min: 0.5, max: 3,   step: 0.01, default: 1.7, label: 'Slam Punch' },
  sparkle:  { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.6, label: 'High Sparkle' },
};

// Pattern-local state shared across all voxels within a frame. We stamp the
// frame number so the once-per-frame integration runs exactly once even
// though render() is called per voxel.
let pulse = 0;        // [0..1] beat shock envelope (slams to 1, decays)
let shellR = 0;       // current radius of the blooming shell front
let hue = 0;          // base hue, hops on each beat
let breathPhase = 0;  // slow organic ember breathing accumulator
let lastFrame = -1;

export default {
  name: 'Beat Pulse',

  render(ctx, xyz) {
    const { t, dt, audio, params, utils } = ctx;
    const sdt = dt > 0 && dt < 0.5 ? dt : 0.016;

    // --- once-per-frame state integration -------------------------------
    if (ctx.frame !== lastFrame) {
      lastFrame = ctx.frame;

      // Decay the beat shock; the shell front races outward as it fades.
      pulse *= Math.exp(-params.decay * sdt);
      shellR += sdt * (1.6 + audio.mid * 1.4); // expand through the volume
      breathPhase += sdt;

      if (audio.beat) {
        pulse = 1;
        shellR = 0;                       // re-launch the bloom from center
        hue = (hue + params.hueShift) % 1; // hop to a fresh color
      } else {
        // Even with no hard beat, a strong energy swell nudges a soft pulse
        // so steady/mild input still breathes with the music.
        const swell = utils.smoothstep(0.55, 0.95, audio.energy);
        if (swell > pulse) { pulse = swell; shellR = Math.min(shellR, 0.4); }
      }
      if (shellR > 4) shellR = 4; // clamp runaway expansion between beats
    }

    const { cx, cy, cz } = xyz;
    const r = Math.hypot(cx, cy, cz);           // 0 at center, ~1.73 at corner
    const slam = Math.pow(pulse, 1 / params.punch); // sharpen the attack curve

    // --- 1) CORE: white-hot shock at the center, swelled by low band ----
    const lowSwell = audio.low * 0.45;
    const coreR = 0.28 + lowSwell * 0.6;
    const core = utils.smoothstep(coreR + 0.35, 0.0, r) * (slam * 0.9 + lowSwell * 0.5);

    // --- 2) SHELL: saturated front blooming outward, thinning with age --
    const thick = params.radius * (0.4 + (1 - pulse) * 0.9); // thins as it ages
    const dist = Math.abs(r - shellR);
    let ring = utils.smoothstep(thick, 0, dist) * slam;
    // Mid band corrugates the shell so it shimmers rather than reads flat.
    ring *= 0.75 + 0.25 * (0.5 + 0.5 * Math.sin((cx + cy + cz) * 4 + t * 6 + audio.mid * 9));

    // --- 3) EMBER: slow breathing floor so the cube is alive at rest ----
    // Sum of coprime sines + gentle noise = organic, non-repeating glow.
    const breath =
      0.5 + 0.25 * Math.sin(breathPhase * 0.9 + r * 1.7)
          + 0.15 * Math.sin(breathPhase * 1.7 - cy * 2.3)
          + 0.10 * utils.noise3d(cx * 1.3, cy * 1.3 + breathPhase * 0.4, cz * 1.3);
    const ember = params.baseLow * utils.clamp(breath, 0, 1) * (0.6 + audio.energy * 0.7);

    // --- 4) SPARKLE: high-band dust on the outer surface ----------------
    let dust = 0;
    if (params.sparkle > 0 && audio.high > 0.04) {
      const tw = utils.noise3d(cx * 9 + t * 5, cy * 9 - t * 4, cz * 9 + t * 3);
      const surf = utils.smoothstep(0.55, 1.0, r); // bias to the outer voxels
      dust = utils.smoothstep(0.8 - audio.high * 0.55, 1.0, tw) * surf
             * params.sparkle * (0.4 + audio.high);
    }

    // --- compose value + saturation -------------------------------------
    const v = utils.clamp(core + ring * 0.95 + ember + dust * 0.9, 0, 1);
    if (v <= 0.01) return [0, 0, 0];

    // Core desaturates toward white-hot at the slam; shell trailing edge
    // leans to the complementary hue for a punchy two-tone bloom.
    const compShift = 0.5 * utils.smoothstep(shellR, shellR + thick * 1.5, r);
    const localHue = (hue + compShift + cz * 0.04) % 1;
    const sat = utils.clamp(1 - core * 0.85 - slam * 0.25, 0, 1);

    const col = utils.hsv(localHue, sat, v);
    // Add a touch of pure-white sparkle on top of the chosen hue.
    if (dust > 0.001) {
      const w = utils.clamp(dust * 255, 0, 255);
      col[0] = utils.clamp(col[0] + w, 0, 255);
      col[1] = utils.clamp(col[1] + w, 0, 255);
      col[2] = utils.clamp(col[2] + w, 0, 255);
    }
    return col;
  },
};
