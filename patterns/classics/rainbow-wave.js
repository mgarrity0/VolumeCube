// Rainbow wave — a luminous hue wavefront that TRAVELS THROUGH the volume.
//
// Instead of flat-lighting every voxel (no depth), the hue sweeps along a chosen
// axis while a moving sine "crest" rides with it: bright glowing bands separated
// by dark troughs. The wavefront direction is gently warped by 3D noise so the
// bands ripple and breathe organically (coprime sine rates -> non-repeating life).
// Black troughs give the volume real depth and contrast under bloom.

export const params = {
  speed:      { type: 'range',  min: 0,   max: 3,   step: 0.01, default: 0.6 },
  frequency:  { type: 'range',  min: 0.5, max: 5,   step: 0.01, default: 1.6, label: 'Hue spread' },
  bands:      { type: 'range',  min: 0.5, max: 6,   step: 0.01, default: 2.2, label: 'Wave crests' },
  axis:       { type: 'select', options: ['x', 'y', 'z', 'diagonal'], default: 'y' },
  ripple:     { type: 'range',  min: 0,   max: 1,   step: 0.01, default: 0.5, label: 'Ripple' },
  contrast:   { type: 'range',  min: 0,   max: 1,   step: 0.01, default: 0.7, label: 'Trough darkness' },
  saturation: { type: 'range',  min: 0,   max: 1,   step: 0.01, default: 1 },
  brightness: { type: 'range',  min: 0,   max: 1,   step: 0.01, default: 1 },
};

const TAU = Math.PI * 2;

export default {
  name: 'Rainbow wave',

  render(ctx, xyz) {
    const { t, params, utils, audio } = ctx;
    const { clamp, smoothstep, hsv } = utils;

    // Position along the travel axis, 0..1.
    let axisVal;
    switch (params.axis) {
      case 'x': axisVal = xyz.u; break;
      case 'z': axisVal = xyz.w; break;
      case 'diagonal': axisVal = (xyz.u + xyz.v + xyz.w) / 3; break;
      case 'y':
      default:  axisVal = xyz.v;
    }

    // Organic warp: bend the wavefront so the bands aren't dead-flat planes.
    // Two coprime-rate samples of the smooth 3D noise keep it from looping.
    const warp =
      utils.noise3d(xyz.u * 1.7 + t * 0.13, xyz.v * 1.7 - t * 0.09, xyz.w * 1.7 + t * 0.11) * 0.55 +
      utils.noise3d(xyz.u * 3.3 - t * 0.07, xyz.v * 3.3 + t * 0.05, xyz.w * 3.3 - t * 0.06) * 0.25;

    const flow = axisVal + params.ripple * warp;

    // Hue journey travels with the wave (coprime drift adds slow lateral motion).
    const hue =
      flow * params.frequency +
      t * params.speed +
      0.05 * Math.sin(t * 0.37 + xyz.cx * 1.3) +
      0.05 * Math.sin(t * 0.23 + xyz.cz * 1.1);

    // Moving crests: a sine wavefront that sweeps along the same axis.
    const phase = (flow * params.bands - t * params.speed * 0.85) * TAU;
    const crest = 0.5 + 0.5 * Math.sin(phase); // 0..1

    // Sharpen crests into glowing bands with dark troughs -> high dynamic range.
    const edge = 0.5 - 0.42 * clamp(params.contrast, 0, 1);
    let lum = smoothstep(edge, 1.0, crest);

    // Depth cue: a second, slower wavefront crossing the volume front-to-back so
    // motion reads in Z too, not just within a plane. Nz can be 1 -> guard.
    const depthAxis = xyz.w; // [0,1] across Z (front face is z=0)
    const depthWave = 0.5 + 0.5 * Math.sin((depthAxis * 1.3 + t * 0.3) * TAU - phase * 0.5);
    lum *= 0.55 + 0.45 * depthWave;

    // A bright hero core: brightest where the primary crest peaks.
    lum = clamp(lum, 0, 1);
    const glow = lum * lum * (3 - 2 * lum); // extra punch on the crest

    // Audio: beats flash the crests brighter; energy adds a touch of fill.
    const beatBoost = audio && audio.beat ? 0.25 : 0;
    const energyFill = audio ? 0.08 * clamp(audio.energy || 0, 0, 1) : 0;

    const v = clamp((glow + beatBoost) * params.brightness + energyFill * params.brightness, 0, 1);

    // Slightly desaturate the very brightest cores toward white for a hot center.
    const sat = clamp(params.saturation * (1 - 0.35 * glow), 0, 1);

    return hsv(hue, sat, v);
  },
};
