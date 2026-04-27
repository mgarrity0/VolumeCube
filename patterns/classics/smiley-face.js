// Smiley Face — yellow ball that spins around and looks around.
//
// Renders an iso-sphere of radius R; on the hemisphere facing the
// current "look direction", paints two black eyes and a curved smile.
// The look direction continuously yaws (spin) and wobbles in pitch +
// extra yaw (look-around) at non-commensurate frequencies, so the
// face turns its head and glances around as it rolls.
//
// Features live in a face-local 2D plane: world-Y projected onto the
// plane normal to f̂ gives "up", and up × f̂ gives "right". An eye is
// a small disc at (±eyeSpacing, eyeHeight); the smile is a parabolic
// band y = mouthHeight + curve·(x/mouthWidth)² (corners curl up).
//
// Feature paint is gated to a thin shell around r=R, so 'filled' mode
// shows a uniformly yellow interior with the face only on the skin.
//
// Convention: at yaw=0, pitch=0 the face looks +Z (front of cube).

export const params = {
  radius:       { type: 'range',  min: 0.2,  max: 0.9,  step: 0.01,  default: 0.55 },
  thickness:    { type: 'range',  min: 0.04, max: 0.4,  step: 0.01,  default: 0.18 },
  fill:         { type: 'select', options: ['shell', 'filled'], default: 'filled' },
  spin:         { type: 'range',  min: -2,   max: 2,    step: 0.02,  default: 0.2,  label: 'Spin (rev/s)' },
  lookSpeed:    { type: 'range',  min: 0,    max: 3,    step: 0.05,  default: 1.2,  label: 'Look-around speed' },
  lookRange:    { type: 'range',  min: 0,    max: 1.2,  step: 0.02,  default: 0.4,  label: 'Look-around range (rad)' },
  faceColor:    { type: 'color',  default: '#ffd84a' },
  featureColor: { type: 'color',  default: '#000000' },
  eyeSpacing:   { type: 'range',  min: 0.1,  max: 0.5,  step: 0.01,  default: 0.26 },
  eyeHeight:    { type: 'range',  min: -0.2, max: 0.5,  step: 0.01,  default: 0.18, label: 'Eye height' },
  eyeSize:      { type: 'range',  min: 0.05, max: 0.25, step: 0.005, default: 0.13 },
  mouthHeight:  { type: 'range',  min: -0.5, max: 0.1,  step: 0.01,  default: -0.22 },
  mouthWidth:   { type: 'range',  min: 0.1,  max: 0.6,  step: 0.01,  default: 0.30 },
  mouthCurve:   { type: 'range',  min: 0,    max: 0.4,  step: 0.01,  default: 0.14, label: 'Smile depth' },
  mouthThick:   { type: 'range',  min: 0.02, max: 0.15, step: 0.005, default: 0.06 },
};

export default {
  name: 'Smiley Face',
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

    // Pose: continuous yaw spin + non-commensurate yaw/pitch wobble so
    // the head clearly turns AND glances rather than just rolling.
    const yaw   = t * params.spin * Math.PI * 2
                + Math.sin(t * params.lookSpeed * 1.7) * params.lookRange * 0.55;
    const pitch = Math.sin(t * params.lookSpeed * 1.1 + 0.7) * params.lookRange * 0.45;

    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
    // Forward unit vector. (yaw,pitch) = (0,0) ⇒ (0,0,1) — front of cube.
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

    // right = up × f  (face's own right; an eye at +eyeSpacing sits there).
    const rx = uy * fz - uz * fy;
    const ry = uz * fx - ux * fz;
    const rz = ux * fy - uy * fx;

    // Voxel surface direction.
    let nx, ny, nz;
    if (r < 1e-6) { nx = 0; ny = 1; nz = 0; }
    else { nx = cx / r; ny = cy / r; nz = cz / r; }

    // Project onto face frame.
    const fwd = nx * fx + ny * fy + nz * fz;
    const xF  = nx * rx + ny * ry + nz * rz;
    const yF  = nx * ux + ny * uy + nz * uz;

    const [yr, yg, yb] = utils.parseColor(params.faceColor);
    let cr = yr, cg = yg, cb = yb;

    if (fwd > 0) {
      // Eyes — pick the closer eye disc.
      const dEyeL = Math.hypot(xF - params.eyeSpacing, yF - params.eyeHeight);
      const dEyeR = Math.hypot(xF + params.eyeSpacing, yF - params.eyeHeight);
      const dEye  = Math.min(dEyeL, dEyeR);
      const eyeMask = utils.smoothstep(params.eyeSize, params.eyeSize * 0.85, dEye);

      // Smile — parabolic band, capped in x so corners don't bleed past lips.
      const xN = xF / Math.max(params.mouthWidth, 1e-3);
      const yTarget = params.mouthHeight + params.mouthCurve * xN * xN;
      const dMouth  = Math.abs(yF - yTarget);
      const xMask   = utils.smoothstep(params.mouthWidth, params.mouthWidth * 0.92, Math.abs(xF));
      const mouthMask = utils.smoothstep(params.mouthThick, params.mouthThick * 0.6, dMouth) * xMask;

      // Confine features to a thin shell at r≈R so 'filled' interior stays plain yellow
      // — without this the feature directions would tunnel through the ball.
      const surfaceShell = utils.smoothstep(params.thickness, 0, Math.abs(r - R));
      const featStrength = Math.max(eyeMask, mouthMask) * surfaceShell;

      if (featStrength > 0) {
        const [fr, fg, fb] = utils.parseColor(params.featureColor);
        cr = yr + (fr - yr) * featStrength;
        cg = yg + (fg - yg) * featStrength;
        cb = yb + (fb - yb) * featStrength;
      }
    }

    return [cr * intensity, cg * intensity, cb * intensity];
  },
};
