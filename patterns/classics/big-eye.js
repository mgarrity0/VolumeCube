// Big Eye — a bold eyeball that fills the cube and looks around the room.
//
// Designed to READ as an eye at 10x10x10 resolution, where sub-voxel detail
// just turns to mush. So it's deliberately simple and high-contrast:
//   • The whole sphere is a WHITE eyeball (sclera).
//   • A big colored IRIS sits on the front, as a spherical cap around the
//     gaze direction, with a black PUPIL cap in its center and a thin dark
//     limbal ring at its edge for definition.
//   • The gaze points mostly toward the viewer (+Z, the default Front
//     camera) and drifts slowly so the iris wanders around but keeps
//     "looking at you". It blinks: a skin-colored eyelid sweeps down over
//     the front, then back up.
//   • One bright catchlight dot on the iris sells the wet, alive look.
//
// Geometry: for each voxel, n = its unit direction from the cube center and
// fwd = n·gaze. The iris/pupil are simple thresholds on fwd (cones), which
// reads cleanly as a disc facing the camera from any rotation.

export const params = {
  radius:     { type: 'range',  min: 0.4,  max: 0.98, step: 0.01, default: 0.85, label: 'Eyeball size' },
  thickness:  { type: 'range',  min: 0.05, max: 0.5,  step: 0.01, default: 0.22, label: 'Edge softness' },
  fill:       { type: 'select', options: ['filled', 'shell'], default: 'filled' },
  irisSize:   { type: 'range',  min: 0.2,  max: 0.8,  step: 0.02, default: 0.5,  label: 'Iris size' },
  pupilSize:  { type: 'range',  min: 0.05, max: 0.4,  step: 0.01, default: 0.2,  label: 'Pupil size' },
  lookSpeed:  { type: 'range',  min: 0,    max: 2,    step: 0.05, default: 0.55, label: 'Look-around speed' },
  lookRange:  { type: 'range',  min: 0,    max: 1.0,  step: 0.02, default: 0.5,  label: 'Look-around range (rad)' },
  blinkRate:  { type: 'range',  min: 0,    max: 0.6,  step: 0.01, default: 0.18, label: 'Blinks / sec' },
  catchlight: { type: 'toggle', default: true,                                  label: 'Catchlight glint' },
  audioReact: { type: 'toggle', default: true,                                  label: 'Pupil reacts to audio' },
  scleraColor:{ type: 'color',  default: '#f5f3ec' },
  irisColor:  { type: 'color',  default: '#2f86ff' },
  pupilColor: { type: 'color',  default: '#000000' },
  skinColor:  { type: 'color',  default: '#e0a87e' },
};

const BLINK_DUR = 0.18; // seconds per blink

export default {
  name: 'Big Eye',
  render(ctx, xyz) {
    const { t, params, utils, audio } = ctx;
    const { cx, cy, cz } = xyz;

    const r = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const R = params.radius;
    const th = Math.max(params.thickness, 1e-3);

    // Eyeball body.
    let intensity;
    if (params.fill === 'shell') intensity = utils.smoothstep(th, 0, Math.abs(r - R));
    else                          intensity = utils.smoothstep(R + th, R - th, r);
    if (intensity <= 0) return [0, 0, 0];

    // Gaze: mostly +Z (toward the Front camera), drifting on slow coprime
    // sines so it looks around the room but keeps facing you.
    const sp = params.lookSpeed, rng = params.lookRange;
    const yaw   = (Math.sin(t * sp) * 0.7 + Math.sin(t * sp * 0.43 + 1.3) * 0.3) * rng;
    const pitch = (Math.sin(t * sp * 0.67 + 0.5) * 0.7) * rng * 0.6;
    const cpi = Math.cos(pitch), spi = Math.sin(pitch);
    const cya = Math.cos(yaw), sya = Math.sin(yaw);
    const fx = sya * cpi, fy = spi, fz = cya * cpi;   // gaze unit vector

    // Voxel direction from center.
    let nx, ny, nz;
    if (r < 1e-6) { nx = 0; ny = 0; nz = 1; }
    else { nx = cx / r; ny = cy / r; nz = cz / r; }
    const fwd = nx * fx + ny * fy + nz * fz;          // 1 = dead-on the gaze

    // Iris / pupil as cones around the gaze axis. Larger size → bigger cap.
    const irisCos  = 1 - params.irisSize;             // fwd above this = iris
    let   pupilFr  = params.pupilSize;
    // Pupil dilates/constricts a little for life; audio constricts it.
    pupilFr *= 1 + 0.18 * Math.sin(t * 0.5 + 1.0);
    if (params.audioReact && audio) pupilFr *= 1 - 0.35 * (audio.energy || 0) - (audio.beat ? 0.12 : 0);
    const pupilCos = 1 - Math.max(0.04, Math.min(pupilFr, params.irisSize * 0.9));

    const [scR, scG, scB] = utils.parseColor(params.scleraColor);
    const [irR, irG, irB] = utils.parseColor(params.irisColor);
    const [puR, puG, puB] = utils.parseColor(params.pupilColor);
    const [skR, skG, skB] = utils.parseColor(params.skinColor);

    // Blink: eyelid (skin) sweeps down over the front. lidY is the lower
    // edge of the upper lid in "up" coordinates — at 1 the eye is open, at
    // -1 fully shut.
    let lidY = 1;
    if (params.blinkRate > 0) {
      const interval = 1 / params.blinkRate;
      const ph = t % interval;
      const tail = interval - BLINK_DUR;
      if (ph > tail) {
        const u = (ph - tail) / BLINK_DUR;           // 0..1
        const close = 1 - Math.abs(2 * u - 1);        // 0→1→0 triangle
        lidY = 1 - 2 * close;                         // 1 open → -1 shut
      }
    }
    // "up" component of this voxel direction (for the eyelid line).
    const up = ny;  // world-Y; good enough since gaze stays near +Z

    let cr, cg, cb;
    if (fwd >= pupilCos) {            // pupil
      cr = puR; cg = puG; cb = puB;
    } else if (fwd >= irisCos) {      // iris (with a dark limbal ring at the rim)
      const tt = (fwd - irisCos) / Math.max(1e-6, pupilCos - irisCos); // 0 rim → 1 inner
      const limbal = utils.smoothstep(0.18, 0.0, tt);  // dark right at the edge
      const k = 1 - 0.6 * limbal;
      cr = irR * k; cg = irG * k; cb = irB * k;
    } else {                          // sclera (white), faint shading toward back
      const shade = 0.7 + 0.3 * utils.clamp(fwd + 0.5, 0, 1);
      cr = scR * shade; cg = scG * shade; cb = scB * shade;
    }

    // Eyelid: if this front voxel is above the (animated) lid line, it's skin.
    if (fwd > -0.2 && up > lidY) {
      cr = skR; cg = skG; cb = skB;
    }

    // Catchlight: a bright fixed glint on the upper-right of the eye (world
    // space), strongest dead-on so it sits on the cornea.
    if (params.catchlight && fwd > 0.2) {
      const gx = 0.4, gy = 0.55, gz = 0.73;          // light direction
      const gl = nx * gx + ny * gy + nz * gz;
      const spec = Math.pow(Math.max(0, gl), 40);
      const add = spec * 255;
      cr = Math.min(255, cr + add); cg = Math.min(255, cg + add); cb = Math.min(255, cb + add);
    }

    return [cr * intensity, cg * intensity, cb * intensity];
  },
};
