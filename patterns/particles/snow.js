// Snow — drifting, shimmering flakes with volumetric depth.
//
// Flakes fall slowly with a noise-driven horizontal wander and a gentle
// per-flake sway. Each flake is a soft glowing splat whose SIZE and
// BRIGHTNESS scale with depth — flakes near the front face (z=0) read
// bigger and brighter, distant ones fade into the dark for a true sense
// of volume. Flakes twinkle as they tumble (catching the light), carry a
// faint cool-to-warm tint over their fall, and settle into a soft drift
// of accumulation glow that builds along the floor and slowly melts.

export const params = {
  density:    { type: 'range', min: 0.05, max: 1.5, step: 0.01, default: 0.7, label: 'Density' },
  speed:      { type: 'range', min: 0.1,  max: 5,   step: 0.05, default: 1.0, label: 'Fall Speed' },
  sway:       { type: 'range', min: 0,    max: 1.5, step: 0.01, default: 0.45, label: 'Sway' },
  shimmer:    { type: 'range', min: 0,    max: 1,   step: 0.01, default: 0.7, label: 'Shimmer' },
  glowSize:   { type: 'range', min: 0.4,  max: 1.6, step: 0.01, default: 0.85, label: 'Flake Glow' },
  tint:       { type: 'color', default: '#dff0ff', label: 'Flake Tint' },
  accumGlow:  { type: 'toggle', default: true, label: 'Accumulation' },
};

export default class Snow {
  static name = 'Snow';

  setup(ctx) {
    const { Nx, Ny, Nz, params } = ctx;
    const target = this._target(Nx, Nz, params.density);
    this.flakes = [];
    for (let i = 0; i < target; i++) {
      const f = this.newFlake(Nx, Ny, Nz);
      f.y = Math.random() * (Ny + 2); // pre-fill the volume on first frame
      this.flakes.push(f);
    }
    this.t = 0;
    // Per-column accumulation buffer (floor drift), one value per (x,z).
    this.accum = new Float32Array(Nx * Math.max(1, Nz));
  }

  _target(Nx, Nz, density) {
    return Math.max(1, Math.round(Nx * Math.max(1, Nz) * density));
  }

  newFlake(Nx, Ny, Nz, y) {
    if (y === undefined) y = Ny + 0.5 + Math.random() * Ny;
    return {
      x: Math.random() * Math.max(1e-3, Nx - 1),
      z: Math.random() * Math.max(1e-3, Nz - 1),
      y,
      phase: Math.random() * Math.PI * 2,    // sway phase
      tphase: Math.random() * Math.PI * 2,   // twinkle phase
      wobble: 0.55 + Math.random() * 0.9,    // fall-speed variation
      twrate: 2.5 + Math.random() * 4.5,     // twinkle rate (coprime-ish)
      seed: Math.random() * 100,             // noise offset
      hueShift: Math.random(),               // small per-flake warmth bias
    };
  }

  update(ctx) {
    const { dt, params, Nx, Ny, Nz } = ctx;
    const d = Math.min(dt, 0.1); // clamp big frame gaps so flakes don't teleport
    this.t += d;

    // Reallocate accumulation buffer if the rig size changed.
    const cells = Nx * Math.max(1, Nz);
    if (!this.accum || this.accum.length !== cells) this.accum = new Float32Array(cells);

    const target = this._target(Nx, Nz, params.density);
    while (this.flakes.length < target) this.flakes.push(this.newFlake(Nx, Ny, Nz));
    while (this.flakes.length > target) this.flakes.pop();

    const Nzc = Math.max(1, Nz);
    for (const f of this.flakes) {
      const prevY = f.y;
      f.y -= params.speed * d * f.wobble;
      f.tphase += f.twrate * d;

      // When a flake reaches the floor, deposit a touch of accumulation glow
      // into its landing column, then respawn it up top.
      if (f.y < -0.5) {
        if (params.accumGlow && prevY >= -0.5) {
          const cx = Math.min(Nx - 1, Math.max(0, Math.round(f.x)));
          const cz = Math.min(Nzc - 1, Math.max(0, Math.round(f.z)));
          const ci = cx * Nzc + cz;
          this.accum[ci] = Math.min(1.2, this.accum[ci] + 0.5);
        }
        const nf = this.newFlake(Nx, Ny, Nz);
        f.x = nf.x; f.z = nf.z; f.y = nf.y;
        f.phase = nf.phase; f.tphase = nf.tphase;
        f.wobble = nf.wobble; f.twrate = nf.twrate;
        f.seed = nf.seed; f.hueShift = nf.hueShift;
      }
    }

    // Accumulation slowly melts/sublimates away.
    if (params.accumGlow) {
      const decay = Math.exp(-d * 0.45);
      for (let i = 0; i < this.accum.length; i++) this.accum[i] *= decay;
    }
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, params, utils, audio } = ctx;
    out.fill(0);
    const Nzc = Math.max(1, Nz);
    const [tr, tg, tb] = utils.parseColor(params.tint);

