// Beat Pulse — whole cube flashes on each detected beat, then decays.
//
// Uses the engine's BEAT flag (bass-band triggered) as a one-frame pulse;
// a per-voxel decaying shell expands outward from center so the cube
// "blooms" rather than flat-flashes.

export const params = {
  decay:   { type: 'range', min: 0.2, max: 6,   step: 0.01, default: 2.2 },
  radius:  { type: 'range', min: 0.2, max: 2.5, step: 0.01, default: 1.4 },
  baseLow: { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.25 },
  hueShift:{ type: 'range', min: 0,   max: 1,   step: 0.01, default: 0 },
};

// Pattern-local state for energy decay. We stash a closure on module
// scope so all voxels share the same `pulse` value within a frame.
let pulse = 0;
let lastHue = 0;
let lastT = 0;
let lastFrame = -1;

export default {
  name: 'Beat Pulse',

  render(ctx, xyz) {
    const { t, dt, audio, params, utils, frame } = ctx;

    // Once per frame, integrate beat → pulse. Guard against re-entry by
    // stamping the frame number.
    if (frame !== lastFrame) {
      lastFrame = frame;
      pulse *= Math.exp(-params.decay * (dt > 0 ? dt : 0.016));
      if (audio.beat) {
        pulse = 1;
        lastHue = (lastHue + 0.17 + params.hueShift) % 1;
      }
      lastT = t;
    }

    const { cx, cy, cz } = xyz;
    const r = Math.hypot(cx, cy, cz);
    // Expanding shell: ring at `pulse*1.5` that thins with age.
    const shell = utils.smoothstep(params.radius, 0, Math.abs(r - (1.5 - pulse * 1.5)));
    const glow = params.baseLow + pulse * 0.8 * shell;
    const v = utils.clamp(glow + audio.low * 0.3, 0, 1);
    if (v <= 0.01) return [0, 0, 0];
    return utils.hsv(lastHue, 1 - pulse * 0.4, v);
  },
};
