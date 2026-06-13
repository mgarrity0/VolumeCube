// Starfield Warp — flying through space at light speed.
//
// Stars stream out of the far +Z distance toward the camera (the z=0 face)
// and rush past it. Each star is a sub-voxel particle splatted with a
// motion-blur streak that points back into depth; the streak lengthens with
// the star's apparent speed so high "warp" smears them into hyperspace
// light-lines. Depth is read three ways at once: near stars are large,
// bright, and long-streaked; far stars are tiny, dim, and point-like — so the
// cube reads as genuine forward motion through a 3D field rather than dots
// sliding on a plane. Mostly cool blue-white, with the occasional warm or
// jewel-toned star for sparkle. A recycled particle pool keeps a constant
// star count: when a star passes the camera (or drifts out the side) it is
// re-seeded far away.

export const params = {
  warp:      { type: 'range', min: 0,    max: 1,   step: 0.01, default: 0.45, label: 'Warp' },
  speed:     { type: 'range', min: 0.1,  max: 6,   step: 0.05, default: 2.2,  label: 'Speed' },
  density:   { type: 'range', min: 0.2,  max: 3,   step: 0.05, default: 1.3,  label: 'Density' },
  spread:    { type: 'range', min: 0.4,  max: 1.6, step: 0.01, default: 1.0,  label: 'Field Spread' },
  brightness:{ type: 'range', min: 0.2,  max: 2,   step: 0.01, default: 1.0,  label: 'Brightness' },
  colorPop:  { type: 'range', min: 0,    max: 1,   step: 0.01, default: 0.18, label: 'Color Pop' },
  tint:      { type: 'color', default: '#bcd4ff', label: 'Star Tint' },
};

export default class StarfieldWarp {
  static name = 'Starfield Warp';

  setup(ctx) {
    const { Nx, Ny, Nz, params } = ctx;
    // Far plane: where stars spawn. For a flat panel (Nz=1) we still give
    // stars synthetic depth so size/brightness perspective keeps working.
    this.zFar = Math.max(3, Nz) * 1.6;
    this.stars = [];
    const target = this._targetCount(ctx);
    for (let i = 0; i < target; i++) {
      // On first fill, scatter across the full depth range so the field is
      // already populated rather than a wall of stars rushing in at once.
      this.stars.push(this._spawn(Nx, Ny, Nz, params, Math.random()));
    }
  }

  _targetCount(ctx) {
    const { Nx, Ny, Nz, params } = ctx;
    // Scale star count with the cross-section so larger cubes stay dense
    // but small/flat panels don't choke. ~0.42 stars per face-voxel at d=1 —
    // kept moderate so the field reads as discrete sparks against dark space
    // rather than a fog of overlapping streaks.
    const cross = Math.max(4, Nx * Ny);
    return Math.max(6, Math.round(cross * 0.42 * params.density));
  }

  // Re-seed a star far away with a random transverse position. `depthFrac`
  // (0..1) lets the initial fill spread stars through the whole tunnel.
  _spawn(Nx, Ny, Nz, params, depthFrac) {
    const spread = params.spread;
    // Transverse position centered on the screen, in voxel units, allowed to
    // start a bit outside the frame so streaks can sweep in from the edges.
    const halfX = (Nx - 1) * 0.5;
    const halfY = (Ny - 1) * 0.5;
    const ang = Math.random() * Math.PI * 2;
    const rad = Math.sqrt(Math.random()); // uniform-ish over the disc
    const x = halfX + Math.cos(ang) * rad * (halfX + 1) * spread * 1.15;
    const y = halfY + Math.sin(ang) * rad * (halfY + 1) * spread * 1.15;
    const z = depthFrac !== undefined ? depthFrac * this.zFar : this.zFar;

    // Color: mostly cool blue-white near the tint, occasionally a colored gem.
    let hue, sat;
    if (Math.random() < params.colorPop) {
      // Warm ambers, rose, cyan, soft green — picked from a few pleasing bands.
      const bands = [0.06, 0.92, 0.5, 0.33, 0.13];
      hue = bands[(Math.random() * bands.length) | 0] + (Math.random() - 0.5) * 0.04;
      sat = 0.55 + Math.random() * 0.35;
    } else {
      hue = -1; // sentinel: use the tint color instead of an HSV hue
      sat = 0;
    }

    return {
      x, y, z,
      // Per-star transverse drift so stars curve slightly off straight-in,
      // giving the field a touch of organic parallax (kept tiny).
      dx: (Math.random() - 0.5) * 0.25,
      dy: (Math.random() - 0.5) * 0.25,
      vz: 0.75 + Math.random() * 0.5, // depth-speed multiplier (variety)
      hue,
      sat,
      twPhase: Math.random() * Math.PI * 2,
      twRate: 4 + Math.random() * 6,
    };
  }

