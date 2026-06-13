// Big Eye — a single uncanny eyeball that LIVES inside the cube. A sphere
// with a wet, layered iris / sharp pupil / sclera painted on the front-facing
// hemisphere. Instead of drifting on lazy sines, the gaze moves like a real
// eye: it FIXATES, then SACCADES — fast ballistic jumps between targets with
// long holds and a constant micro-tremor — so it always seems to be looking
// AT something. It blinks with an eased lid sweep (top lid leads, lash-line
// shadow trails), occasionally double-blinking.
//
// Construction (mirrors smiley-face.js): project each voxel's surface normal
// into the gaze-local frame (forward f, up u, right r) and color it by its 2D
// position (xF, yF) measured from the gaze axis:
//   d < pupilR        → pupil (crisp edge, faint dark halo)
//   d < irisR         → iris: radial fibers + noisy crypts, bright collarette
//                       near the pupil, dark limbal ring at the rim, cool→warm
//                       color-temperature gradient
//   else              → sclera (slightly veined / shaded toward the rim)
// A fixed studio "light" puts a hard specular CATCHLIGHT on the wet surface;
// because it is anchored in world space, the glint slides as the eye moves —
// the single strongest "this thing is wet and alive" cue. Eyelids (skin) close
// in from top and bottom when |yF| exceeds the (animated) lid aperture.
//
// Features are gated to a thin shell at r≈R so 'filled' mode shows a uniformly
// skin-colored interior with the eye only on the surface.

export const params = {
  radius:      { type: 'range',  min: 0.3,  max: 0.95, step: 0.01,  default: 0.72 },
  thickness:   { type: 'range',  min: 0.04, max: 0.4,  step: 0.01,  default: 0.2 },
  fill:        { type: 'select', options: ['shell', 'filled'], default: 'filled' },
  lookSpeed:   { type: 'range',  min: 0.2,  max: 3,    step: 0.05,  default: 1.0,  label: 'Saccade rate' },
  lookRange:   { type: 'range',  min: 0,    max: 1,    step: 0.02,  default: 0.62, label: 'Gaze range (rad)' },
  blinkRate:   { type: 'range',  min: 0,    max: 1,    step: 0.005, default: 0.20, label: 'Blinks/sec' },
  irisRadius:  { type: 'range',  min: 0.1,  max: 0.5,  step: 0.005, default: 0.30 },
  pupilRadius: { type: 'range',  min: 0.03, max: 0.2,  step: 0.005, default: 0.105 },
  pupilDilate: { type: 'range',  min: 0,    max: 0.6,  step: 0.01,  default: 0.22, label: 'Pupil dilation amp' },
  irisDetail:  { type: 'range',  min: 0,    max: 1,    step: 0.02,  default: 0.7,  label: 'Iris fiber detail' },
  wetness:     { type: 'range',  min: 0,    max: 1,    step: 0.02,  default: 0.85, label: 'Wet catchlight' },
  audioReact:  { type: 'toggle', default: true,                                    label: 'Pupil reacts to audio' },
  scleraColor: { type: 'color',  default: '#f3f0ea' },
  irisColor:   { type: 'color',  default: '#2f86ff' },
  pupilColor:  { type: 'color',  default: '#040406' },
  skinColor:   { type: 'color',  default: '#e0a87e' },
};

const BLINK_DUR = 0.16; // seconds — fixed; real blinks are ~150ms regardless of rate.
const SACCADE_DUR = 0.05; // seconds — ballistic jump between fixations (very fast).

