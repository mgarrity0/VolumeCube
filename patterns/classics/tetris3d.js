// Tetris 3D — auto-playing volumetric Tetris simulator.
//
// Tetracubes (four connected unit cubes) fall from Y=Ny-1 toward Y=0 in
// discrete steps. When a piece can't fall further it locks into the stack.
// Any fully-filled XZ slice flashes brilliant white, then collapses, with
// the layers above dropping down by one — the 3D line-clear.
//
// SHOW-STOPPER notes (default params are tuned to look great with zero
// tuning):
//   * The cube is NEVER empty. setup() pre-seeds a low rubble layer and a
//     piece spawns mid-fall, so there is bold color and motion from frame 0
//     — no dead waiting while the first piece drifts down.
//   * The active piece glows: a bright saturated core with a soft additive
//     bloom into its neighbors, plus a dim landing-ghost projected straight
//     down so the eye tracks it through the volume (depth cue).
//   * Line clears are PUNCHY: the full slice goes white-hot, and a brief
//     volume-wide bloom pulse washes the whole stack so a clear reads from
//     across the room.
//   * The locked stack keeps each piece's rainbow origin color but breathes
//     with a slow vertical hue-shimmer so the whole structure stays alive.
//
// Still a *simulator*, not a playable game: placement is random so the stack
// grows, clears happen organically, and you just watch it run.

// Tetracubes: each entry is [color, [rotations]] where each rotation is a
// list of [dx, dy, dz] offsets from the piece origin. We hard-code a few
// rotations per piece for visual variety rather than full rotation groups.
const PIECES = [
  { // I — long bar
    color: [90, 200, 255],
    rots: [
      [[0,0,0],[1,0,0],[2,0,0],[3,0,0]],
      [[0,0,0],[0,0,1],[0,0,2],[0,0,3]],
      [[0,0,0],[0,1,0],[0,2,0],[0,3,0]],
    ],
  },
  { // O — 2x2 square
    color: [255, 225, 60],
    rots: [
      [[0,0,0],[1,0,0],[0,0,1],[1,0,1]],
      [[0,0,0],[0,1,0],[1,0,0],[1,1,0]],
    ],
  },
  { // T — flat T
    color: [200, 90, 255],
    rots: [
      [[0,0,0],[1,0,0],[2,0,0],[1,0,1]],
      [[0,0,0],[0,0,1],[0,0,2],[1,0,1]],
      [[0,0,0],[1,0,0],[2,0,0],[1,1,0]],
    ],
  },
  { // L — L-shape
    color: [255, 140, 30],
    rots: [
      [[0,0,0],[1,0,0],[2,0,0],[0,0,1]],
      [[0,0,0],[0,0,1],[0,0,2],[1,0,0]],
      [[0,0,0],[0,1,0],[0,2,0],[1,0,0]],
    ],
  },
  { // S — skew
    color: [60, 230, 120],
    rots: [
      [[0,0,0],[1,0,0],[1,0,1],[2,0,1]],
      [[0,0,1],[0,0,0],[1,1,0],[1,1,1]],
    ],
  },
  { // Tripod — 3D-only: three arms from a corner cube
    color: [255, 70, 150],
    rots: [
      [[0,0,0],[1,0,0],[0,1,0],[0,0,1]],
      [[0,0,0],[1,0,0],[0,0,1],[1,1,0]],
      [[0,0,0],[0,1,0],[0,0,1],[1,1,1]],
    ],
  },
];

export const params = {
  dropRate:    { type: 'range', min: 1,   max: 30,  step: 0.5,  default: 9,    label: 'Drop steps / sec' },
  spawnDelay:  { type: 'range', min: 0,   max: 1,   step: 0.02, default: 0.04, label: 'Pause before new piece' },
  clearFlash:  { type: 'range', min: 0,   max: 0.5, step: 0.01, default: 0.22, label: 'Layer-clear flash (s)' },
  pieceBright: { type: 'range', min: 0.7, max: 1.5, step: 0.05, default: 1.2,  label: 'Active piece brightness' },
  stackBright: { type: 'range', min: 0.3, max: 1,   step: 0.05, default: 0.8,  label: 'Stack brightness' },
  glow:        { type: 'range', min: 0,   max: 1,   step: 0.05, default: 0.55, label: 'Bloom / glow' },
  showGhost:   { type: 'toggle', default: true,                              label: 'Landing ghost' },
};

// Pick a rotation that fits within the (Nx, Ny, Nz) grid — filters out
// rotations whose footprint exceeds any axis. Falls back to the first
// rotation if none fit (tiny grids will clip visually, which is fine).
function fittingRots(piece, Nx, Ny, Nz) {
  const fits = [];
  for (const rot of piece.rots) {
    let maxX = 0, maxY = 0, maxZ = 0;
    for (const [dx, dy, dz] of rot) {
      if (dx > maxX) maxX = dx;
      if (dy > maxY) maxY = dy;
      if (dz > maxZ) maxZ = dz;
    }
    if (maxX < Nx && maxY < Ny && maxZ < Nz) fits.push(rot);
  }
  return fits.length > 0 ? fits : [piece.rots[0]];
}