  update(ctx) {
    const { dt, params, Nx, Ny, Nz } = ctx;
    this.zFar = Math.max(3, Nz) * 1.6;

    // Maintain pool size against the (possibly changed) target.
    const target = this._targetCount(ctx);
    while (this.stars.length < target) this.stars.push(this._spawn(Nx, Ny, Nz, params));
    while (this.stars.length > target) this.stars.pop();

    // Base depth-speed in voxels/sec. Warp pushes the whole field faster.
    const warp = params.warp;
    const baseSpeed = params.speed * (1 + warp * warp * 5.5);

    const halfX = (Nx - 1) * 0.5;
    const halfY = (Ny - 1) * 0.5;
    const margin = Math.max(Nx, Ny) * 0.6 + 2;

    for (let i = 0; i < this.stars.length; i++) {
      const s = this.stars[i];
      const step = baseSpeed * s.vz * dt;
      s.z -= step;
      // Transverse drift accelerates a touch with warp, so close stars sweep
      // past the edges — a strong forward-motion cue.
      s.x += s.dx * dt * (1 + warp);
      s.y += s.dy * dt * (1 + warp);

      // Recycle when the star has passed the camera or drifted far off frame.
      const offFrame =
        s.x < halfX - (halfX + margin) || s.x > halfX + (halfX + margin) ||
        s.y < halfY - (halfY + margin) || s.y > halfY + (halfY + margin);
      if (s.z <= -1.0 || offFrame) {
        this.stars[i] = this._spawn(Nx, Ny, Nz, params);
      }
    }
  }

