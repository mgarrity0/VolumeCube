// Tetris 3D — auto-playing volumetric Tetris simulator.
//
// Pieces (tetracubes — four connected unit cubes) fall from Y=N-1 toward
// Y=0 in discrete steps. When a piece can't fall further, it locks into
// the stack. Any fully-filled XZ slice is flashed white for a beat then
// collapsed, with the layers above dropping down by one — the 3D
// equivalent of Tetris line-clear. If the stack reaches the top, the
// cube resets.
//
// This is a *simulator*, not a playable game: piece placement is random
// so the stack grows naturally, clears happen organically, and you can
// just watch it run. Piece colors are baked into the stack when locked
// so each layer retains its rainbow origin.

// Tetracubes: each entry is [color, [rotations]] where each rotation is
// a list of [dx, dy, dz] offsets from the piece origin. We hard-code a
// few rotations per piece rather than computing the full rotation group
// — visual variety is the goal, not combinatorial completeness.
const PIECES = [
  { // I — long bar
    color: [100, 200, 255],
    rots: [
      [[0,0,0],[1,0,0],[2,0,0],[3,0,0]],
      [[0,0,0],[0,0,1],[0,0,2],[0,0,3]],
      [[0,0,0],[0,1,0],[0,2,0],[0,3,0]],
    ],
  },
  { // O — 2x2 square
    color: [255, 230, 80],
    rots: [
      [[0,0,0],[1,0,0],[0,0,1],[1,0,1]],
      [[0,0,0],[0,1,0],[1,0,0],[1,1,0]],
    ],
  },
  { // T — flat T
    color: [200, 100, 255],
    rots: [
      [[0,0,0],[1,0,0],[2,0,0],[1,0,1]],
      [[0,0,0],[0,0,1],[0,0,2],[1,0,1]],
      [[0,0,0],[1,0,0],[2,0,0],[1,1,0]],
    ],
  },
  { // L — L-shape
    color: [255, 150, 50],
    rots: [
      [[0,0,0],[1,0,0],[2,0,0],[0,0,1]],
      [[0,0,0],[0,0,1],[0,0,2],[1,0,0]],
      [[0,0,0],[0,1,0],[0,2,0],[1,0,0]],
    ],
  },
  { // S — skew
    color: [80, 220, 120],
    rots: [
      [[0,0,0],[1,0,0],[1,0,1],[2,0,1]],
      [[0,0,1],[0,0,0],[1,1,0],[1,1,1]],
    ],
  },
  { // Tripod — 3D-only: three arms from a corner cube
    color: [255, 100, 160],
    rots: [
      [[0,0,0],[1,0,0],[0,1,0],[0,0,1]],
      [[0,0,0],[1,0,0],[0,0,1],[1,1,0]],
      [[0,0,0],[0,1,0],[0,0,1],[1,1,1]],
    ],
  },
];

export const params = {
  dropRate:    { type: 'range', min: 1,   max: 30, step: 0.5, default: 6,   label: 'Drop steps / sec' },
  spawnDelay:  { type: 'range', min: 0,   max: 1,  step: 0.02, default: 0.15, label: 'Pause before new piece' },
  clearFlash:  { type: 'range', min: 0,   max: 0.5, step: 0.01, default: 0.18, label: 'Layer-clear flash (s)' },
  pieceBright: { type: 'range', min: 0.7, max: 1.5, step: 0.05, default: 1.1, label: 'Active piece brightness' },
  stackBright: { type: 'range', min: 0.3, max: 1,   step: 0.05, default: 0.75, label: 'Stack brightness' },
};

export default class Tetris3D {
  static name = 'Tetris 3D (Auto-play)';

  setup(ctx) {
    this.N = ctx.N;
    this.stack = new Uint8Array(ctx.N ** 3);
    this.color = new Uint8Array(ctx.N ** 3 * 3);
    this.flashLayers = [];
    this.dropAcc = 0;
    this.pauseT = 0;
    this.spawnPiece();
  }

  spawnPiece() {
    const N = this.N;
    const piece = PIECES[(Math.random() * PIECES.length) | 0];
    const rot = piece.rots[(Math.random() * piece.rots.length) | 0];
    // Shift origin so the piece fits inside the X/Z bounds at any random (x, z).
    let maxX = 0, maxZ = 0;
    for (const [dx, , dz] of rot) { if (dx > maxX) maxX = dx; if (dz > maxZ) maxZ = dz; }
    this.piece = {
      blocks: rot,
      color: piece.color,
      x: Math.floor(Math.random() * (N - maxX)),
      y: N - 1,
      z: Math.floor(Math.random() * (N - maxZ)),
    };
  }

