// Sweeping Plane — a colored plane glides back-and-forth through the
// cube, lighting voxels within a thickness band around it.
//
// The plane's normal is user-selectable; the sweep phase is a triangular
// wave so the reversal at each end has a brief dwell. Hue drifts each
// time the plane reverses direction.

export const params = {
  axis:      { type: 'select', options: ['x', 'y', 'z'], default: 'y' },
  speed:     { type: 'range', min: 0.05, max: 4,  step: 0.01, default: 0.8 },
  thickness: { type: 'range', min: 0.01, max: 0.6, step: 0.01, default: 0.12 },
  hueSpeed:  { type: 'range', min: 0,    max: 2,  step: 0.01, default: 0.3 },
  trail:     { type: 'range', min: 0,    max: 0.5, step: 0.01, default: 0.08 },
};

export default {
  name: 'Sweeping Plane',

  render(ctx, xyz) {
    const { t, params, utils } = ctx;
    const { u, v, w } = xyz;
    const coord = params.axis === 'x' ? u : params.axis === 'y' ? v : w;

    // Triangular wave position in [0,1].
    const phase = (t * params.speed) % 2;
    const pos = phase < 1 ? phase : 2 - phase;

    const dist = Math.abs(coord - pos);
    // Band with a softer trailing edge on the direction the plane came
    // from, so it drags a brief comet-tail behind it.
    const dir = phase < 1 ? 1 : -1;
    const trailDist = (coord - pos) * dir; // positive = behind the plane
    let intensity = utils.smoothstep(params.thickness, 0, dist);
    if (trailDist > 0) {
      const tailFall = utils.smoothstep(params.trail, 0, trailDist);
      intensity = Math.max(intensity, tailFall * 0.7);
    }
    if (intensity <= 0) return [0, 0, 0];

    const hue = (t * params.hueSpeed) % 1;
    return utils.hsv(hue, 0.7, intensity);
  },
};
