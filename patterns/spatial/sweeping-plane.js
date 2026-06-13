// Sweeping Plane — a luminous wavefront glides back-and-forth through the
// cube along a chosen axis. A razor-thin, near-white leading edge blazes at
// the wavefront; behind it a saturated colored trail fades with depth so the
// plane reads as a glowing sheet dragging a comet-tail through the volume.
//
// The sweep is a triangular wave so the reversal at each end dwells briefly.
// Hue takes a slow journey (drifting with the sweep) and the wavefront itself
// carries a gentle in-plane shimmer + complementary back-edge so it never
// reads as one flat tint. Black space ahead of the front gives true depth.

export const params = {
  axis:      { type: 'select', options: ['x', 'y', 'z'], default: 'z' },
  speed:     { type: 'range', min: 0.05, max: 4,   step: 0.01, default: 0.7 },
  thickness: { type: 'range', min: 0.02, max: 0.6, step: 0.01, default: 0.10 },
  trail:     { type: 'range', min: 0,    max: 0.9, step: 0.01, default: 0.55 },
  hueSpeed:  { type: 'range', min: 0,    max: 2,   step: 0.01, default: 0.18 },
  shimmer:   { type: 'range', min: 0,    max: 1,   step: 0.01, default: 0.45 },
};

export default {
  name: 'Sweeping Plane',

  render(ctx, xyz) {
    const { t, params, utils, audio, Nx, Ny, Nz } = ctx;
    const { u, v, w, cx, cy, cz } = xyz;

    // Coordinate along the sweep axis (0..1), plus the two in-plane axes
    // (centered -1..1) used for shimmer and edge glow. If the sweep axis is
    // only one voxel deep there is no depth to sweep through, so fall back to
    // a centered coord (0.5) and let the whole slab pulse with the front.
    let coord, p, q;
    if (params.axis === 'x') { coord = Nx > 1 ? u : 0.5; p = cy; q = cz; }
    else if (params.axis === 'y') { coord = Ny > 1 ? v : 0.5; p = cx; q = cz; }
    else { coord = Nz > 1 ? w : 0.5; p = cx; q = cy; }

    // Triangular sweep position in [0,1] with a brief dwell at each wall.
    const phase = (t * params.speed) % 2;
    const pos = phase < 1 ? phase : 2 - phase;
    const dir = phase < 1 ? 1 : -1;           // travel direction this pass

    // Signed distance from the wavefront; >0 means behind the front (trail).
    const signed = (coord - pos) * dir;
    const dist = Math.abs(coord - pos);

    const thick = Math.max(params.thickness, 0.02);
    const trailLen = Math.max(params.trail, 0.001);

    // --- Leading edge: a crisp, bright core right at the wavefront. ---
    // smoothstep gives a hard inner falloff so the front reads as an edge.
    const core = utils.smoothstep(thick, 0, dist);

    // --- Trailing wake: only behind the front, fading with depth. ---
    let wake = 0;
    if (signed > 0) {
      wake = utils.smoothstep(trailLen, 0, signed);
      wake *= wake; // ease the falloff so the tail melts into darkness
    }

    // Combined brightness envelope. Nothing ahead of the front lights up,
    // so empty space gives the sweep real depth.
    const env = Math.max(core, wake * 0.85);
    if (env <= 0.001) return [0, 0, 0];

    // --- In-plane shimmer so the sheet isn't a flat tint. ---
    // Coprime sines + slow noise ripple across the plane and through time.
    let ripple = 0;
    if (params.shimmer > 0) {
      const n = utils.noise3d(p * 1.7 + t * 0.3, q * 1.7 - t * 0.25, pos * 3.0);
      const s = 0.5 + 0.5 * Math.sin((p * 3.1 + q * 2.3) * 2.0 + t * 1.7);
      ripple = (0.55 * (n * 0.5 + 0.5) + 0.45 * s - 0.5) * params.shimmer;
    }

    // --- Hue journey: drifts with time and with the front's position so the
    // color evolves as it crosses the volume; the wake reads slightly
    // shifted toward the complement, giving a cool-to-warm depth read. ---
    const beatPush = audio && audio.beat ? 0.18 : 0;
    const baseHue = (t * params.hueSpeed + pos * 0.35 + beatPush) % 1;
    const wakeShift = (signed > 0 ? signed / trailLen : 0) * 0.16;
    const hue = (baseHue + wakeShift + ripple * 0.06 + 1) % 1;

    // Brighter, whiter, less saturated right at the core; deeper and more
    // saturated in the wake. High dynamic range edge -> dark falloff.
    const edge = utils.clamp(core, 0, 1);
    const sat = utils.clamp(0.95 - edge * 0.55, 0.3, 1);

    let val = env;
    // Push the very front toward incandescent white so the leading edge
    // glows hot through the bloom.
    val = utils.clamp(val + edge * edge * 0.35 + ripple * 0.12, 0, 1.2);

    // Subtle audio lift on the energy keeps it alive without washing out.
    const energy = audio ? audio.energy : 0;
    val = utils.clamp(val * (1 + energy * 0.15), 0, 1.25);

    const col = utils.hsv(hue, sat, utils.clamp(val, 0, 1));

    // Add a touch of white at the hot leading edge on top of the hue so the
    // wavefront blooms beyond pure saturation.
    const hot = edge * edge * edge * 90;
    return [
      utils.clamp(col[0] + hot, 0, 255),
      utils.clamp(col[1] + hot, 0, 255),
      utils.clamp(col[2] + hot, 0, 255),
    ];
  },
};