    // Audio nudges the whole storm a touch brighter on energy; harmless at 0.
    const energy = audio ? audio.energy : 0;
    const globalGain = 1 + energy * 0.25;

    // ---- Accumulation drift along the floor (soft cool glow that breathes) ----
    if (params.accumGlow) {
      for (let x = 0; x < Nx; x++) {
        for (let z = 0; z < Nzc; z++) {
          const a = this.accum[x * Nzc + z];
          if (a <= 0.001) continue;
          // Front columns (small z) catch a hair more glow for depth.
          const depth = Nzc > 1 ? 1 - z / (Nzc - 1) : 1;
          const breathe = 0.85 + 0.15 * Math.sin(this.t * 1.3 + x * 0.7 + z * 0.9);
          const amt = utils.clamp(a, 0, 1) * (0.35 + 0.25 * depth) * breathe * globalGain;
          // Cool blue-white settled snow.
          const r = tr * 0.55 * amt;
          const g = tg * 0.75 * amt;
          const b = Math.min(255, (tb * 0.95 + 30) * amt);
          const idx = (x * Ny + 0) * Nz + z;
          out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r);
          out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g);
          out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b);
        }
      }
    }

    // ---- Falling flakes: glowing depth-graded splats ----
    const radius = params.glowSize;            // glow radius in voxels
    const r2 = radius * radius;
    const ir = Math.ceil(radius);              // integer reach of the splat
    const invR2 = 1 / Math.max(1e-3, r2);

    for (const f of this.flakes) {
      // Organic drift: sway sine + slow 3D noise wander (coprime-ish rates).
      const swayX = Math.sin(this.t * 0.8 + f.phase) * params.sway;
      const noiseX = utils.noise3d(f.seed, f.y * 0.18, this.t * 0.25) * params.sway * 0.8;
      const swayZ = Math.cos(this.t * 0.55 + f.phase * 1.3) * params.sway * 0.7;
      const noiseZ = utils.noise3d(f.seed + 40, f.y * 0.18, this.t * 0.2) * params.sway * 0.6;

      const xF = f.x + swayX + noiseX;
      const yF = f.y;
      const zF = f.z + swayZ + noiseZ;

      // Depth cue: nearer the FRONT face (z small) => brighter & bigger.
      const depth = Nzc > 1 ? 1 - utils.clamp(zF, 0, Nzc - 1) / (Nzc - 1) : 1;
      const depthBright = 0.45 + 0.55 * depth;       // 0.45 (back) .. 1.0 (front)
      const sizeScale = 0.7 + 0.5 * depth;           // front flakes splat wider
      const effR2 = r2 * sizeScale * sizeScale;
      const invEffR2 = 1 / Math.max(1e-3, effR2);
      const effIR = Math.max(1, Math.ceil(radius * sizeScale));

      // Twinkle: flakes catch the light as they tumble.
      const tw = 0.5 + 0.5 * Math.sin(f.tphase);
      const twinkle = 1 - params.shimmer * (1 - tw * tw);

      // Fade in as a flake enters from above; never harsh at spawn.
      const entry = utils.smoothstep(Ny + 1.5, Ny - 1.5, yF);
      const core = depthBright * twinkle * entry * globalGain;
      if (core <= 0.002) continue;

      // Gentle cool->warm tint shift over the fall + tiny per-flake warmth.
      const warm = utils.clamp(0.12 + f.hueShift * 0.18 + (1 - yF / Math.max(1, Ny)) * 0.18, 0, 0.55);
      const cr = tr;
      const cg = utils.clamp(tg - warm * 25, 0, 255);
      const cb = utils.clamp(tb - warm * 70, 0, 255);

      // Soft spherical splat with smooth falloff (bright core, dark edge).
      const x0 = Math.round(xF), y0 = Math.round(yF), z0 = Math.round(zF);
      for (let dx = -effIR; dx <= effIR; dx++) {
        const x = x0 + dx;
        if (x < 0 || x >= Nx) continue;
        const ddx = x - xF;
        for (let dy = -effIR; dy <= effIR; dy++) {
          const y = y0 + dy;
          if (y < 0 || y >= Ny) continue;
          const ddy = y - yF;
          for (let dz = -effIR; dz <= effIR; dz++) {
            const z = z0 + dz;
            if (z < 0 || z >= Nz) continue;
            const ddz = z - zF;
            const dist2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (dist2 > effR2) continue;
            // Smooth falloff: 1 at center -> 0 at edge, squared for a tight core.
            let fall = 1 - dist2 * invEffR2;
            fall = fall * fall;
            const w = fall * core;
            if (w <= 0.002) continue;
            const idx = (x * Ny + y) * Nz + z;
            out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + cr * w);
            out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + cg * w);
            out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + cb * w);
          }
        }
      }
    }
  }
}
