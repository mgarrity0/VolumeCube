// Smiley Face — a glowing golden ball that rolls, turns its head, and
// grins right at you.
//
// Renders an iso-sphere of radius R. The skin glows: a luminous warm-gold
// body with a hot bright core toward a drifting light, a saturated rim
// (limb) glow so the silhouette pops across a dark room, and a slow hue
// shimmer through gold→amber→honey so it never reads as one flat tint.
//
// On the hemisphere facing the current "look direction" it paints two
// black eyes (each with a tiny white catchlight) and a curved smile. The
// look direction continuously yaws (spin) and wobbles in pitch + extra
// yaw at non-commensurate frequencies plus gentle noise, so the face
// turns its head and glances around as it rolls — alive, never looping.
// The eyes give a quick periodic blink/squint and the grin "breathes".
//
// Features live in a face-local 2D plane: world-Y projected onto the
// plane normal to f̂ gives "up", and up × f̂ gives "right". An eye is a
// small disc at (±eyeSpacing, eyeHeight); the smile is a parabolic band
// y = mouthHeight + curve·(x/mouthWidth)² (corners curl up). Cheeks get a
// warm blush flanking the grin.
//
// Feature paint + the surface glow detail are gated to a thin shell at
// r≈R, so 'filled' mode shows a glowing yellow interior with the face
// only on the skin.
//
// Convention: at yaw=0, pitch=0 the face looks +Z (front of cube).

export const params = {
  radius:       { type: 'range',  min: 0.2,  max: 0.9,  step: 0.01,  default: 0.6 },
  thickness:    { type: 'range',  min: 0.04, max: 0.4,  step: 0.01,  default: 0.18 },
  fill:         { type: 'select', options: ['shell', 'filled'], default: 'filled' },
  spin:         { type: 'range',  min: -2,   max: 2,    step: 0.02,  default: 0.18, label: 'Spin (rev/s)' },
  lookSpeed:    { type: 'range',  min: 0,    max: 3,    step: 0.05,  default: 1.1,  label: 'Look-around speed' },
  lookRange:    { type: 'range',  min: 0,    max: 1.2,  step: 0.02,  default: 0.45, label: 'Look-around range (rad)' },
  glow:         { type: 'range',  min: 0,    max: 1,    step: 0.01,  default: 0.85, label: 'Skin glow' },
  rim:          { type: 'range',  min: 0,    max: 1,    step: 0.01,  default: 0.7,  label: 'Rim glow' },
  hueShimmer:   { type: 'range',  min: 0,    max: 0.12, step: 0.005, default: 0.04, label: 'Hue shimmer' },
  faceColor:    { type: 'color',  default: '#ffd23a' },
  featureColor: { type: 'color',  default: '#1a0e00' },
  eyeSpacing:   { type: 'range',  min: 0.1,  max: 0.5,  step: 0.01,  default: 0.27 },
  eyeHeight:    { type: 'range',  min: -0.2, max: 0.5,  step: 0.01,  default: 0.2,  label: 'Eye height' },
  eyeSize:      { type: 'range',  min: 0.05, max: 0.25, step: 0.005, default: 0.14 },
  blinkRate:    { type: 'range',  min: 0,    max: 1,    step: 0.005, default: 0.22, label: 'Blinks/sec' },
  mouthHeight:  { type: 'range',  min: -0.5, max: 0.1,  step: 0.01,  default: -0.24 },
  mouthWidth:   { type: 'range',  min: 0.1,  max: 0.6,  step: 0.01,  default: 0.32 },
  mouthCurve:   { type: 'range',  min: 0,    max: 0.4,  step: 0.01,  default: 0.16, label: 'Smile depth' },
  mouthThick:   { type: 'range',  min: 0.02, max: 0.15, step: 0.005, default: 0.065 },
};

const BLINK_DUR = 0.14; // seconds — fixed; real blinks are ~150ms regardless of rate