// Deterministic hash → [0,1). Lets gaze targets be reproducible per "fixation
// index" without storing any state (function API must stay pure).
function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export default {
  name: 'Big Eye',
  render(ctx, xyz) {
    const { t, params, utils, audio } = ctx;
    const { cx, cy, cz } = xyz;

    const r = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const R = params.radius;
    const th = Math.max(params.thickness, 1e-3);

    // Body envelope.
    let intensity;
    if (params.fill === 'shell') {
      intensity = utils.smoothstep(th, 0, Math.abs(r - R));
    } else {
      intensity = utils.smoothstep(R + th, R - th, r);
    }
    if (intensity <= 0) return [0, 0, 0];

    // ---- GAZE: fixate, then saccade. ---------------------------------------
    // Time is sliced into fixation "slots" of ~1/rate seconds (jittered so the
    // rhythm is organic). Within a slot the eye holds on a pseudo-random target;
    // near the slot boundary it makes a fast smooth-step jump to the next one.
    const rate = Math.max(params.lookSpeed, 0.05);
    const baseDwell = 1 / rate;                 // average hold time
    // Walk fixation indices, accumulating jittered dwell times until we pass t.
    let acc = 0, k = 0, dwell = baseDwell;
    // Bound the loop hard so it can never run away on huge t.
    for (let guard = 0; guard < 4096; guard++) {
      dwell = baseDwell * (0.55 + 0.9 * hash1(k * 1.37 + 4.2));
      if (acc + dwell > t) break;
      acc += dwell;
      k++;
    }
    const into = t - acc;                       // time into current fixation
    // Target gaze (yaw,pitch) for this slot and the next, in [-range,range].
    const range = params.lookRange;
    const tgtYaw0   = (hash1(k * 2.13 + 0.5) * 2 - 1) * range;
    const tgtPitch0 = (hash1(k * 3.77 + 9.1) * 2 - 1) * range * 0.65;
    const tgtYaw1   = (hash1((k + 1) * 2.13 + 0.5) * 2 - 1) * range;
    const tgtPitch1 = (hash1((k + 1) * 3.77 + 9.1) * 2 - 1) * range * 0.65;
    // Ballistic transition over the LAST SACCADE_DUR of the dwell.
    const sStart = Math.max(0, dwell - SACCADE_DUR);
    const sat = utils.smoothstep(sStart, dwell, into); // 0 holding → 1 arrived
    let yaw   = tgtYaw0   + (tgtYaw1   - tgtYaw0)   * sat;
    let pitch = tgtPitch0 + (tgtPitch1 - tgtPitch0) * sat;
    // Ocular micro-tremor: tiny coprime sines so a "still" eye still breathes.
    yaw   += 0.018 * (Math.sin(t * 13.0) + 0.6 * Math.sin(t * 23.3 + 1.1));
    pitch += 0.014 * (Math.sin(t * 17.0 + 0.7) + 0.6 * Math.sin(t * 29.1));

    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
    const fx = syaw * cp;
    const fy = sp;
    const fz = cyaw * cp;

    // Gaze-local up = world-Y projected onto plane ⊥ f, normalized.
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

    // Voxel surface direction.
    let nx, ny, nz;
    if (r < 1e-6) { nx = 0; ny = 1; nz = 0; }
    else { nx = cx / r; ny = cy / r; nz = cz / r; }

    const fwd = nx * fx + ny * fy + nz * fz;
    const xF  = nx * rx + ny * ry + nz * rz;
    const yF  = nx * ux + ny * uy + nz * uz;

    // ---- BLINK: eased lid sweep, top lid leads, occasional double-blink. ----
    let blinkClose = 0; // 0 open … 1 fully shut
    if (params.blinkRate > 0) {
      const interval = 1 / params.blinkRate;
      const phase = t % interval;
      const tail = interval - BLINK_DUR;
      if (phase > tail) {
        const u = (phase - tail) / BLINK_DUR;        // 0..1 across the blink
        // Asymmetric ease: snaps shut fast, opens a touch slower (real lids do).
        const c = u < 0.4 ? utils.smoothstep(0, 0.4, u)
                          : 1 - utils.smoothstep(0.4, 1, u);
        blinkClose = c;
      }
      // Occasional double-blink: a faint second dip right after some blinks.
      if (phase < BLINK_DUR && hash1(Math.floor(t / interval) * 5.1) > 0.7) {
        const u2 = phase / BLINK_DUR;
        blinkClose = Math.max(blinkClose, 0.85 * 4 * u2 * (1 - u2));
      }
    }
    const blinkOpen = 1 - blinkClose;

    // Pupil: slow hippus dilation + (optional) audio-reactive constriction.
    let dilate = 1 + params.pupilDilate * (0.6 * Math.sin(t * 0.31 + 1.1)
                                         + 0.4 * Math.sin(t * 0.17 + 4.3));
    if (params.audioReact && audio) {
      // Bright sound → pupil constricts (smaller); a beat punches it briefly.
      dilate *= 1 - 0.30 * (audio.energy || 0) - (audio.beat ? 0.10 : 0);
    }
    const pupilR = Math.max(0.02, params.pupilRadius * dilate);
    const irisR  = Math.max(pupilR + 0.02, params.irisRadius);

    // Eyelid aperture: top lid drops from the top, bottom lid rises a bit less,
    // so the lids never meet at the equator — gives a heavy, sleepy upper lid.
    const lidTop = irisR * 1.55 * blinkOpen;          // upper aperture
    const lidBot = irisR * 1.30 * (0.35 + 0.65 * blinkOpen); // lower aperture

    const [scR, scG, scB] = utils.parseColor(params.scleraColor);
    const [irR, irG, irB] = utils.parseColor(params.irisColor);
    const [puR, puG, puB] = utils.parseColor(params.pupilColor);
    const [skR, skG, skB] = utils.parseColor(params.skinColor);

    let cr = skR, cg = skG, cb = skB;

    if (fwd > 0) {
      const inLid = (yF > lidTop) || (yF < -lidBot);
      if (inLid) {
        // Eyelid skin — shade it darker in the crease so the lid reads as a fold.
        const overTop = yF > lidTop ? (yF - lidTop) : 0;
        const overBot = yF < -lidBot ? (-lidBot - yF) : 0;
        const crease = Math.exp(-22 * Math.max(overTop, overBot)); // 1 at lash line
        const shade = 1 - 0.45 * crease;
        cr = skR * shade; cg = skG * shade; cb = skB * shade;
      } else {
        const d = Math.sqrt(xF * xF + yF * yF);
        const ang = Math.atan2(yF, xF);

        if (d < pupilR) {
          // Pupil — near-black with the faintest reflected-iris bounce at center
          // so it doesn't read as a flat dead hole.
          const core = utils.smoothstep(pupilR, 0, d); // 1 center → 0 rim
          cr = puR + irR * 0.05 * core;
          cg = puG + irG * 0.05 * core;
          cb = puB + irB * 0.05 * core;
        } else if (d < irisR) {
          // ----- WET LAYERED IRIS -----
          const tt = (d - pupilR) / Math.max(1e-6, irisR - pupilR); // 0 inner → 1 rim
          // Radial fibers: high-frequency angular streaks fading outward, broken
          // up by 3D noise "crypts" so it never looks like a clean gradient.
          const fibers = Math.sin(ang * 26 + utils.noise3d(nx * 4, ny * 4, nz * 4) * 3.5);
          const crypt  = utils.noise3d(nx * 7 + 5, ny * 7, nz * 7 - 3);
          const detail = params.irisDetail;
          let tex = 1
            + detail * 0.28 * fibers * (1 - tt) * (1 - tt)   // fibers strongest near pupil
            + detail * 0.20 * crypt;
          // Collarette: bright ring just outside the pupil (the iris "frill").
          const collar = Math.exp(-Math.pow((tt - 0.18) * 4.5, 2)) * 0.5;
          // Limbal ring: dark, crisp band at the very outer edge of the iris.
          const limbal = utils.smoothstep(0.72, 0.97, tt);
          // Cool→warm color-temperature shift from rim to center adds depth.
          const warm = 1 - tt; // center warmer
          let k = utils.clamp(tex + collar - 0.85 * limbal, 0.12, 1.9);
          cr = (irR * 0.75 + 70 * warm) * k;
          cg = (irG * 0.85 + 40 * warm) * k;
          cb = (irB + 10 * (1 - warm)) * k; // rim a touch bluer
          // Hard dark halo right at the iris↔pupil seam → makes the pupil snap.
          const halo = utils.smoothstep(pupilR + 0.018, pupilR, d);
          cr *= 1 - 0.7 * halo; cg *= 1 - 0.7 * halo; cb *= 1 - 0.7 * halo;
        } else {
          // ----- SCLERA ----- subtle shading toward the rim + faint warm veins.
          const rim = utils.smoothstep(irisR, irisR + 0.22, d); // 0 near iris → 1 corner
          const vein = Math.max(0, utils.noise3d(nx * 9, ny * 3, nz * 9)) ;
          const shade = 1 - 0.18 * rim;                  // corners slightly shadowed
          cr = scR * shade + 26 * vein * rim;            // reddish veins only at corners
          cg = scG * shade - 6  * vein * rim;
          cb = scB * shade - 6  * vein * rim;
        }

        // ---- WET SPECULAR CATCHLIGHT ----
        // A fixed studio light at world (−0.55, 0.7, 0.85). The half-vector glint
        // is anchored in WORLD space, so as the eye saccades the highlight slides
        // across the cornea — the key "wet & alive" cue. Two specks (key + fill).
        if (params.wetness > 0) {
          const Lx = -0.55, Ly = 0.70, Lz = 0.85;
          const Llen = Math.hypot(Lx, Ly, Lz);
          const spec = (nx * Lx + ny * Ly + nz * Lz) / Llen; // surface·light
          const key  = Math.pow(Math.max(0, spec), 90);      // tiny hard glint
          const fill = Math.pow(Math.max(0, spec), 14) * 0.18; // soft sheen
          const glint = (key + fill) * params.wetness * 255;
          cr = Math.min(255, cr + glint);
          cg = Math.min(255, cg + glint);
          cb = Math.min(255, cb + glint);
        }
      }
    }

    // Confine eye details to a thin shell at r≈R so the interior of 'filled'
    // mode is uniformly skin-colored and rays don't tunnel through the ball.
    const surfShell = utils.smoothstep(th, 0, Math.abs(r - R));
    cr = skR + (cr - skR) * surfShell;
    cg = skG + (cg - skG) * surfShell;
    cb = skB + (cb - skB) * surfShell;

    return [cr * intensity, cg * intensity, cb * intensity];
  },
};
