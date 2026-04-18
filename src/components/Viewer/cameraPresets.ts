import type { CameraPreset } from '../../state/store';

// Camera presets scaled to the default 3 ft cube (edge ≈ 0.9144 m).
// Positions chosen so the full cube fits comfortably at FOV 50 with a bit of
// headroom. Target is always the origin (cube is centered).
//
// Preset 'orbit' means "don't touch the camera, user is driving OrbitControls".
// Clicking a preset button sets one of the named presets; the controller
// tweens, then flips back to 'orbit' so subsequent drags are free.

export type CamView = {
  pos: [number, number, number];
  target: [number, number, number];
};

export const DEFAULT_CAM: CamView = {
  pos: [1.6, 1.2, 1.8],
  target: [0, 0, 0],
};

export const CAM_PRESETS: Record<Exclude<CameraPreset, 'orbit'>, CamView> = {
  front: { pos: [0, 0, 2.4], target: [0, 0, 0] },
  side:  { pos: [2.4, 0, 0], target: [0, 0, 0] },
  top:   { pos: [0, 2.4, 0.001], target: [0, 0, 0] },
  iso:   { pos: [1.6, 1.3, 1.8], target: [0, 0, 0] },
};

export const TWEEN_DURATION = 0.6;

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