  render(ctx, out) {
    const { Nx, Ny, Nz, t, params, utils } = ctx;
    out.fill(0);

    const tint = utils.parseColor(params.tint);
    const warp = params.warp;
    const bright = params.brightness;
    const zFar = this.zFar;

    // Perspective focal length: governs how fast near stars grow. Tied to the
    // cube size so it self-scales. Streak length grows with both proximity and
    // warp so hyperspace lines reach across the depth of the cube.
    const focal = Math.max(2, Nz) * 1.1 + 1;
    const maxStreak = (Math.max(3, Nz)) * (0.45 + warp * warp * 3.0);

    for (const s of this.stars) {
      // Depth factor: 1 at the camera (z=0), ->0 at the far plane.
      const zClamped = s.z < 0 ? 0 : s.z;
      const depth = utils.clamp(1 - zClamped / zFar, 0, 1);
      // Perspective proximity (>1 near camera). Drives size + brightness.
      const prox = focal / (focal + zClamped);

      // Brightness: near stars blaze, far ones are faint embers. Square the
      // proximity for punchy high-dynamic-range cores against dark space.
      const twinkle = 0.82 + 0.18 * Math.sin(t * s.twRate + s.twPhase);
      let intensity = prox * prox * (0.35 + depth * 0.65) * twinkle * bright;
      // A gentle fade-in as a star emerges from the far plane and a quick
      // brighten-then-vanish as it whips past the camera.
      intensity *= utils.smoothstep(0, 0.12, depth);
      if (intensity <= 0.002) continue;

      // Base star color.
      let cr, cg, cb;
      if (s.hue < 0) {
        cr = tint[0]; cg = tint[1]; cb = tint[2];
      } else {
        const c = utils.hsv(s.hue, s.sat, 1);
        cr = c[0]; cg = c[1]; cb = c[2];
      }
      // Hot cores read whiter; lift toward white with proximity for that
      // blue-white-going-incandescent look as stars approach.
      const whiten = utils.clamp(prox * 0.55 + warp * 0.25, 0, 0.8);
      cr = cr + (255 - cr) * whiten;
      cg = cg + (255 - cg) * whiten;
      cb = cb + (255 - cb) * whiten;

      const I = intensity * 255;
      const r = cr / 255, g = cg / 255, b = cb / 255;

      // Motion-blur streak: a line of samples from the star's position back
      // into +Z (where it came from). Length grows with proximity & warp.
      const streakLen = maxStreak * (0.25 + prox * 1.4);
      // Number of samples along the streak — enough to look continuous but
      // bounded so it stays O(stars) cheap.
      const samples = Math.max(1, Math.min(14, Math.round(streakLen * 1.6) + 1));

      // The streak recedes in depth and, due to perspective, also converges
      // toward the screen center as it goes back — that convergence is the
      // signature hyperspace radial smear.
      const cxScreen = (Nx - 1) * 0.5;
      const cyScreen = (Ny - 1) * 0.5;

      for (let k = 0; k < samples; k++) {
        const f = samples === 1 ? 0 : k / (samples - 1); // 0=head .. 1=tail
        // Tail dims and the very head gets a slight boost (bright leading dot).
        const along = (1 - f);
        const headBoost = k === 0 ? 1.35 : 1.0;
        // Cubic falloff: a crisp bright head that decays fast into a thin tail
        // — preserves dark space between stars instead of a uniform smear.
        const w = along * along * along * headBoost;

        // Sample depth steps back behind the star.
        const zk = zClamped + f * streakLen;
        const proxK = focal / (focal + zk);
        // Perspective: transverse position scales toward center as depth grows.
        const persp = proxK / (prox || 1);
        const px = cxScreen + (s.x - cxScreen) * persp;
        const py = cyScreen + (s.y - cyScreen) * persp;
        // Map depth to a z voxel slice (near=0 .. far=Nz-1). Guard Nz=1.
        const pz = Nz <= 1 ? 0 : utils.clamp((zk / zFar) * (Nz - 1), 0, Nz - 1);

        const amp = I * w;
        if (amp <= 3) continue; // cull faint samples to keep space dark
        this._splat(out, Nx, Ny, Nz, px, py, pz, r * amp, g * amp, b * amp);
      }
    }
  }

  // Trilinear additive deposit into the 8 surrounding voxels.
  _splat(out, Nx, Ny, Nz, x, y, z, r, g, b) {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const fx = x - x0, fy = y - y0, fz = z - z0;
    for (let dz = 0; dz <= 1; dz++) {
      const zz = z0 + dz;
      if (zz < 0 || zz >= Nz) continue;
      const wz = dz ? fz : 1 - fz;
      if (wz <= 0) continue;
      for (let dy = 0; dy <= 1; dy++) {
        const yy = y0 + dy;
        if (yy < 0 || yy >= Ny) continue;
        const wy = dy ? fy : 1 - fy;
        if (wy <= 0) continue;
        const wyz = wy * wz;
        for (let dx = 0; dx <= 1; dx++) {
          const xx = x0 + dx;
          if (xx < 0 || xx >= Nx) continue;
          const wx = dx ? fx : 1 - fx;
          const w = wx * wyz;
          if (w <= 0) continue;
          const idx = ((xx * Ny + yy) * Nz + zz) * 3;
          const nr = out[idx]     + r * w;
          const ng = out[idx + 1] + g * w;
          const nb = out[idx + 2] + b * w;
          out[idx]     = nr > 255 ? 255 : nr;
          out[idx + 1] = ng > 255 ? 255 : ng;
          out[idx + 2] = nb > 255 ? 255 : nb;
        }
      }
    }
  }
}