  collides(px, py, pz) {
    const N = this.N;
    for (const [dx, dy, dz] of this.piece.blocks) {
      const x = px + dx, y = py + dy, z = pz + dz;
      if (x < 0 || x >= N || z < 0 || z >= N) return true;
      if (y < 0) return true;
      if (this.stack[(x * N + y) * N + z]) return true;
    }
    return false;
  }

  lock() {
    const N = this.N;
    const [cr, cg, cb] = this.piece.color;
    for (const [dx, dy, dz] of this.piece.blocks) {
      const x = this.piece.x + dx, y = this.piece.y + dy, z = this.piece.z + dz;
      const idx = (x * N + y) * N + z;
      this.stack[idx] = 1;
      this.color[idx * 3 + 0] = cr;
      this.color[idx * 3 + 1] = cg;
      this.color[idx * 3 + 2] = cb;
    }
    this.queueLayerClears();
  }

  queueLayerClears() {
    const N = this.N;
    for (let y = 0; y < N; y++) {
      let full = true;
      for (let x = 0; x < N && full; x++) {
        for (let z = 0; z < N && full; z++) {
          if (!this.stack[(x * N + y) * N + z]) full = false;
        }
      }
      if (full) this.flashLayers.push({ y, remaining: 1 });
    }
  }

  collapseLayer(y) {
    const N = this.N;
    // Shift every cell above y down by one, then zero the top layer.
    for (let yy = y; yy < N - 1; yy++) {
      for (let x = 0; x < N; x++) {
        for (let z = 0; z < N; z++) {
          const src = (x * N + (yy + 1)) * N + z;
          const dst = (x * N + yy) * N + z;
          this.stack[dst] = this.stack[src];
          this.color[dst * 3 + 0] = this.color[src * 3 + 0];
          this.color[dst * 3 + 1] = this.color[src * 3 + 1];
          this.color[dst * 3 + 2] = this.color[src * 3 + 2];
        }
      }
    }
    for (let x = 0; x < N; x++) {
      for (let z = 0; z < N; z++) {
        const idx = (x * N + (N - 1)) * N + z;
        this.stack[idx] = 0;
        this.color[idx * 3 + 0] = 0;
        this.color[idx * 3 + 1] = 0;
        this.color[idx * 3 + 2] = 0;
      }
    }
  }

  resetGame() {
    this.stack.fill(0);
    this.color.fill(0);
    this.flashLayers = [];
    this.spawnPiece();
    this.pauseT = 0.2;
  }

  update(ctx) {
    const { dt, N, params } = ctx;
    if (this.N !== N) this.setup(ctx);

    // Resolve layer-clear flashes: each flash ticks down in normalized time
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
    if (!this.piece) { this.spawnPiece(); this.pauseT = params.spawnDelay; return; }

    this.dropAcc += params.dropRate * dt;
    while (this.dropAcc >= 1) {
      this.dropAcc -= 1;
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
    const { N, params } = ctx;
    out.fill(0);
    const total = N * N * N;

    const sb = params.stackBright;
    for (let i = 0; i < total; i++) {
      if (this.stack[i]) {
        out[i * 3 + 0] = this.color[i * 3 + 0] * sb;
        out[i * 3 + 1] = this.color[i * 3 + 1] * sb;
        out[i * 3 + 2] = this.color[i * 3 + 2] * sb;
      }
    }

    // Flash full XZ slice white; flash fades toward the collapse moment.
    for (const f of this.flashLayers) {
      const k = Math.max(0, f.remaining);
      const v = 200 + 55 * k;
      for (let x = 0; x < N; x++) {
        for (let z = 0; z < N; z++) {
          const idx = (x * N + f.y) * N + z;
          out[idx * 3 + 0] = v;
          out[idx * 3 + 1] = v;
          out[idx * 3 + 2] = v;
        }
      }
    }

    if (this.piece) {
      const [cr, cg, cb] = this.piece.color;
      const pb = params.pieceBright;
      for (const [dx, dy, dz] of this.piece.blocks) {
        const x = this.piece.x + dx, y = this.piece.y + dy, z = this.piece.z + dz;
        if (x < 0 || x >= N || y < 0 || y >= N || z < 0 || z >= N) continue;
        const idx = (x * N + y) * N + z;
        out[idx * 3 + 0] = Math.min(255, cr * pb);
        out[idx * 3 + 1] = Math.min(255, cg * pb);
        out[idx * 3 + 2] = Math.min(255, cb * pb);
      }
    }
  }
}
