// Spectrum Cube — a living spectrogram waterfall scrolling through the volume.
//
// One face of the cube reads as a 2D spectrum: the "frequency" axis runs
// low -> mid -> high (built from ctx.audio.low/mid/high), and brightness
// tracks each band's magnitude. Each frame that spectrum slice is pushed
// into a short history buffer that SCROLLS along the chosen axis, so the
// music literally falls front-to-back through the cube like a waterfall.
// Hue tracks frequency; beats punch a bright flash into the newest slice.
//
// Driven entirely by ctx.audio.{energy,low,mid,high,beat}. A gentle idle
// shimmer keeps it alive on quiet/steady input — never all-black, never
// frozen.

export const params = {
  gain:     { type: 'range',  min: 0.5, max: 5,   step: 0.01, default: 1.7 },
  attack:   { type: 'range',  min: 0,   max: 1,   step: 0.01, default: 0.55 },
  decay:    { type: 'range',  min: 0,   max: 1,   step: 0.01, default: 0.9 },
  scroll:   { type: 'range',  min: 0,   max: 4,   step: 0.01, default: 1.4 },
  axis:     { type: 'select', options: ['z', 'y', 'x'], default: 'z' },
  hueSpan:  { type: 'range',  min: 0,   max: 1,   step: 0.01, default: 0.72 },
  hueBase:  { type: 'range',  min: 0,   max: 1,   step: 0.01, default: 0.0 },
  idle:     { type: 'range',  min: 0,   max: 0.4, step: 0.01, default: 0.12 },
};

// --- Stateful history (function API, but we keep a tiny module-level buffer
//     that we advance once per frame so the spectrogram truly scrolls). ---
const HIST = 48;                 // history slices stored (more than any axis)
let slices = null;               // ring buffer of {l,m,h,beat,age}
let head = 0;                    // index of newest slice
let envL = 0, envM = 0, envH = 0;
let beatGlow = 0;                // decaying beat flash
let phase = 0;                   // accumulated scroll position
let lastFrame = -1;

function ensureBuffer() {
  if (slices) return;
  slices = new Array(HIST);
  for (let i = 0; i < HIST; i++) slices[i] = { l: 0, m: 0, h: 0, beat: 0 };
}

function seed(l, m, h) {
  // Fill the whole ring with the current reading so there is never a black
  // "un-warmed" back half on the first second of playback.
  for (let i = 0; i < HIST; i++) {
    slices[i].l = l; slices[i].m = m; slices[i].h = h; slices[i].beat = 0;
  }
}
let seeded = false;

function advance(ctx) {
  const { audio, params, utils, dt } = ctx;
  const a = params.attack;
  const d = params.decay;

  // Envelope-follow each band so slices are smooth, not strobing.
  const follow = (env, target) =>
    target > env ? env + (target - env) * a : env * d;
  envL = follow(envL, utils.clamp(audio.low  * params.gain, 0, 1));
  envM = follow(envM, utils.clamp(audio.mid  * params.gain, 0, 1));
  envH = follow(envH, utils.clamp(audio.high * params.gain, 0, 1));

  if (!seeded) { seed(envL, envM, envH); seeded = true; }

  // Beat flash decays smoothly so it streaks through the waterfall.
  beatGlow = audio.beat ? 1 : beatGlow * 0.82;

  // Idle shimmer so quiet/steady input still breathes & scrolls. The 0.45 DC
  // floor means even dead-silent input never collapses to all-black (the sines
  // run at coprime-ish rates so the breathing never visibly loops).
  const idle = params.idle;
  const t = ctx.t;
  const idleL = idle * (0.55 + 0.45 * Math.sin(t * 0.91));
  const idleM = idle * (0.55 + 0.45 * Math.sin(t * 1.33 + 2.1));
  const idleH = idle * (0.55 + 0.45 * Math.sin(t * 1.77 + 4.2));

  // Advance scroll phase; push a new slice whenever we cross an integer.
  // `scroll` is in slices/second, so the default fills the visible depth in
  // ~1.5 s — a brisk, readable waterfall (and we always creep forward so the
  // column never freezes, even at scroll = 0).
  const slicesPerSec = params.scroll * 6 + 1.0;
  const step = slicesPerSec * (dt > 0 ? dt : 0.016);
  phase += step;
  let push = 0;
  while (phase >= 1) { phase -= 1; push++; }
  if (push > HIST) push = HIST; // clamp after a long stall / dt spike

  for (let k = 0; k < push; k++) {
    head = (head + 1) % HIST;
    const s = slices[head];
    s.l = Math.max(envL, idleL);
    s.m = Math.max(envM, idleM);
    s.h = Math.max(envH, idleH);
    s.beat = beatGlow;
    beatGlow *= 0.6; // successive pushes in one frame shouldn't all blaze
  }

  // The newest slice always tracks the live signal (not a one-way max) so the
  // front face responds instantly and decays naturally between pushes.
  const live = slices[head];
  live.l = Math.max(envL, idleL);
  live.m = Math.max(envM, idleM);
  live.h = Math.max(envH, idleH);
  live.beat = Math.max(live.beat, beatGlow);
}

