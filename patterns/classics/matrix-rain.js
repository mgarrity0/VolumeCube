// Matrix Rain — the iconic falling green digital code, in volume.
//
// Every (x,z) column gets an independent "drop": a head that falls from the
// top of the cube at its own randomized speed, leaving a fading green trail
// behind it. The leading voxel burns near-white-green (the bright glyph that
// just lit up), and the trail decays to deep green over a configurable length,
// so columns read as crisp bright heads tapering into the dark — never a
// uniform wash. Each head respawns above the cube after a random gap, so the
// field never falls in lockstep: the rain breathes and stutters organically.
// Occasional columns "flare" — the whole streak surges bright for a moment,
// the rare glowing burst that punctuates the classic effect.
//
// Class API: per-column state (head Y, fall speed, gap timer, flare timer)
// advanced in update(); render() draws each column by distance-behind-head.
// Negative space between columns stays pure black for bloom-friendly contrast.

export const params = {
  speed:     { type: 'range', min: 0.5, max: 12,  step: 0.1,  default: 4.5, label: 'Fall speed' },
  speedVar:  { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.6, label: 'Speed variance' },
  trailLen:  { type: 'range', min: 1,   max: 12,  step: 0.1,  default: 5.5, label: 'Trail length' },
  density:   { type: 'range', min: 0.1, max: 1,   step: 0.01, default: 0.85, label: 'Column density' },
  gap:       { type: 'range', min: 0,   max: 4,   step: 0.05, default: 1.2, label: 'Respawn gap' },
  flares:    { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.4, label: 'Flare chance' },
  flicker:   { type: 'range', min: 0,   max: 1,   step: 0.01, default: 0.45, label: 'Glyph flicker' },
  color:     { type: 'color', default: '#1bff5a' },
};

export default class MatrixRain {
  static name = 'Matrix Rain';

  setup(ctx) {
    const { Nx, Nz } = ctx;
    this.cols = [];
    this.nx = Nx;
    this.nz = Nz;
    for (let x = 0; x < Nx; x++) {
      for (let z = 0; z < Nz; z++) {
        // Stagger initial heads across (and above) the cube so nothing
        // falls in sync from frame zero.
        this.cols.push(this.makeColumn(ctx, x, z, true));
      }
    }
  }

  // Per-column drop. `initial` spreads the first heads through the volume
  // instead of all starting above it.
  makeColumn(ctx, x, z, initial) {
    const { Ny, params } = ctx;
    const sv = params.speedVar;
    // Speed multiplier in [1-sv, 1+sv*1.3] — some columns sprint, some crawl.
    const speedMul = 1 - sv + Math.random() * sv * 2.3;
    const live = Math.random() < params.density;
    return {
      x, z,
      y: initial ? Math.random() * (Ny * 1.6) : Ny + Math.random() * 2 + params.trailLen,
      speedMul,
      live,                              // false columns are dark this cycle
      gapTimer: live ? 0 : Math.random() * params.gap,
      flare: 0,                          // 0..1 brightness surge, decays over time
      seed: Math.random() * 1000,        // stable phase for per-glyph flicker
    };
  }

