// Ripple Tank — a living 3D wave-interference field.
//
// A handful of point sources sit inside the volume, each emitting an expanding
// spherical wavefront: sin(distance * k - time). Every voxel SUMS the waves it
// receives, so where crests meet you get bright constructive nodes and where a
// crest meets a trough you get dark destructive nulls. The result is a breathing
// lattice of glowing antinodes and black voids — the classic ripple-tank moiré,
// lifted into three dimensions.
//
// The summed amplitude is normalized to -1..1 and mapped through a vivid DIVERGING
// palette: deep cold (troughs) -> dark vacuum (the null surface) -> hot crest. The
// near-zero band is pushed to true black so the destructive surfaces read as crisp
// negative space and the antinodes pop as bright cores through the bloom.
//
// The sources DRIFT on slow, coprime Lissajous orbits through the full depth of
// the cube, so the interference figure continuously reorganizes and never repeats.
// A faint distance falloff keeps far sources from washing the field flat, giving
// real front-to-back depth instead of a uniform plate.
//
// Pure per-voxel function API — no state, no allocation in the hot path beyond a
// tiny per-call source cache keyed off ctx.frame.

export const params = {
  speed:      { type: 'range', min: 0,    max: 3,   step: 0.01, default: 1,    label: 'Wave speed' },
  sources:    { type: 'int',   min: 2,    max: 4,                default: 3,    label: 'Sources' },
  wavelength: { type: 'range', min: 0.15, max: 1.2, step: 0.01, default: 0.42, label: 'Wavelength' },
  drift:      { type: 'range', min: 0,    max: 2,   step: 0.01, default: 0.6,  label: 'Source drift' },
  nullWidth:  { type: 'range', min: 0,    max: 0.6, step: 0.01, default: 0.22, label: 'Null darkness' },
  contrast:   { type: 'range', min: 0.5,  max: 3,   step: 0.01, default: 1.4,  label: 'Contrast' },
  falloff:    { type: 'range', min: 0,    max: 1.5, step: 0.01, default: 0.45, label: 'Distance falloff' },
  crestColor: { type: 'color', default: '#ff5a1e' }, // hot constructive antinodes
  troughColor:{ type: 'color', default: '#1e8bff' }, // cold destructive crests
};

const TAU = Math.PI * 2;

// Up to 4 source "personalities": each owns a slow, coprime Lissajous orbit so the
// interference figure drifts through the whole volume and never loops. Center-biased
// so sources roam the interior rather than clinging to the walls.
const SEED = [
  { ax: 0.62, ay: 0.55, az: 0.70, fx: 0.231, fy: 0.317, fz: 0.193, px: 0.0,  py: 1.7, pz: 3.1 },
  { ax: 0.58, ay: 0.66, az: 0.60, fx: 0.287, fy: 0.211, fz: 0.263, px: 2.3,  py: 4.1, pz: 0.6 },
  { ax: 0.66, ay: 0.52, az: 0.64, fx: 0.197, fy: 0.349, fz: 0.229, px: 5.0,  py: 0.9, pz: 2.4 },
  { ax: 0.54, ay: 0.62, az: 0.72, fx: 0.331, fy: 0.179, fz: 0.301, px: 1.2,  py: 3.3, pz: 5.5 },
];

// Per-frame source-position cache so we compute the (cheap) orbits once per frame
// instead of once per voxel. Keyed on frame + the params that move the sources.
let _cache = { frame: -1, key: '', n: 0, sx: new Float32Array(4), sy: new Float32Array(4), sz: new Float32Array(4) };

