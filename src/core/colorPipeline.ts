// Color + power pipeline.
//
// Pipeline per frame:
//   1. Pattern fills patternBuf (Uint8, 0..255).
//   2. computeDuty → brightness-scaled byte buffer for power estimation.
//   3. estimatePower returns { amps, watts, scale } where scale<1 is ABL.
//   4. bakeFrame writes any combination of:
//        - Float32 logical-order linear buffer (for R3F instanceColor)
//        - Uint8 stream-ordered buffer (for hardware transport)
//      applying brightness → gamma → ABL scale → color-order shuffle in one pass.

export type ColorOrder = 'RGB' | 'RBG' | 'GRB' | 'GBR' | 'BRG' | 'BGR';

export type ColorConfig = {
  gamma: number;          // 2.4 is a good WS2815 default
  brightness: number;     // 0..1 duty cycle
  colorOrder: ColorOrder; // simulator shuffle for hardware parity
};

export const defaultColorConfig: ColorConfig = {
  gamma: 2.4,
  brightness: 0.8,
  // Simulator stays RGB by default so patterns look as authored. Switch to
  // 'GRB' to visualize byte-order wiring bugs before flashing.
  colorOrder: 'RGB',
};

export function buildGammaLut(gamma: number): Float32Array {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.pow(i / 255, gamma);
  return lut;
}

export function shuffleIndices(order: ColorOrder): [number, number, number] {
  // [srcIdxForR, srcIdxForG, srcIdxForB] — pattern output is RGB-ordered.
  switch (order) {
    case 'RGB': return [0, 1, 2];
    case 'RBG': return [0, 2, 1];
    case 'GRB': return [1, 0, 2];
    case 'GBR': return [2, 0, 1];
    case 'BRG': return [1, 2, 0];
    case 'BGR': return [2, 1, 0];
  }
}

/**
 * Brightness-only pass: multiply pattern × brightness and clamp to 0..255.
 * Output feeds estimatePower — gamma is a perceptual curve, not a power curve.
 */
export function computeDuty(
  patternBuf: Uint8ClampedArray,
  brightness: number,
  dutyOut: Uint8ClampedArray,
): void {
  const n = patternBuf.length;
  for (let i = 0; i < n; i++) {
    const v = patternBuf[i] * brightness;
    dutyOut[i] = v > 255 ? 255 : v;
  }
}

/**
 * One-pass bake: brightness → gamma → ABL → color-order shuffle, emitting
 * into any combination of float (logical order, [0,1]) and byte (stream
 * order via addressMap, [0,255]) buffers.
 */
export function bakeFrame(
  patternBuf: Uint8ClampedArray,
  cfg: ColorConfig,
  gammaLut: Float32Array,
  ablScale: number,
  addressMap: Uint32Array | null,
  floatOut: Float32Array | null,
  streamOut: Uint8Array | null,
): void {
  const [sr, sg, sb] = shuffleIndices(cfg.colorOrder);
  const brightness = cfg.brightness;
  const count = patternBuf.length / 3;

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const rDv = patternBuf[i3] * brightness;
    const gDv = patternBuf[i3 + 1] * brightness;
    const bDv = patternBuf[i3 + 2] * brightness;
    const rD = rDv > 255 ? 255 : rDv | 0;
    const gD = gDv > 255 ? 255 : gDv | 0;
    const bD = bDv > 255 ? 255 : bDv | 0;
    const rG = gammaLut[rD] * ablScale;
    const gG = gammaLut[gD] * ablScale;
    const bG = gammaLut[bD] * ablScale;
    // Color-order shuffle via ternaries — no per-voxel array allocation.
    const outR = sr === 0 ? rG : sr === 1 ? gG : bG;
    const outG = sg === 0 ? rG : sg === 1 ? gG : bG;
    const outB = sb === 0 ? rG : sb === 1 ? gG : bG;

    if (floatOut) {
      floatOut[i3]     = outR;
      floatOut[i3 + 1] = outG;
      floatOut[i3 + 2] = outB;
    }
    if (streamOut && addressMap) {
      const s3 = addressMap[i] * 3;
      const r255 = outR * 255;
      const g255 = outG * 255;
      const b255 = outB * 255;
      streamOut[s3]     = r255 > 255 ? 255 : r255 | 0;
      streamOut[s3 + 1] = g255 > 255 ? 255 : g255 | 0;
      streamOut[s3 + 2] = b255 > 255 ? 255 : b255 | 0;
    }
  }
}
