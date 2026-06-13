// Plasma — volumetric multi-axis sine interference that breathes THROUGH the cube.
// Layered coprime sines + a gentle 3D-noise warp build an organic, non-repeating
// field; the field drives a hue journey (color1 -> color2 with a complementary
// accent at the hot cores) plus a sharp value falloff so bright filaments float in
// dark space instead of flooding every voxel to flat grey. Three flavors:
//   radial  — concentric interference waves washing out from the heart of the cube
//   linear  — diagonal sheets sweeping front-to-back across the volume
//   sphere  — pulsing shells expanding/contracting along the depth axis

export const params = {
  speed:     { type: 'range', min: 0,   max: 5,   step: 0.01, default: 1 },
  scale:     { type: 'range', min: 0.1, max: 6,   step: 0.01, default: 3 },
  warp:      { type: 'range', min: 0,   max: 1.5, step: 0.01, default: 0.55, label: 'Warp' },
  contrast:  { type: 'range', min: 0.4, max: 3,   step: 0.01, default: 1.5, label: 'Contrast' },
  hueTravel: { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.35, label: 'Hue travel' },
  color1:    { type: 'color', default: '#ff1e5a' },
  color2:    { type: 'color', default: '#1a6bff' },
  mode:      { type: 'select', options: ['radial', 'linear', 'sphere'], default: 'radial' },
};

export default {
  name: 'Plasma',

  render(ctx, xyz) {
    const { t, params, utils, audio } = ctx;
    const { cx, cy, cz } = xyz;
    const s = params.scale;
    const sp = params.speed;

    // Audio is optional — beat gives the field a quick swell, energy adds drive.
    const energy = (audio && audio.energy) || 0;
    const beat   = (audio && audio.beat) ? 1 : 0;
    const drive  = sp * (1 + 0.25 * energy);
    const t1 = t * drive;

    // --- Organic 3D warp: nudge the sample point so the field flows through the
    // volume instead of sitting on a fixed lattice. Coprime time rates keep it
    // from looping; the warp is depth-aware (uses cz) for real front-to-back life.
    const wstr = params.warp;
    let wx = cx, wy = cy, wz = cz;
    if (wstr > 0.0001) {
      const nf = s * 0.5;
      wx += wstr * utils.noise3d(cx * nf + t1 * 0.37, cy * nf, cz * nf - t1 * 0.21);
      wy += wstr * utils.noise3d(cy * nf - t1 * 0.29, cz * nf, cx * nf + t1 * 0.17);
      wz += wstr * utils.noise3d(cz * nf + t1 * 0.23, cx * nf, cy * nf - t1 * 0.31);
    }

    // --- Build the interference field k (0..1). Each mode keeps plasma's identity
    // but threads motion along the depth axis so it never reads as a flat 2D plate.
    let k;
    let depthBias; // 0..1, higher = nearer the lit front of this mode's structure
    if (params.mode === 'sphere') {
      const r = Math.sqrt(wx * wx + wy * wy + wz * wz);
      const shell = 0.5 + 0.5 * Math.sin(r * s * 2 - t1 * 2);
      const swirl = 0.5 + 0.5 * Math.sin((wx + wz) * s * 0.8 + t1 * 1.1);
      k = shell * 0.7 + swirl * 0.3;
      depthBias = 1 - utils.clamp(r * 0.7, 0, 1);
    } else if (params.mode === 'linear') {
      // Diagonal sheets that travel front-to-back (the cz term + time).
      const a = Math.sin((wx + wy + wz) * s - t1 * 1.5);
      const b = Math.sin((wx - wz) * s * 0.7 + t1 * 0.9);
      const c = Math.sin(wz * s * 1.3 - t1 * 1.1);
      k = (a + b + c + 3) / 6;
      depthBias = 0.5 + 0.5 * Math.sin((wx + wy + wz) * s - t1 * 1.5);
    } else {
      // radial: concentric rings washing out from the heart, with per-axis swirl.
      const r = Math.sqrt(wx * wx + wy * wy + wz * wz);
      const a = Math.sin(wx * s + t1);
      const b = Math.sin(wy * s + t1 * 1.3);
      const c = Math.sin(wz * s + t1 * 0.7);
      const ring = Math.sin(r * s * 1.6 - t1 * 1.8);
      k = (a + b + c + ring + 4) / 8;
      depthBias = 0.5 + 0.5 * ring;
    }

    // Beat swell: briefly pushes the whole field hotter on a kick.
    k = utils.clamp(k + beat * 0.12, 0, 1);

    // --- High dynamic range: center k, apply contrast, remap to a steep curve so
    // we get bright filament cores with dark falloff (depth via value, not flat).
    let centered = (k - 0.5) * params.contrast + 0.5;
    centered = utils.clamp(centered, 0, 1);
    // smoothstep-shaped intensity: crisp edges, real darkness between filaments.
    const core = utils.smoothstep(0.32, 0.78, centered);
    const value = 0.06 + 0.94 * (core * core); // squared -> punchy bright cores, deep blacks

    // --- Color: a hue JOURNEY between color1 and color2 driven by the field, plus
    // a complementary accent that only blooms at the hottest cores.
    let col = utils.mix(params.color1, params.color2, centered);

    // Travel the hue smoothly over time + space so the palette keeps evolving.
    const c1 = utils.parseColor(params.color1);
    const c2 = utils.parseColor(params.color2);
    const accentHue =
      (rgbHue(c1) + 0.5 + params.hueTravel * (0.5 * Math.sin(t1 * 0.13) + depthBias * 0.5)) % 1;
    const accent = utils.hsv(accentHue, 0.95, 1);
    const hot = utils.smoothstep(0.7, 1.0, core); // only the brightest cores get accent
    col = utils.mix(col, accent, hot * 0.6);

    // Apply HDR value + a touch of extra saturation pop at the cores.
    const r = utils.clamp(col[0] * value, 0, 255);
    const g = utils.clamp(col[1] * value, 0, 255);
    const b = utils.clamp(col[2] * value, 0, 255);
    return [r, g, b];
  },
};

// Approximate hue (0..1) of an [r,g,b] color so the accent stays related to color2.
function rgbHue(c) {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 1e-6) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return h < 0 ? h + 1 : h;
}