export default {
  name: 'Ripple Tank',

  render(ctx, xyz) {
    const { t, frame, params, utils, audio } = ctx;
    const { cx, cy, cz } = xyz;

    const n = Math.max(2, Math.min(4, params.sources | 0));
    const sp = params.speed;
    const drift = params.drift;

    // --- Refresh the source positions once per frame (and on param/source change).
    const key = n + '|' + sp + '|' + drift;
    if (_cache.frame !== frame || _cache.key !== key) {
      const td = t * drift;
      for (let i = 0; i < n; i++) {
        const s = SEED[i];
        // Slow Lissajous orbit inside the centered cube (-1..1). Kept well inside
        // the walls (×0.85) so wavefronts have room to expand and overlap.
        _cache.sx[i] = Math.sin(td * s.fx * TAU + s.px) * s.ax * 0.85;
        _cache.sy[i] = Math.sin(td * s.fy * TAU + s.py) * s.ay * 0.85;
        _cache.sz[i] = Math.sin(td * s.fz * TAU + s.pz) * s.az * 0.85;
      }
      _cache.frame = frame;
      _cache.key = key;
      _cache.n = n;
    }

    // --- Wave parameters. k = spatial frequency (2π / wavelength), w = temporal.
    // Audio (optional) gives the medium a gentle energy swell and a beat kick that
    // briefly tightens the wavelength so the pattern crackles to the music.
    const energy = (audio && audio.energy) || 0;
    const beat   = (audio && audio.beat) ? 1 : 0;
    const wl = Math.max(0.08, params.wavelength * (1 - 0.18 * beat));
    const k = TAU / wl;
    const w = sp * (1 + 0.2 * energy) * 3.2; // temporal angular rate

    const fall = params.falloff;

    // --- Sum the spherical wavefronts arriving at this voxel.
    // Each contributes sin(k*d - w*t + phase) with a soft 1/(1+fall*d) amplitude
    // so nearer sources dominate, carving real depth into the field.
    let sum = 0;
    let ampTotal = 0;
    for (let i = 0; i < n; i++) {
      const dx = cx - _cache.sx[i];
      const dy = cy - _cache.sy[i];
      const dz = cz - _cache.sz[i];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const amp = 1 / (1 + fall * d * 1.6);
      // Per-source phase offset (from seed) keeps the figure asymmetric & alive.
      sum += amp * Math.sin(k * d - w * t + SEED[i].px * 0.5);
      ampTotal += amp;
    }

    // Normalize to roughly -1..1 regardless of source count / falloff.
    let a = ampTotal > 1e-4 ? sum / ampTotal : 0;

    // Contrast around zero: steepen crest/trough, deepen the null surface.
    a = utils.clamp(a * params.contrast, -1, 1);

    // --- Diverging color map.
    //   a > 0  -> constructive crest  -> crestColor (hot)
    //   a < 0  -> destructive trough  -> troughColor (cold)
    //   a ≈ 0  -> the null surface     -> pushed to black
    const mag = Math.abs(a);

    // Null band: |a| below nullWidth fades to darkness, giving crisp negative space.
    // smoothstep makes the edge of every antinode sharp and bloom-friendly.
    const nw = params.nullWidth;
    const lit = utils.smoothstep(nw, Math.min(1, nw + 0.45), mag);

    // Punchy value curve: squared brightness so cores blaze and mid-field stays dim.
    const value = lit * lit;

    // Choose the diverging side; blow the very brightest antinodes toward white-hot
    // so the constructive peaks read as luminous cores rather than flat tint.
    const base = a >= 0 ? params.crestColor : params.troughColor;
    let col = utils.parseColor(base);

    // White-hot bloom only at the strongest crests (positive side gets the hottest pop).
    const hot = utils.smoothstep(0.72, 1.0, mag) * (a >= 0 ? 1 : 0.55);
    col = utils.mix(col, [255, 255, 255], hot * 0.7);

    // A subtle complementary tint shift across the magnitude keeps the palette
    // evolving between the two anchors near the null surface (where waves cross).
    const cross = utils.smoothstep(0.0, nw + 0.3, mag);
    if (cross < 1) {
      const blendTo = a >= 0 ? params.troughColor : params.crestColor;
      col = utils.mix(blendTo, col, cross); // near null -> hint of the other pole
    }

    const r = utils.clamp(col[0] * value, 0, 255);
    const g = utils.clamp(col[1] * value, 0, 255);
    const b = utils.clamp(col[2] * value, 0, 255);
    return [r, g, b];
  },
};
