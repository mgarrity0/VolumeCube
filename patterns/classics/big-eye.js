// Big Eye — sphere with a sclera/iris/pupil painted on the front-facing
// hemisphere. The whole eyeball "looks around" via continuous yaw + pitch
// wobble at non-commensurate frequencies, and blinks periodically by
// closing eyelids (skin color) from the top and bottom.
//
// Construction mirrors smiley-face.js: project each voxel's surface
// normal into the face-local frame (forward, up, right) and decide its
// color from its 2D position (xF, yF):
//   d < pupilR    → pupil
//   d < irisR     → iris (with subtle gradient from pupil edge)
//   else          → sclera
// Eyelids cover when |yF| > lidY, where lidY shrinks during a blink.
//
// Features are gated to a thin shell at r≈R so 'filled' mode shows a
// uniformly skin-colored interior with the eye only on the surface.

export const params = {
  radius:      { type: 'range',  min: 0.3,  max: 0.95, step: 0.01,  default: 0.7 },
  thickness:   { type: 'range',  min: 0.04, max: 0.4,  step: 0.01,  default: 0.2 },
  fill:        { type: 'select', options: ['shell', 'filled'], default: 'filled' },
  lookSpeed:   { type: 'range',  min: 0,    max: 3,    step: 0.05,  default: 1.5,  label: 'Look speed' },
  lookRange:   { type: 'range',  min: 0,    max: 1,    step: 0.02,  default: 0.5,  label: 'Look range (rad)' },
  blinkRate:   { type: 'range',  min: 0,    max: 1,    step: 0.005, default: 0.18, label: 'Blinks/sec' },
  irisRadius:  { type: 'range',  min: 0.1,  max: 0.5,  step: 0.005, default: 0.26 },
  pupilRadius: { type: 'range',  min: 0.03, max: 0.2,  step: 0.005, default: 0.10 },
  pupilDilate: { type: 'range',  min: 0,    max: 0.6,  step: 0.01,  default: 0.18, label: 'Pupil dilation amp' },
  scleraColor: { type: 'color',  default: '#ffffff' },
  irisColor:   { type: 'color',  default: '#3a8cff' },
  pupilColor:  { type: 'color',  default: '#000000' },
  skinColor:   { type: 'color',  default: '#e8b890' },
};

const BLINK_DUR = 0.18; // seconds — fixed regardless of rate, real blinks are ~150-200ms

export default {
  name: 'Big Eye',
  render(ctx, xyz) {
    const { t, params, utils } = ctx;
    const { cx, cy, cz } = xyz;

    const r = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const R = params.radius;

    // Body envelope.
    let intensity;
    if (params.fill === 'shell') {
      intensity = utils.smoothstep(params.thickness, 0, Math.abs(r - R));
    } else {
      intensity = utils.smoothstep(R + params.thickness, R - params.thickness, r);
    }
    if (intensity <= 0) return [0, 0, 0];

    // Gaze direction: two non-commensurate sines per axis so it never settles.
    const yaw   = Math.sin(t * params.lookSpeed)               * params.lookRange
                + Math.sin(t * params.lookSpeed * 0.43 + 1.7)  * params.lookRange * 0.4;
    const pitch = Math.sin(t * params.lookSpeed * 0.71 + 0.5)  * params.lookRange * 0.55;

    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
    const fx = syaw * cp;
    const fy = sp;
    const fz = cyaw * cp;

    // Face-local up = world-Y projected onto plane ⊥ f, normalized.
    let ux = -fy * fx;
    let uy = 1 - fy * fy;
    let uz = -fy * fz;
    const ulen = Math.hypot(ux, uy, uz);
    if (ulen < 1e-4) { ux = 0; uy = 0; uz = 1; }
    else { ux /= ulen; uy /= ulen; uz /= ulen; }

    // right = up × f
    const rx = uy * fz - uz * fy;
    const ry = uz * fx - ux * fz;
    const rz = ux * fy - uy * fx;

    let nx, ny, nz;
    if (r < 1e-6) { nx = 0; ny = 1; nz = 0; }
    else { nx = cx / r; ny = cy / r; nz = cz / r; }

    const fwd = nx * fx + ny * fy + nz * fz;
    const xF  = nx * rx + ny * ry + nz * rz;
    const yF  = nx * ux + ny * uy + nz * uz;

    // Blink: most of the cycle eye is open (=1); a fixed-duration dip closes it.
    let blinkOpen = 1;
    if (params.blinkRate > 0) {
      const interval = 1 / params.blinkRate;
      const phase = t % interval;
      if (phase > interval - BLINK_DUR) {
        const u = (phase - (interval - BLINK_DUR)) / BLINK_DUR;
        // 4u(1-u) is a smooth bump peaking at 1 → blinkOpen dips to 0 mid-blink.
        blinkOpen = 1 - 4 * u * (1 - u);
      }
    }

    // Pupil dilates slowly so the eye looks alive even when not moving.
    const dilate = 1 + params.pupilDilate * Math.sin(t * 0.3 + 1.1);
    const pupilR = params.pupilRadius * dilate;
    const irisR  = params.irisRadius;

    // Eyelid line: yF threshold expands (open) / collapses to 0 (closed).
    const lidY = irisR * 1.4 * blinkOpen;

    const [scR, scG, scB] = utils.parseColor(params.scleraColor);
    const [irR, irG, irB] = utils.parseColor(params.irisColor);
    const [puR, puG, puB] = utils.parseColor(params.pupilColor);
    const [skR, skG, skB] = utils.parseColor(params.skinColor);

    let cr = skR, cg = skG, cb = skB;

    if (fwd > 0) {
      if (yF > lidY || yF < -lidY) {
        // Eyelid skin.
        cr = skR; cg = skG; cb = skB;
      } else {
        const d = Math.sqrt(xF * xF + yF * yF);
        if (d < pupilR) {
          cr = puR; cg = puG; cb = puB;
        } else if (d < irisR) {
          // Light gradient from inner to outer edge of iris for depth.
          const tt = (d - pupilR) / Math.max(1e-6, irisR - pupilR);
          const k = 0.7 + 0.3 * tt;
          cr = irR * k; cg = irG * k; cb = irB * k;
        } else {
          cr = scR; cg = scG; cb = scB;
        }
      }
    }

    // Confine eye details to a thin shell at r≈R so the interior of 'filled'
    // mode is uniformly skin-colored and rays don't tunnel through the ball.
    const surfShell = utils.smoothstep(params.thickness, 0, Math.abs(r - R));
    cr = skR + (cr - skR) * surfShell;
    cg = skG + (cg - skG) * surfShell;
    cb = skB + (cb - skB) * surfShell;

    return [cr * intensity, cg * intensity, cb * intensity];
  },
};
