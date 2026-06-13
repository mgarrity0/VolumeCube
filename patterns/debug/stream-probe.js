// Stream Probe — wiring-verification pattern.
//
// Lights a single "head" voxel that sweeps through the cube in **logical**
// index order (x*Ny*Nz + y*Nz + z). Because the color pipeline applies the
// wiring address map after the pattern runs, when your wiring config is
// correct the physical head traces the actual path your LED strip takes
// through the cube. With the "Show wiring path" overlay turned on you can
// watch the head glide along the overlay line — any divergence flags a
// wiring-config error before you burn it into firmware.
//
// Also includes a faint background that paints every voxel by its logical
// position in the stream, so you can eyeball the full numbering at a
// glance (toggle with `showRamp`).
//
// Legibility aids (this is a DIAGNOSTIC, not decoration):
//   * The head has a pure-white over-bright core so it's unmistakable even
//     against the colored ramp, with a quadratic tail fading behind it.
//   * The ramp is brightness-boosted at index 0 and 100% so the start and
//     end of the strip are obvious reference points when reading the path.

export const params = {
  speed:     { type: 'range', min: 0.5, max: 200, step: 0.5, default: 20, label: 'LEDs / sec' },
  tailLen:   { type: 'int',   min: 1,   max: 40,  default: 5 },
  headColor: { type: 'color', default: '#ffffff' },
  showRamp:  { type: 'toggle', default: true, label: 'Show index ramp' },
  rampLevel: { type: 'range', min: 0, max: 0.6, step: 0.01, default: 0.15, label: 'Ramp brightness' },
};

export default class StreamProbe {
  static name = 'Stream Probe';

  setup() {}

  render(ctx, out) {
    const { t, Nx, Ny, Nz, params, utils } = ctx;
    const total = Math.max(1, Nx * Ny * Nz);
    const tailLen = Math.max(1, params.tailLen);
    const head = ((t * params.speed) % total + total) % total;
    const [hr, hg, hb] = utils.parseColor(params.headColor);
    const ramp = params.showRamp ? params.rampLevel : 0;
    const denom = total > 1 ? total - 1 : 1;

    for (let i = 0; i < total; i++) {
      // Faint ramp so the full strip is visible, colored by position.
      let r = 0, g = 0, b = 0;
      if (ramp > 0) {
        const hue = i / total;
        // Mark the two endpoints brighter so the strip's start/end read at a
        // glance — they are the anchors for verifying the wiring direction.
        const isEndpoint = i === 0 || i === total - 1;
        const lvl = isEndpoint ? Math.min(0.6, ramp * 3) : ramp;
        const [rr, gg, bb] = utils.hsv(hue, 0.85, lvl);
        r = rr; g = gg; b = bb;
      }

      // Head + tail. Distance is measured modularly so the head wraps
      // cleanly back to i=0 without a visible seam.
      let d = head - i;
      if (d < 0) d += total;
      if (d < tailLen) {
        const k = 1 - d / tailLen;
        const intensity = k * k; // quadratic falloff reads as a sharper head
        // The leading voxel gets a pure-white over-bright core so the head is
        // unmistakable even when it sits on top of a saturated ramp color.
        if (d < 1) {
          r = 255; g = 255; b = 255;
        } else {
          r = Math.max(r, hr * intensity);
          g = Math.max(g, hg * intensity);
          b = Math.max(b, hb * intensity);
        }
      }

      out[i * 3 + 0] = Math.min(255, r);
      out[i * 3 + 1] = Math.min(255, g);
      out[i * 3 + 2] = Math.min(255, b);
    }
  }
}
