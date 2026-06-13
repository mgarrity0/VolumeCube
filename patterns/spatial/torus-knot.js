// Torus Knot — a glowing (p,q) torus knot rotating in 3D.
//
// A (p,q) torus knot is a single closed curve that winds p times around the
// torus axis and q times through the hole. We trace it parametrically over
// θ∈[0,2π) with dense samples:
//   r(θ) = R + a·cos(qθ)
//   x = r·cos(pθ),  y = r·sin(pθ),  z = a·sin(qθ)
// When gcd(p,q)=1 this is one unbroken knotted loop. Each sample is splatted
// into the voxel grid with trilinear deposit so the tube reads as a smooth
// glowing strand. Hue cycles ALONG the curve length (by θ) so the eye can
// follow the strand as it threads over and under itself.
//
// The whole point cloud is rotated by time on two axes (Y and X) before being
// mapped into the cube, so the knot tumbles and its genuinely-3D over/under
// structure becomes legible — depth, not just a flat tangle. A bright core
// with soft falloff (handled by the trilinear splat spreading energy into the
// 8 neighbours, then bloom in the room) gives high dynamic range against the
// dark empty voxels.
//
// Works for any Nx/Ny/Nz including thin slabs (Nz=1): the curve is scaled per
// axis so it always fits, and all divides are guarded.

export const params = {
  speed:    { type: 'range', min: 0,   max: 3,   step: 0.01, default: 1.0,  label: 'Rotation speed' },
  p:        { type: 'int',   min: 1,   max: 7,                default: 2,    label: 'p (around axis)' },
  q:        { type: 'int',   min: 1,   max: 7,                default: 3,    label: 'q (through hole)' },
  tube:     { type: 'range', min: 0.1, max: 0.6, step: 0.01, default: 0.22, label: 'Tube radius' },
  samples:  { type: 'int',   min: 200, max: 3000,            default: 1600, label: 'Curve samples' },
  hueSpan:  { type: 'range', min: 0.3, max: 4,   step: 0.05, default: 1.5,  label: 'Hue revs / loop' },
  hueDrift: { type: 'range', min: -1,  max: 1,   step: 0.01, default: 0.08, label: 'Hue drift (rev/s)' },
  bright:   { type: 'range', min: 0.3, max: 2.5, step: 0.05, default: 1.0,  label: 'Brightness' },
};

// Additive trilinear splat: deposits (r,g,b) across the 8 voxels around a
// fractional position, weighted by proximity. Clamps to 255 so overlapping
// strands bloom rather than wrap.
function splat(out, Nx, Ny, Nz, x, y, z, r, g, b) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  for (let dx = 0; dx <= 1; dx++) {
    const xx = x0 + dx;
    if (xx < 0 || xx >= Nx) continue;
    const wx = dx ? fx : 1 - fx;
    for (let dy = 0; dy <= 1; dy++) {
      const yy = y0 + dy;
      if (yy < 0 || yy >= Ny) continue;
      const wy = dy ? fy : 1 - fy;
      for (let dz = 0; dz <= 1; dz++) {
        const zz = z0 + dz;
        if (zz < 0 || zz >= Nz) continue;
        const w = wx * wy * (dz ? fz : 1 - fz);
        if (w <= 0) continue;
        const idx = (xx * Ny + yy) * Nz + zz;
        out[idx * 3 + 0] = Math.min(255, out[idx * 3 + 0] + r * w);
        out[idx * 3 + 1] = Math.min(255, out[idx * 3 + 1] + g * w);
        out[idx * 3 + 2] = Math.min(255, out[idx * 3 + 2] + b * w);
      }
    }
  }
}

export default class TorusKnot {
  static name = 'Torus Knot';