  update(ctx) {
    const { Nx, Nz, dt, Ny, params, utils } = ctx;

    // Rebuild the column grid if the cube was resized.
    if (this.nx !== Nx || this.nz !== Nz || this.cols.length !== Nx * Nz) {
      this.setup(ctx);
    }

    const fallSpan = Ny + params.trailLen + 2;
    for (let i = 0; i < this.cols.length; i++) {
      const c = this.cols[i];

      if (!c.live) {
        // Dark column waiting to wake up.
        c.gapTimer -= dt;
        if (c.gapTimer <= 0) {
          this.cols[i] = this.makeColumn(ctx, c.x, c.z, false);
          this.cols[i].live = true;
          this.cols[i].gapTimer = 0;
        }
        continue;
      }

      c.y -= params.speed * c.speedMul * dt;

      // Decay any active flare.
      if (c.flare > 0) c.flare = Math.max(0, c.flare - dt * 1.6);

      // Head has fully exited below the floor (trail trails upward, so wait
      // until the whole trail has cleared the bottom).
      if (c.y < -params.trailLen - 1) {
        const reborn = this.makeColumn(ctx, c.x, c.z, false);
        // Random gap: sometimes immediate, sometimes a dark pause.
        const wantGap = Math.random() < utils.clamp(params.gap, 0, 1) * 0.55 + 0.1;
        reborn.live = !(wantGap && params.gap > 0);
        if (!reborn.live) reborn.gapTimer = Math.random() * params.gap + 0.1;
        // Roll for a flare on the fresh streak.
        if (Math.random() < params.flares * 0.5) reborn.flare = 1;
        this.cols[i] = reborn;
        continue;
      }

      // Mid-fall chance to ignite a flare (rare, brief).
      if (c.flare <= 0 && Math.random() < params.flares * dt * 0.6) c.flare = 1;
    }
    void fallSpan;
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, t, params, utils } = ctx;
    out.fill(0);

    const [cr, cg, cb] = utils.parseColor(params.color);
    const trail = Math.max(0.5, params.trailLen);
    const flickerAmt = params.flicker;

    for (const c of this.cols) {
      if (!c.live) continue;

      // Walk the integer voxels of this column from head downward through the
      // trail. dy = how far a voxel sits *behind* (above) the head.
      const top = Math.ceil(c.y);
      const bottom = Math.floor(c.y - trail - 1);
      for (let y = Math.min(Ny - 1, top); y >= 0 && y >= bottom; y--) {
        const dy = c.y - y;               // 0 at head, grows up the trail
        if (dy < -1 || dy > trail + 1) continue;

        let intensity;
        let headBlend;                    // 0..1, how "head-like" this voxel is
        if (dy <= 0) {
          // At/just below the head — the leading glyph, brightest, white-green.
          intensity = utils.clamp(1 + dy, 0, 1); // fades just under the head
          headBlend = intensity;
        } else {
          // Trail: bright near the head, decaying with distance. A slight
          // exponential-ish curve keeps the first couple cells punchy and the
          // tail thin, instead of a flat linear ramp.
          const f = 1 - dy / trail;       // 1 near head -> 0 at tail end
          intensity = utils.clamp(f, 0, 1);
          intensity = intensity * intensity * (0.55 + 0.45 * intensity);
          headBlend = utils.smoothstep(0.0, 0.6, f) * 0.9;
        }
        if (intensity <= 0.003) continue;

        // Per-glyph flicker: each voxel twinkles a little on its own phase,
        // as if individual code characters are changing. Heads flicker less
        // (they should stay crisp), trail glyphs shimmer more.
        let glyph = 1;
        if (flickerAmt > 0) {
          const ph = c.seed + y * 1.7;
          const tw = 0.5 + 0.5 * Math.sin(t * 9.0 + ph) * Math.sin(t * 3.3 + ph * 0.7);
          glyph = 1 - flickerAmt * (1 - headBlend) * (1 - tw) * 0.8;
        }

        // Flare surges the whole streak bright and pushes toward white.
        const flare = c.flare;
        const lit = utils.clamp(intensity * glyph * (1 + flare * 0.9), 0, 1.6);

        // Color: deep green in the trail, blown toward white at the head and
        // during flares for that hot-glyph bloom.
        const white = utils.clamp(headBlend * 0.85 + flare * 0.6, 0, 1);
        let r = cr * lit + (255 - cr) * white * lit;
        let g = cg * lit + (255 - cg) * white * lit;
        let b = cb * lit + (255 - cb) * white * lit;

        const idx = (c.x * Ny + y) * Nz + c.z;
        out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r);
        out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g);
        out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b);
      }
    }
  }
}
