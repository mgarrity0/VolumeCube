// Rotating Cube — a glowing wireframe cube tumbles through the volume.
// The 12 edges burn as bright neon filaments and the 8 corner vertices
// flare as pulsing nodes. Color flows along the edges as a hue journey and
// the whole frame is depth-shaded front-to-back so the near face glows hot
// while the far face sinks into cool darkness. The body is hollow so the
// rotation reads clearly through the outer LEDs, with soft bloom around
// every lit filament for the dark-room look.
//
// Class API so the rotation trig (one full 3D basis) is built once per frame
// in update() instead of recomputed per-voxel in render().

export const params = {
  size:      { type: 'range', min: 0.2,  max: 1,   step: 0.01, default: 0.78 },
  speedX:    { type: 'range', min: -3,   max: 3,   step: 0.01, default: 0.55 },
  speedY:    { type: 'range', min: -3,   max: 3,   step: 0.01, default: 0.83 },
  speedZ:    { type: 'range', min: -3,   max: 3,   step: 0.01, default: 0.31 },
  thickness: { type: 'range', min: 0.05, max: 0.5, step: 0.01, default: 0.16 },
  glow:      { type: 'range', min: 0,    max: 1,   step: 0.01, default: 0.55 },
  hueShift:  { type: 'range', min: 0,    max: 1,   step: 0.01, default: 0.55 },
  hueSpread: { type: 'range', min: 0,    max: 1,   step: 0.01, default: 0.6 },
  vertices:  { type: 'toggle', default: true },
  depth:     { type: 'range', min: 0,    max: 1,   step: 0.01, default: 0.7 },
};

export default class RotatingCube {
  static name = 'Rotating Cube';

  update(ctx) {
    const { t, params } = ctx;
    const ax = -t * params.speedX;
    const ay = -t * params.speedY;
    const az = -t * params.speedZ;
    const cax = Math.cos(ax), sax = Math.sin(ax);
    const cay = Math.cos(ay), say = Math.sin(ay);
    const caz = Math.cos(az), saz = Math.sin(az);

    // Build the forward rotation R = Rz * Ry * Rx once, then we apply its
    // transpose (== inverse for a rotation) per voxel to map world -> cube.
    // Columns of m are the rotated cube-space basis vectors in world coords;
    // rows give us the inverse mapping directly.
    // Rx then Ry then Rz applied to a point p:
    //   p1 = Rx p, p2 = Ry p1, p3 = Rz p2
    // We store the inverse so render() can do cubeCoord = Rinv * world.
    // Rinv = Rx^T Ry^T Rz^T. Precompute as a flat 3x3.
    // Forward matrices:
    // Rx = [[1,0,0],[0,cax,-sax],[0,sax,cax]]
    // Ry = [[cay,0,say],[0,1,0],[-say,0,cay]]
    // Rz = [[caz,-saz,0],[saz,caz,0],[0,0,1]]
    // R = Rz*Ry*Rx
    const r00 = caz * cay;
    const r01 = caz * say * sax - saz * cax;
    const r02 = caz * say * cax + saz * sax;
    const r10 = saz * cay;
    const r11 = saz * say * sax + caz * cax;
    const r12 = saz * say * cax - caz * sax;
    const r20 = -say;
    const r21 = cay * sax;
    const r22 = cay * cax;

    // Inverse (transpose) — rows of R become columns.
    this.i00 = r00; this.i01 = r10; this.i02 = r20;
    this.i10 = r01; this.i11 = r11; this.i12 = r21;
    this.i20 = r02; this.i21 = r12; this.i22 = r22;

    // Slow, organic breathing of the wireframe brightness (coprime sines).
    this.pulse = 0.78
      + 0.14 * Math.sin(t * 1.07)
      + 0.08 * Math.sin(t * 1.93 + 1.7);
  }