export default class Tetris3D {
  static name = 'Tetris 3D (Auto-play)';

  setup(ctx) {
    this.Nx = ctx.Nx; this.Ny = ctx.Ny; this.Nz = ctx.Nz;
    const total = this.Nx * this.Ny * this.Nz;
    this.stack = new Uint8Array(total);
    this.color = new Uint8Array(total * 3);
    this.flashLayers = [];
    this.dropAcc = 0;
    this.pauseT = 0;
    this.clearPulse = 0;   // 0..1 volume-wide bloom wash after a clear
    // Pre-seed a low rubble bed so the cube reads as a game-in-progress from
    // frame 0 instead of an empty void while the first piece drifts down.
    this.seedRubble();
    this.spawnPiece(true);
  }

  // Fill the bottom 1-2 layers with a partial scatter of colored blocks so
  // there is immediate color and structure. Avoids completely full slices so
  // we don't trigger a clear on the very first frame.
  seedRubble() {
    const { Nx, Ny, Nz } = this;
    const beds = Math.min(2, Math.max(1, Ny - 1));
    for (let y = 0; y < beds; y++) {
      for (let x = 0; x < Nx; x++) {
        for (let z = 0; z < Nz; z++) {
          // ~62% fill — dense enough to read, sparse enough to leave gaps.
          if (Math.random() < 0.62) {
            const p = PIECES[(Math.random() * PIECES.length) | 0];
            const idx = this.idx(x, y, z);
            this.stack[idx] = 1;
            this.color[idx * 3 + 0] = p.color[0];
            this.color[idx * 3 + 1] = p.color[1];
            this.color[idx * 3 + 2] = p.color[2];
          }
        }
      }
    }
  }

  spawnPiece(midAir) {
    const { Nx, Ny, Nz } = this;
    const piece = PIECES[(Math.random() * PIECES.length) | 0];
    const rots = fittingRots(piece, Nx, Ny, Nz);
    const rot = rots[(Math.random() * rots.length) | 0];
    let maxX = 0, maxY = 0, maxZ = 0;
    for (const [dx, dy, dz] of rot) {
      if (dx > maxX) maxX = dx;
      if (dy > maxY) maxY = dy;
      if (dz > maxZ) maxZ = dz;
    }
    // Spawn at the top normally; on the very first piece start partway down
    // so motion is visible immediately rather than at the ceiling.
    const top = Ny - 1 - maxY;
    const y = midAir ? Math.max(0, Math.floor(top * 0.55)) : top;
    this.piece = {
      blocks: rot,
      color: piece.color,
      x: Math.floor(Math.random() * Math.max(1, Nx - maxX)),
      y,
      z: Math.floor(Math.random() * Math.max(1, Nz - maxZ)),
    };
  }

  idx(x, y, z) {
    return (x * this.Ny + y) * this.Nz + z;
  }

  collides(px, py, pz) {
    const { Nx, Nz } = this;
    for (const [dx, dy, dz] of this.piece.blocks) {
      const x = px + dx, y = py + dy, z = pz + dz;
      if (x < 0 || x >= Nx || z < 0 || z >= Nz) return true;
      if (y < 0) return true;
      if (this.stack[this.idx(x, y, z)]) return true;
    }
    return false;
  }

  // Lowest y the current piece can occupy from its current x/z — used to draw
  // the landing ghost.
  ghostY() {
    let gy = this.piece.y;
    while (gy > 0 && !this.collides(this.piece.x, gy - 1, this.piece.z)) gy--;
    return gy;
  }

  lock() {
    const [cr, cg, cb] = this.piece.color;
    for (const [dx, dy, dz] of this.piece.blocks) {
      const x = this.piece.x + dx, y = this.piece.y + dy, z = this.piece.z + dz;
      const idx = this.idx(x, y, z);
      this.stack[idx] = 1;
      this.color[idx * 3 + 0] = cr;
      this.color[idx * 3 + 1] = cg;
      this.color[idx * 3 + 2] = cb;
    }
    this.queueLayerClears();
  }

  queueLayerClears() {
    const { Nx, Ny, Nz } = this;
    for (let y = 0; y < Ny; y++) {
      let full = true;
      for (let x = 0; x < Nx && full; x++) {
        for (let z = 0; z < Nz && full; z++) {
          if (!this.stack[this.idx(x, y, z)]) full = false;
        }
      }
      // Skip if already flashing this layer.
      if (full) {
        let already = false;
        for (const f of this.flashLayers) if (f.y === y) { already = true; break; }
        if (!already) this.flashLayers.push({ y, remaining: 1 });
      }
    }
  }

