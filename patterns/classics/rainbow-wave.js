// Rainbow wave — HSV hue sweeping along a selectable axis.

export const params = {
  speed:      { type: 'range', min: 0,   max: 3,   step: 0.01, default: 0.6 },
  frequency:  { type: 'range', min: 0.5, max: 5,   step: 0.01, default: 1.5 },
  axis:       { type: 'select', options: ['x', 'y', 'z', 'diagonal'], default: 'y' },
  saturation: { type: 'range', min: 0,   max: 1,   step: 0.01, default: 1 },
  brightness: { type: 'range', min: 0,   max: 1,   step: 0.01, default: 1 },
};

export default {
  name: 'Rainbow wave',

  render(ctx, xyz) {
    const { t, params, utils } = ctx;
    let axisVal;
    switch (params.axis) {
      case 'x': axisVal = xyz.u; break;
      case 'z': axisVal = xyz.w; break;
      case 'diagonal': axisVal = (xyz.u + xyz.v + xyz.w) / 3; break;
      case 'y':
      default:  axisVal = xyz.v;
    }
    const h = axisVal * params.frequency + t * params.speed;
    return utils.hsv(h, params.saturation, params.brightness);
  },
};