  render(ctx, out) {
    const { Nx, Ny, Nz, t, params, utils } = ctx;
    out.fill(0);

    const p = Math.max(1, Math.round(params.p));
    const q = Math.max(1, Math.round(params.q));
    const samples = Math.max(2, Math.round(params.samples));
    const bright = params.bright * 255;

    // Knot geometry in a normalised box: major radius R, minor radius a.
    // r(θ)=R+a·cos(qθ) ranges over [R-a, R+a]; z over [-a, a]. So the cloud
    // spans roughly [-(R+a), R+a] in x/y and [-a, a] in z. We compute the
    // true x/y extent (R+a) and z extent (a) and scale each cube axis to fit.
    const R = 1.0;
    const a = 0.5;
    const extentXY = R + a;   // max |x|,|y| before rotation
    const extentZ = a;        // max |z| before rotation

    // Rotation by time on two axes so the 3D structure tumbles into view.
    const ay = t * params.speed * 0.7;        // yaw
    const ax = t * params.speed * 0.43 + 0.6; // pitch (offset start so it's not edge-on)
    const cay = Math.cos(ay), say = Math.sin(ay);
    const cax = Math.cos(ax), sax = Math.sin(ax);

    // After rotation the knot can extend up to its full XY radius on any axis,
    // so size the fit envelope to the largest pre-rotation extent. This keeps
    // the knot comfortably inside the cube as it spins.
    const env = extentXY; // dominant radius governs all rotated axes
    const cxV = (Nx - 1) * 0.5;
    const cyV = (Ny - 1) * 0.5;
    const czV = (Nz - 1) * 0.5;
    // Leave a small margin so the tube glow doesn't clip at the faces.
    const margin = 0.88;
    const sX = Nx > 1 ? cxV * margin / env : 0;
    const sY = Ny > 1 ? cyV * margin / env : 0;
    const sZ = Nz > 1 ? czV * margin / env : 0;

    // Per-sample brightness: more samples => each is dimmer, so the visible
    // tube intensity stays roughly constant regardless of `samples`. Tuned so
    // overlapping splats build a bright core while empty space stays dark.
    const perSample = bright * (0.85 / Math.sqrt(samples));

    // Tube thickness: a sample is splatted at its centre, and the trilinear
    // spread plus stepping in θ naturally thickens the line. We additionally
    // jitter a few offset points around the centre along an approximate normal
    // to fatten the tube to the requested radius without exploding cost.
    const tubeVox = params.tube; // in normalised units; scaled per axis below

    const drift = t * params.hueDrift;
    const hueSpan = params.hueSpan;

    const TWO_PI = Math.PI * 2;
    for (let i = 0; i < samples; i++) {
      const th = (i / samples) * TWO_PI;
      const cq = Math.cos(q * th), sq = Math.sin(q * th);
      const cp = Math.cos(p * th), sp = Math.sin(p * th);
      const rr = R + a * cq;

      // Knot point in model space.
      let mx = rr * cp;
      let my = rr * sp;
      let mz = a * sq;

      // Rotate about Y (yaw): mixes x and z.
      let rx = mx * cay + mz * say;
      let rz = -mx * say + mz * cay;
      let ry = my;
      // Rotate about X (pitch): mixes y and z.
      let fy2 = ry * cax - rz * sax;
      let fz2 = ry * sax + rz * cax;
      const fx = rx;
      const fy = fy2;
      const fz = fz2;

      // Map model space (centred at 0) to voxel space.
      const vx = cxV + fx * sX;
      const vy = cyV + fy * sY;
      const vz = czV + fz * sZ;

      // Hue follows position ALONG the curve (θ), so the strand is a moving
      // rainbow you can trace through the tangle.
      const hue = (i / samples) * hueSpan + drift;
      const c = utils.hsv(((hue % 1) + 1) % 1, 0.95, 1);
      const cr = c[0] * perSample;
      const cg = c[1] * perSample;
      const cb = c[2] * perSample;

      // Bright core sample.
      splat(out, Nx, Ny, Nz, vx, vy, vz, cr, cg, cb);

      // Fatten into a tube: deposit dimmer satellite points offset along the
      // two rotated axes perpendicular-ish to the dominant winding. Cheap and
      // gives a soft round glow rather than a hairline.
      const tx = tubeVox * sX, ty = tubeVox * sY, tz = tubeVox * sZ;
      const halo = perSample * 0.32;
      const hr = c[0] * halo, hg = c[1] * halo, hb = c[2] * halo;
      splat(out, Nx, Ny, Nz, vx + tx, vy, vz, hr, hg, hb);
      splat(out, Nx, Ny, Nz, vx - tx, vy, vz, hr, hg, hb);
      splat(out, Nx, Ny, Nz, vx, vy + ty, vz, hr, hg, hb);
      splat(out, Nx, Ny, Nz, vx, vy - ty, vz, hr, hg, hb);
      if (Nz > 1) {
        splat(out, Nx, Ny, Nz, vx, vy, vz + tz, hr, hg, hb);
        splat(out, Nx, Ny, Nz, vx, vy, vz - tz, hr, hg, hb);
      }
    }
  }
}
