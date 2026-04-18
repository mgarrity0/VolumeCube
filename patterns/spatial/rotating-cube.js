// Rotating Cube — a smaller cube rotates inside the larger volume.
// Voxels within the inner cube's edges are lit; body is hollow so the
// rotation reads through the outer shell.
//
// Class API so the rotation trig (9 cos/sin per frame) can be computed
// once in update() instead of per-voxel in render().

export const params = {
  size:     { type: 'range', min: 0.2, max: 1,  step: 0.01, default: 0.65 },
  speedX:   { type: 'range', min: -3,  max: 3,  step: 0.01, default: 0.6 },
  speedY:   { type: 'range', min: -3,  max: 3,  step: 0.01, default: 0.9 },
  speedZ:   { type: 'range', min: -3,  max: 3,  step: 0.01, default: 0.3 },
  thickness:{ type: 'range', min: 0.03, max: 0.4, step: 0.01, default: 0.1 },
  edgesOnly:{ type: 'toggle', default: true },
  color:    { type: 'color', default: '#7ad8ff' },
};

export default class RotatingCube {
  static name = 'Rotating Cube';

  update(ctx) {
    const { t, params } = ctx;
    const ax = -t * params.speedX;
    const ay = -t * params.speedY;
    const az = -t * params.speedZ;
    this.cax = Math.cos(ax); this.sax = Math.sin(ax);
    this.cay = Math.cos(ay); this.say = Math.sin(ay);
    this.caz = Math.cos(az); this.saz = Math.sin(az);
  }

  render(ctx, out) {
    const { N, params, utils } = ctx;
    const [rR, rG, rB] = utils.parseColor(params.color);
    const cax = this.cax, sax = this.sax;
    const cay = this.cay, say = this.say;
    const caz = this.caz, saz = this.saz;
    const half = params.size;
    const thickness = params.thickness;
    const edgesOnly = params.edgesOnly;
    const inv = N > 1 ? 1 / (N - 1) : 0;

    let idx = 0;
    for (let xi = 0; xi < N; xi++) {
      const cx = xi * inv * 2 - 1;
      for (let yi = 0; yi < N; yi++) {
        const cy = yi * inv * 2 - 1;
        for (let zi = 0; zi < N; zi++) {
          const cz = zi * inv * 2 - 1;
          // Rx
          const y1 = cy * cax - cz * sax;
          const z1 = cy * sax + cz * cax;
          // Ry
          const x2 =  cx * cay + z1 * say;
          const z2 = -cx * say + z1 * cay;
          // Rz
          const x3 = x2 * caz - y1 * saz;
          const y3 = x2 * saz + y1 * caz;

          const o = idx * 3;
          idx++;
          const ax3 = x3 < 0 ? -x3 : x3;
          const ay3 = y3 < 0 ? -y3 : y3;
          const az3 = z2 < 0 ? -z2 : z2;
          if (ax3 > half || ay3 > half || az3 > half) {
            out[o] = 0; out[o + 1] = 0; out[o + 2] = 0;
            continue;
          }
          let intensity = 1;
          if (edgesOnly) {
            // Second-closest face distance — edges are where two faces
            // are both nearby. sum - min - max = middle of three.
            const fx = half - ax3;
            const fy = half - ay3;
            const fz = half - az3;
            const lo = fx < fy ? (fx < fz ? fx : fz) : (fy < fz ? fy : fz);
            const hi = fx > fy ? (fx > fz ? fx : fz) : (fy > fz ? fy : fz);
            const second = fx + fy + fz - lo - hi;
            intensity = utils.smoothstep(thickness, 0, second);
            if (intensity <= 0) {
              out[o] = 0; out[o + 1] = 0; out[o + 2] = 0;
              continue;
            }
          }
          out[o]     = rR * intensity;
          out[o + 1] = rG * intensity;
          out[o + 2] = rB * intensity;
        }
      }
    }
  }
}