  render(ctx, out) {
    const { t, Nx, Ny, Nz, params, utils, audio } = ctx;
    const { clamp, smoothstep, hsv } = utils;

    out.fill(0);

    const half = params.size;
    const thickness = params.thickness;
    const glowAmt = params.glow;
    const hueBase = params.hueShift;
    const hueSpread = params.hueSpread;
    const showVerts = params.vertices;
    const depthAmt = params.depth;

    const i00 = this.i00, i01 = this.i01, i02 = this.i02;
    const i10 = this.i10, i11 = this.i11, i12 = this.i12;
    const i20 = this.i20, i21 = this.i21, i22 = this.i22;

    const invX = Nx > 1 ? 1 / (Nx - 1) : 0;
    const invY = Ny > 1 ? 1 / (Ny - 1) : 0;
    const invZ = Nz > 1 ? 1 / (Nz - 1) : 0;

    // Audio gives the wireframe a heartbeat without being required to look good.
    const beatKick = audio ? audio.beat ? 1 : 0 : 0;
    const energy = audio ? audio.energy : 0;
    const pulse = this.pulse * (1 + 0.18 * energy) + 0.22 * beatKick;

    // Edge half-thickness in cube space; glow extends a bit beyond the core.
    const core = thickness * 0.5;
    const halo = core + glowAmt * 0.55 + 0.02;

    // Hue travels around the cube over time for a living color journey.
    const hueT = hueBase + t * 0.03;

    let idx = 0;
    for (let xi = 0; xi < Nx; xi++) {
      const wx = (xi * invX) * 2 - 1;
      for (let yi = 0; yi < Ny; yi++) {
        const wy = (yi * invY) * 2 - 1;
        for (let zi = 0; zi < Nz; zi++, idx++) {
          const wz = Nz > 1 ? (zi * invZ) * 2 - 1 : 0;

          // World -> cube space (inverse rotation).
          const px = i00 * wx + i01 * wy + i02 * wz;
          const py = i10 * wx + i11 * wy + i12 * wz;
          const pz = i20 * wx + i21 * wy + i22 * wz;

          const apx = px < 0 ? -px : px;
          const apy = py < 0 ? -py : py;
          const apz = pz < 0 ? -pz : pz;

          // Distance from each face plane (how far inside, signed-ish).
          // For wireframe edges we need two coords near the +/- half walls.
          const dx = half - apx; // >0 inside the x-slab
          const dy = half - apy;
          const dz = half - apz;

          // Reject anything well outside the cube (with a little halo room).
          if (dx < -halo || dy < -halo || dz < -halo) {
            continue;
          }

          // "Wall proximity": how close to a face (0 = on the face plane).
          // We clamp to >=0 outside isn't useful; use absolute distance to wall.
          const wallX = dx < 0 ? -dx : dx;
          const wallY = dy < 0 ? -dy : dy;
          const wallZ = dz < 0 ? -dz : dz;

          // An edge is where TWO of the three coords sit on their walls.
          // Take the two smallest wall distances; their combined closeness
          // defines the edge filament. The third coord must lie within the
          // cube extent (between the walls) for it to be a real edge.
          let s0, s1, s2; // sorted ascending
          if (wallX < wallY) {
            if (wallY < wallZ) { s0 = wallX; s1 = wallY; s2 = wallZ; }
            else if (wallX < wallZ) { s0 = wallX; s1 = wallZ; s2 = wallY; }
            else { s0 = wallZ; s1 = wallX; s2 = wallY; }
          } else {
            if (wallX < wallZ) { s0 = wallY; s1 = wallX; s2 = wallZ; }
            else if (wallY < wallZ) { s0 = wallY; s1 = wallZ; s2 = wallX; }
            else { s0 = wallZ; s1 = wallY; s2 = wallX; }
          }

          // The two near walls are s0 (closest) and s1 (second). Distance to
          // the nearest edge line is hypot of the two smallest wall dists.
          const edgeDist = Math.sqrt(s0 * s0 + s1 * s1);

          // Bright neon core with smooth bloom falloff around it.
          const coreI = smoothstep(core + 0.015, 0, edgeDist);
          const haloI = smoothstep(halo, core, edgeDist) * glowAmt;
          let intensity = coreI + haloI * 0.7;

          // Corner vertices: all three coords near a wall -> a glowing node.
          if (showVerts) {
            const vDist = Math.sqrt(s0 * s0 + s1 * s1 + s2 * s2);
            const vCore = core + 0.05;
            const vHalo = vCore + glowAmt * 0.65 + 0.04;
            const vNode = smoothstep(vHalo, 0, vDist);
            // Vertices pulse slightly out of phase per corner via position.
            const vp = 0.7 + 0.3 * Math.sin(t * 2.3 + (px + py + pz) * 2.5);
            intensity += vNode * (1.1 + 0.4 * beatKick) * vp;
          }

          if (intensity <= 0.001) continue;
          intensity *= pulse;
          if (intensity > 1.6) intensity = 1.6;

          // --- Color: hue journey along the dominant edge axis + position ---
          // Use the cube-space coordinate that runs along the lit edge (the
          // largest |coord|, s2's owner runs along the edge) plus a global
          // sweep for an evolving complementary palette.
          const along = (px + py * 0.6 + pz * 1.3);
          const hue = hueT + hueSpread * (0.5 + 0.5 * Math.sin(along * 1.6 + t * 0.5));

          // --- Depth shading: front (+Z world, near camera) hot, back cool ---
          // wz in [-1,1]; z=0 layer is the front face. Map so front is bright.
          const depthFront = (1 - (wz * 0.5 + 0.5)); // 1 at front, 0 at back
          const depthMul = 1 - depthAmt * (1 - depthFront) * 0.85;
          const sat = clamp(0.85 + 0.15 * depthFront, 0, 1);
          const val = clamp(intensity * depthMul, 0, 1.2);

          const [cr, cg, cb] = hsv(hue, sat, val > 1 ? 1 : val);

          // Push hot cores toward white for a glowing filament look, and add
          // a touch of overdrive on strong cores so edges bloom in the dark.
          const whiteMix = clamp((intensity - 0.85) * 1.4, 0, 1) * 0.6;
          const boost = 1 + (val > 1 ? (val - 1) * 0.8 : 0);

          let r = (cr + (255 - cr) * whiteMix) * boost;
          let g = (cg + (255 - cg) * whiteMix) * boost;
          let b = (cb + (255 - cb) * whiteMix) * boost;

          const o = idx * 3;
          out[o]     = r > 255 ? 255 : r;
          out[o + 1] = g > 255 ? 255 : g;
          out[o + 2] = b > 255 ? 255 : b;
        }
      }
    }
  }
}