  collapseLayer(y) {
    const { Nx, Ny, Nz } = this;
    // Shift every cell above y down by one, then zero the top layer.
    for (let yy = y; yy < Ny - 1; yy++) {
      for (let x = 0; x < Nx; x++) {
        for (let z = 0; z < Nz; z++) {
          const src = this.idx(x, yy + 1, z);
          const dst = this.idx(x, yy, z);
          this.stack[dst] = this.stack[src];
          this.color[dst * 3 + 0] = this.color[src * 3 + 0];
          this.color[dst * 3 + 1] = this.color[src * 3 + 1];
          this.color[dst * 3 + 2] = this.color[src * 3 + 2];
        }
      }
    }
    for (let x = 0; x < Nx; x++) {
      for (let z = 0; z < Nz; z++) {
        const idx = this.idx(x, Ny - 1, z);
        this.stack[idx] = 0;
        this.color[idx * 3 + 0] = 0;
        this.color[idx * 3 + 1] = 0;
        this.color[idx * 3 + 2] = 0;
      }
    }
    // Kick a volume-wide bloom wash so the clear lands hard.
    this.clearPulse = 1;
  }

  resetGame() {
    this.stack.fill(0);
    this.color.fill(0);
    this.flashLayers = [];
    this.clearPulse = 1; // celebratory wash on reset
    this.seedRubble();
    this.spawnPiece(true);
    this.pauseT = 0.12;
  }

  update(ctx) {
    const { dt, Nx, Ny, Nz, params } = ctx;
    if (this.Nx !== Nx || this.Ny !== Ny || this.Nz !== Nz) this.setup(ctx);

    // Decay the volume-wide clear pulse.
    if (this.clearPulse > 0) {
      this.clearPulse -= dt * 3.2;
      if (this.clearPulse < 0) this.clearPulse = 0;
    }

    // Resolve layer-clear flashes: each ticks down in normalized time
    // (1.0 → 0.0 over clearFlash seconds), then the layer collapses and any
    // still-pending flashes above it slide down by one.
    const flashDur = Math.max(0.001, params.clearFlash);
    for (let i = this.flashLayers.length - 1; i >= 0; i--) {
      this.flashLayers[i].remaining -= dt / flashDur;
      if (this.flashLayers[i].remaining <= 0) {
        const y = this.flashLayers[i].y;
        this.collapseLayer(y);
        this.flashLayers.splice(i, 1);
        for (const f of this.flashLayers) if (f.y > y) f.y -= 1;
      }
    }

    if (this.pauseT > 0) { this.pauseT -= dt; return; }
    if (!this.piece) { this.spawnPiece(false); this.pauseT = params.spawnDelay; return; }

    this.dropAcc += params.dropRate * dt;
    // Cap catch-up so a long dt (tab refocus) can't burn many steps at once.
    let steps = 0;
    while (this.dropAcc >= 1 && steps < 64) {
      this.dropAcc -= 1;
      steps++;
      if (this.collides(this.piece.x, this.piece.y - 1, this.piece.z)) {
        // If the freshly-spawned piece already collides at its spawn Y, the
        // stack has reached the top — reset.
        if (this.collides(this.piece.x, this.piece.y, this.piece.z)) {
          this.resetGame();
          return;
        }
        this.lock();
        this.piece = null;
        this.pauseT = params.spawnDelay;
        return;
      }
      this.piece.y -= 1;
    }
  }