export default {
  name: 'Smiley Face',
  render(ctx, xyz) {
    const { t, params, utils } = ctx;
    const { cx, cy, cz } = xyz;

    const r = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const R = Math.max(params.radius, 1e-3);
    const thick = Math.max(params.thickness, 1e-3);

    // Body envelope.
    let intensity;
    if (params.fill === 'shell') {
      intensity = utils.smoothstep(thick, 0, Math.abs(r - R));
    } else {
      intensity = utils.smoothstep(R + thick, R - thick, r);
    }
    if (intensity <= 0) return [0, 0, 0];

    // How close this voxel is to the actual skin (1 on the shell, 0 deep inside).
    const surfShell = utils.smoothstep(thick, 0, Math.abs(r - R));

    // ---- Pose: continuous yaw spin + non-commensurate yaw/pitch wobble +
    // gentle noise so the head clearly turns AND glances, never looping. ----
    const ls = params.lookSpeed;
    const no = utils.noise3d(t * 0.31, 7.3, -2.1); // slow organic drift, -1..1
    const yaw = t * params.spin * Math.PI * 2
              + Math.sin(t * ls * 1.7) * params.lookRange * 0.55
              + Math.sin(t * ls * 0.37 + 2.1) * params.lookRange * 0.25
              + no * params.lookRange * 0.3;
    const pitch = Math.sin(t * ls * 1.1 + 0.7) * params.lookRange * 0.45
                + Math.sin(t * ls * 0.53 + 1.3) * params.lookRange * 0.2;

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

    // ---- Glowing skin base color ----
    const [yr, yg, yb] = utils.parseColor(params.faceColor);

    // Drifting key light (slightly above + leading the gaze) for a glossy core.
    let lx = fx * 0.55 + ux * 0.55 + rx * 0.45;
    let ly = fy * 0.55 + uy * 0.55 + ry * 0.45 + 0.35;
    let lz = fz * 0.55 + uz * 0.55 + rz * 0.45;
    const llen = Math.hypot(lx, ly, lz) || 1;
    lx /= llen; ly /= llen; lz /= llen;
    const lambert = Math.max(0, nx * lx + ny * ly + nz * lz); // 0..1 lit fraction

    // Hue shimmer: nudge the gold through amber/honey over space + time.
    const hueWalk = (utils.noise3d(nx * 1.6 + t * 0.18, ny * 1.6, nz * 1.6) * 0.5)
                  + Math.sin(t * 0.27) * 0.5;
    // Pull base gold toward a warm amber accent based on shimmer + lighting.
    const amber = [255, 150, 24];
    const shimT = utils.clamp(0.28 + hueWalk * 0.22 + (1 - lambert) * 0.18, 0, 1)
                * (params.hueShimmer / 0.04); // scales with the knob (default 1x)
    let base = utils.mix([yr, yg, yb], amber, utils.clamp(shimT, 0, 0.65));

    // Soft body shading: shadowed side dims toward a deep honey, lit side glows.
    const shade = 0.42 + 0.58 * lambert;            // 0.42..1
    let cr = base[0] * shade;
    let cg = base[1] * shade;
    let cb = base[2] * shade;

    // Bright glossy core (specular) toward the light — a hot near-white pop.
    const spec = Math.pow(lambert, 6) * params.glow;
    cr += (255 - cr) * spec * 0.9;
    cg += (255 - cg) * spec * 0.9;
    cb += (245 - cb) * spec * 0.75;

    // Rim / limb glow: voxels whose normal grazes the silhouette light up warm,
    // so the round edge reads as a glowing orb across a dark room. fwd→0 at rim.
    const rimAmt = utils.smoothstep(0.55, -0.05, fwd) * params.rim * surfShell;
    cr += (255 - cr) * rimAmt * 0.85;
    cg += (170 - cg) * rimAmt * 0.7;
    cb += (40  - cb) * rimAmt * 0.45;

    // ---- Face features on the front-facing hemisphere ----
    if (fwd > 0) {
      const [fr, fg, fb] = utils.parseColor(params.featureColor);

      // Blink/squint: eyes briefly compress vertically (a quick wink of life).
      let open = 1;
      if (params.blinkRate > 0) {
        const interval = 1 / params.blinkRate;
        const phase = t % interval;
        if (phase > interval - BLINK_DUR) {
          const u = (phase - (interval - BLINK_DUR)) / BLINK_DUR;
          open = 1 - 4 * u * (1 - u); // smooth dip to 0 mid-blink
        }
      }
      // Squash eye vertically when blinking (scale yF metric, not the disc x).
      const eyeYScale = 1 / Math.max(0.18, open);

      const eh = params.eyeHeight;
      const dxL = xF - params.eyeSpacing, dxR = xF + params.eyeSpacing;
      const dyE = (yF - eh) * eyeYScale;
      const dEyeL = Math.hypot(dxL, dyE);
      const dEyeR = Math.hypot(dxR, dyE);
      const dEye  = Math.min(dEyeL, dEyeR);
      const eyeMask = utils.smoothstep(params.eyeSize, params.eyeSize * 0.82, dEye);

      // Catchlight: tiny bright spec in the upper-inner part of each eye → life.
      const clx = xF - (xF > 0 ? params.eyeSpacing : -params.eyeSpacing) + 0.045;
      const cly = (yF - eh) - params.eyeSize * 0.45;
      const catchR = params.eyeSize * 0.28;
      const catch_ = utils.smoothstep(catchR, catchR * 0.4, Math.hypot(clx, cly)) * open;

      // Smile — parabolic band, capped in x so corners don't bleed past lips.
      // The grin "breathes" a touch so it feels warm and alive.
      const breathe = 1 + 0.06 * Math.sin(t * 0.9);
      const mw = Math.max(params.mouthWidth, 1e-3) * breathe;
      const xN = xF / mw;
      const yTarget = params.mouthHeight + params.mouthCurve * breathe * xN * xN;
      const dMouth  = Math.abs(yF - yTarget);
      const xMask   = utils.smoothstep(mw, mw * 0.9, Math.abs(xF));
      const mouthMask = utils.smoothstep(params.mouthThick, params.mouthThick * 0.55, dMouth) * xMask;

      // Dark feature ink (eyes + smile), confined to the skin shell.
      const featStrength = Math.max(eyeMask, mouthMask) * surfShell;
      if (featStrength > 0) {
        cr = cr + (fr - cr) * featStrength;
        cg = cg + (fg - cg) * featStrength;
        cb = cb + (fb - cb) * featStrength;
      }

      // Warm cheek blush flanking the grin, on the skin.
      const blushY = params.mouthHeight + 0.16;
      const blush = utils.smoothstep(0.2, 0.0,
                      Math.hypot(Math.abs(xF) - (params.eyeSpacing + 0.06), yF - blushY))
                  * 0.35 * surfShell * (1 - featStrength);
      cr += (255 - cr) * blush * 0.4;
      cg += (120 - cg) * blush * 0.4;
      cb += (90  - cb) * blush * 0.4;

      // White catchlight sits on top of the (now dark) eye ink.
      const catchOn = catch_ * eyeMask * surfShell;
      if (catchOn > 0) {
        cr += (255 - cr) * catchOn;
        cg += (255 - cg) * catchOn;
        cb += (255 - cb) * catchOn;
      }
    }

    return [
      utils.clamp(cr * intensity, 0, 255),
      utils.clamp(cg * intensity, 0, 255),
      utils.clamp(cb * intensity, 0, 255),
    ];
  },
};