// Sample the spectrum at a frequency fraction (0=low .. 1=high) for slice s.
// Smoothly blends the three bands so the spectrum reads continuous.
function spectrumAt(s, f) {
  // Triangular weights centred on low(0.0), mid(0.5), high(1.0).
  const wl = Math.max(0, 1 - Math.abs(f - 0.0) * 2);
  const wm = Math.max(0, 1 - Math.abs(f - 0.5) * 2);
  const wh = Math.max(0, 1 - Math.abs(f - 1.0) * 2);
  const sum = wl + wm + wh || 1;
  return (s.l * wl + s.m * wm + s.h * wh) / sum;
}

export default {
  name: 'Spectrum Cube',

  render(ctx, xyz) {
    const { params, utils, frame, audio } = ctx;
    ensureBuffer();
    if (frame !== lastFrame) {
      lastFrame = frame;
      advance(ctx);
    }

    const { u, v, w } = xyz;

    // Axis mapping:
    //   sAxis  -> scroll/history (0 = newest slice = front of waterfall)
    //   fAxis  -> frequency (low -> high)
    //   dAxis  -> depth shade for a little 3D body
    let sPos, fPos, dPos;
    if (params.axis === 'z')      { sPos = w; fPos = v; dPos = u; }
    else if (params.axis === 'y') { sPos = v; fPos = u; dPos = w; }
    else                          { sPos = u; fPos = v; dPos = w; }

    // Map this voxel's scroll position to a history slice.
    // sPos 0 -> newest (head); deeper -> older slices. The visible depth spans
    // the most recent (HIST-1) slices so the whole cube is a live waterfall.
    const depthIdx = Math.round(sPos * (HIST - 1));
    const sliceIdx = ((head - depthIdx) % HIST + HIST) % HIST;
    const s = slices[sliceIdx];

    // Spectrum magnitude at this frequency column, for this slice.
    let mag = spectrumAt(s, fPos);

    // Per-frequency ripple: a slow drifting noise sheet so the spectrum
    // surface shimmers and the "columns" never read as one flat wall. The
    // ripple rides on the magnitude (multiplicative) so dark stays dark.
    const ripple =
      0.7 +
      0.3 * utils.noise3d(fPos * 3.0, sPos * 2.2 - ctx.t * 0.35, ctx.t * 0.18);
    mag *= ripple;

    // Older slices fade as they fall away — strong front-to-back value ramp.
    const ageFade = utils.smoothstep(1.02, -0.05, sPos);
    mag *= ageFade;

    // Crisp edge with real dynamic range: faint bands stay dim, strong bands
    // bloom toward full. The gamma keeps mid values from washing into a sheet.
    let lit = utils.smoothstep(0.06, 0.55, mag);
    lit = lit * lit * (3 - 2 * lit); // extra contrast S-curve

    // A faint living ember on the front slices guarantees the cube is never
    // fully black, even under dead silence — but it falls off fast with depth
    // so the back stays dark for contrast.
    const ember = 0.07 * utils.smoothstep(0.45, 0.0, sPos) *
      (0.75 + 0.25 * Math.sin(ctx.t * 1.1 + fPos * 6.0));
    lit = Math.max(lit, ember);
    if (lit <= 0.001) return [0, 0, 0];

    // Hue journeys across the frequency axis (a real spectrum sweep),
    // with a slow global drift for life.
    const hueDrift = 0.04 * Math.sin(ctx.t * 0.27);
    let hue = params.hueBase + params.hueSpan * fPos + hueDrift;

    // Beat slices flash toward white-hot and shove hue toward the warm end.
    const beat = s.beat;
    hue -= beat * 0.12;

    // Depth/body shading: centre of the cross-section is brightest.
    const body = 1 - Math.abs(dPos - 0.5) * 0.7;

    // Value: bright cores, dark falloff. Energy lifts the whole field a touch.
    const energyLift = 0.85 + 0.25 * utils.clamp(audio.energy, 0, 1);
    let val = utils.clamp(lit * body * energyLift, 0, 1);
    val = utils.clamp(val + beat * 0.55, 0, 1);

    // High-magnitude / beat cores desaturate toward white for HDR pop.
    const sat = utils.clamp(1 - lit * 0.35 - beat * 0.5, 0, 1);

    const col = utils.hsv(((hue % 1) + 1) % 1, sat, val);

    // Add a cool white sparkle on beats so the front face really punches.
    if (beat > 0.01) {
      const flash = beat * (1 - sPos) * 90;
      col[0] = utils.clamp(col[0] + flash * 0.9, 0, 255);
      col[1] = utils.clamp(col[1] + flash, 0, 255);
      col[2] = utils.clamp(col[2] + flash, 0, 255);
    }

    return col;
  },
};