  render(ctx, out) {
    const { t, Nx, Ny, Nz, params, utils } = ctx;
    out.fill(0);

    const sb = params.stackBright;
    const glow = params.glow;
    const invNy = Ny > 1 ? 1 / (Ny - 1) : 0;

    // ---- Locked stack: keep each block's origin hue but breathe a slow
    // vertical shimmer so the structure stays alive instead of static. ----
    for (let x = 0; x < Nx; x++) {
      for (let y = 0; y < Ny; y++) {
        for (let z = 0; z < Nz; z++) {
          const idx = this.idx(x, y, z);
          if (!this.stack[idx]) continue;
          // Shimmer: gentle 0.78..1.0 multiplier travelling up the cube,
          // built from two coprime-rate sines for organic, non-repeating life.
          const phase = y * invNy * 3.3 - t * 1.7;
          const sh = 0.89 + 0.11 * Math.sin(phase) + 0.0; // ~0.78..1.0
          const m = sb * (0.86 + 0.14 * (0.5 + 0.5 * Math.sin(phase + 1.7)));
          const r = this.color[idx * 3 + 0] * m * sh;
          const g = this.color[idx * 3 + 1] * m * sh;
          const b = this.color[idx * 3 + 2] * m * sh;
          this.addVoxel(out, idx, r, g, b);
        }
      }
    }

    // ---- Landing ghost: a dim, pulsing footprint where the piece will come
    // to rest. A strong depth cue — the eye tracks the piece down. ----
    if (this.piece && params.showGhost) {
      const gy = this.ghostY();
      if (gy < this.piece.y) {
        const [cr, cg, cb] = this.piece.color;
        const gpulse = 0.16 + 0.10 * (0.5 + 0.5 * Math.sin(t * 6.0));
        for (const [dx, dy, dz] of this.piece.blocks) {
          const x = this.piece.x + dx, y = gy + dy, z = this.piece.z + dz;
          if (x < 0 || x >= Nx || y < 0 || y >= Ny || z < 0 || z >= Nz) continue;
          const idx = this.idx(x, y, z);
          this.addVoxel(out, idx, cr * gpulse, cg * gpulse, cb * gpulse);
        }
      }
    }

    // ---- Active piece: bright saturated core with an additive bloom that
    // bleeds into face-neighbors, so it glows through the volume. ----
    if (this.piece) {
      const [cr, cg, cb] = this.piece.color;
      // Subtle brightness pulse so the falling piece feels energetic.
      const pb = params.pieceBright * (0.93 + 0.07 * Math.sin(t * 9.0));
      for (const [dx, dy, dz] of this.piece.blocks) {
        const x = this.piece.x + dx, y = this.piece.y + dy, z = this.piece.z + dz;
        if (x < 0 || x >= Nx || y < 0 || y >= Ny || z < 0 || z >= Nz) continue;
        const idx = this.idx(x, y, z);
        // Bright core (overwrite, not add — it's the hero).
        out[idx * 3 + 0] = Math.min(255, cr * pb);
        out[idx * 3 + 1] = Math.min(255, cg * pb);
        out[idx * 3 + 2] = Math.min(255, cb * pb);
        // Bloom into the six face neighbors.
        if (glow > 0) {
          const bf = glow * 0.45;
          this.bloom(out, x + 1, y, z, cr, cg, cb, bf);
          this.bloom(out, x - 1, y, z, cr, cg, cb, bf);
          this.bloom(out, x, y + 1, z, cr, cg, cb, bf);
          this.bloom(out, x, y - 1, z, cr, cg, cb, bf);
          this.bloom(out, x, y, z + 1, cr, cg, cb, bf);
          this.bloom(out, x, y, z - 1, cr, cg, cb, bf);
        }
      }
    }

    // ---- Layer-clear flash: full XZ slice goes white-hot, fading toward the
    // collapse moment, with bloom spilling onto the layers above/below. ----
    for (const f of this.flashLayers) {
      const k = Math.max(0, Math.min(1, f.remaining));
      // Ease so it stays bright then snaps off — punchy, not a slow fade.
      const e = k * k;
      const v = 90 + 165 * e;
      for (let x = 0; x < Nx; x++) {
        for (let z = 0; z < Nz; z++) {
          const idx = this.idx(x, f.y, z);
          out[idx * 3 + 0] = v;
          out[idx * 3 + 1] = v;
          out[idx * 3 + 2] = v;
          // White bloom onto adjacent layers.
          if (glow > 0) {
            const bv = v * glow * 0.5;
            if (f.y + 1 < Ny) this.bloom(out, x, f.y + 1, z, 255, 255, 255, bv / 255);
            if (f.y - 1 >= 0)  this.bloom(out, x, f.y - 1, z, 255, 255, 255, bv / 255);
          }
        }
      }
    }

    // ---- Volume-wide bloom wash kicked by a completed clear. A quick warm
    // pulse over the whole stack so a clear reads from across the room. ----
    if (this.clearPulse > 0) {
      const total = Nx * Ny * Nz;
      const add = 70 * this.clearPulse;
      for (let i = 0; i < total; i++) {
        out[i * 3 + 0] = Math.min(255, out[i * 3 + 0] + add);
        out[i * 3 + 1] = Math.min(255, out[i * 3 + 1] + add * 0.96);
        out[i * 3 + 2] = Math.min(255, out[i * 3 + 2] + add * 0.85);
      }
    }
  }

  // Additive write with clamp — used for stack + ghost so overlapping blooms
  // accumulate rather than stomping each other.
  addVoxel(out, idx, r, g, b) {
    out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r);
    out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g);
    out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b);
  }

  // Add a fraction of a color into a neighbor voxel (bounds-checked).
  bloom(out, x, y, z, r, g, b, f) {
    if (x < 0 || x >= this.Nx || y < 0 || y >= this.Ny || z < 0 || z >= this.Nz) return;
    const idx = this.idx(x, y, z);
    out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r * f);
    out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g * f);
    out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b * f);
  }
}
