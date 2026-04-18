// Rotating Cube — a smaller cube rotates inside the larger volume.
// Voxels within the inner cube's edges are lit; body is hollow so the
// rotation reads through the outer shell.

export const params = {
  size:     { type: 'range', min: 0.2, max: 1,  step: 0.01, default: 0.65 },
  speedX:   { type: 'range', min: -3,  max: 3,  step: 0.01, default: 0.6 },
  speedY:   { type: 'range', min: -3,  max: 3,  step: 0.01, default: 0.9 },
  speedZ:   { type: 'range', min: -3,  max: 3,  step: 0.01, default: 0.3 },
  thickness:{ type: 'range', min: 0.03, max: 0.4, step: 0.01, default: 0.1 },
  edgesOnly:{ type: 'toggle', default: true },
  color:    { type: 'color', default: '#7ad8ff' },
};

export default {
  name: 'Rotating Cube',

  render(ctx, xyz) {
    const { t, params, utils } = ctx;
    const { cx, cy, cz } = xyz;

    // Inverse rotation: rotate the sample point instead of the cube.
    const ax = t * params.speedX;
    const ay = t * params.speedY;
    const az = t * params.speedZ;

    // Rx
    let x = cx;
    let y = cy * Math.cos(-ax) - cz * Math.sin(-ax);
    let z = cy * Math.sin(-ax) + cz * Math.cos(-ax);
    // Ry
    let x2 =  x * Math.cos(-ay) + z * Math.sin(-ay);
    let z2 = -x * Math.sin(-ay) + z * Math.cos(-ay);
    x = x2; z = z2;
    // Rz
    let x3 = x * Math.cos(-az) - y * Math.sin(-az);
    let y3 = x * Math.sin(-az) + y * Math.cos(-az);
    x = x3; y = y3;

    const half = params.size;
    const inside =
      Math.abs(x) <= half &&
      Math.abs(y) <= half &&
      Math.abs(z) <= half;
    if (!inside) return [0, 0, 0];

    let intensity = 1;
    if (params.edgesOnly) {
      // How close to any face? Edge = close to 2 of 3 faces simultaneously.
      const faceDist = [half - Math.abs(x), half - Math.abs(y), half - Math.abs(z)];
      faceDist.sort((a, b) => a - b);
      const second = faceDist[1]; // distance to the *second*-closest face
      intensity = utils.smoothstep(params.thickness, 0, second);
      if (intensity <= 0) return [0, 0, 0];
    }

    const [r, g, b] = utils.mix(params.color, params.color, 0);
    return [r * intensity, g * intensity, b * intensity];
  },
};
