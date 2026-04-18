// Per-frame pattern runner. Shared between Cube.tsx's live loop and the
// offline FastLED exporter so both follow the same rules for function- vs
// class-API patterns.

import type { VoxelCoords } from './cubeGeometry';
import type { LoadedPattern, RenderContext, VoxelCoord } from './patternApi';

/**
 * Run the active pattern for one frame and write 0..255 RGB into
 * `patternBuf` (logical order). Function-API patterns iterate voxels;
 * class-API patterns get update() + render(ctx, out).
 */
export function renderPatternFrame(
  pattern: LoadedPattern,
  ctx: RenderContext,
  coords: VoxelCoords,
  patternBuf: Uint8ClampedArray,
): void {
  if (pattern.kind === 'class' && pattern.instance) {
    pattern.instance.update?.(ctx);
    pattern.instance.render(ctx, patternBuf);
    return;
  }
  if (pattern.kind !== 'function' || !pattern.renderVoxel) return;
  const xyz: VoxelCoord = {
    x: 0, y: 0, z: 0, u: 0, v: 0, w: 0, cx: 0, cy: 0, cz: 0, i: 0,
  };
  const { xs, ys, zs, us, vs, ws, cxs, cys, czs, count } = coords;
  for (let i = 0; i < count; i++) {
    xyz.x = xs[i]; xyz.y = ys[i]; xyz.z = zs[i];
    xyz.u = us[i]; xyz.v = vs[i]; xyz.w = ws[i];
    xyz.cx = cxs[i]; xyz.cy = cys[i]; xyz.cz = czs[i];
    xyz.i = i;
    const rgb = pattern.renderVoxel(ctx, xyz);
    patternBuf[i * 3 + 0] = rgb[0];
    patternBuf[i * 3 + 1] = rgb[1];
    patternBuf[i * 3 + 2] = rgb[2];
  }
}
