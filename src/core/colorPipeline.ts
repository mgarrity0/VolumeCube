// Color + power pipeline (extended from Orbiter's colorSpace.ts).
//
// Pipeline per frame:
//   1. Pattern fills patternBuf (Uint8, 0..255).
//   2. Apply globalBrightness (duty-cycle scale, in-place on a float path).
//   3. Apply gamma via LUT.
//   4. Compute current draw — power.ts takes the post-gamma buffer and
//      returns { amps, watts, scale } where scale<1 when ABL kicks in.
//   5. Scale all channels by that ABL factor.
//   6. Apply color-order shuffle for WS2815 parity.
//   7. Emit:
//        - Float32 linear buffer in logical order (for R3F instanceColor)
//        - Uint8 stream-ordered buffer via the wiring address map (Phase 4)
//
// Phase 3 only needs the Float32 linear output; the stream-ordered byte
// buffer is produced the same way but gated behind Phase 4 transports.

export type ColorOrder = 'RGB' | 'RBG' | 'GRB' | 'GBR' | 'BRG' | 'BGR';

export type ColorConfig = {
  gamma: number;          // 2.4 is a good WS2815 default
  brightness: number;     // 0..1 duty cycle
  colorOrder: ColorOrder; // simulator shuffle for hardware parity
};

export const defaultColorConfig: ColorConfig = {
  gamma: 2.4,
  brightness: 0.8,
  // Keep the simulator in RGB by default so patterns look as authored.
  // Hardware-parity users switch this to 'GRB' to visualize byte-order
  // wiring bugs before flashing.
  colorOrder: 'RGB',
};

// 256-entry gamma LUT for fast per-channel mapping. Output is normalized
// floats in [0,1], ready for the Float32 instanceColor buffer.
export function buildGammaLut(gamma: number): Float32Array {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.pow(i / 255, gamma);
  return lut;
}

export function shuffleIndices(order: ColorOrder): [number, number, number] {
  // Returns [srcIdxForR, srcIdxForG, srcIdxForB].
  // Pattern output is RGB-ordered; the shuffle tells the simulator/output
  // which source channel goes into each of the strip's literal R/G/B slots.
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
 * Run the Phase 3 pipeline in one pass. Writes directly into a Float32 output
 * buffer of length count*3 (logical-order linear RGB, 0..1 each).
 *
 * `scale` is the ABL multiplier to apply post-gamma (1 when disabled / within
 * budget).
 */
export function bakeLinearFloats(
  patternBuf: Uint8ClampedArray,
  floatOut: Float32Array,
  cfg: ColorConfig,
  gammaLut: Float32Array,
  ablScale: number,
): void {
  const [sr, sg, sb] = shuffleIndices(cfg.colorOrder);
  const brightness = cfg.brightness;
  const b = brightness * ablScale;
  const n3 = patternBuf.length;

  for (let i = 0; i < n3; i += 3) {
    const rIn = patternBuf[i + 0];
    const gIn = patternBuf[i + 1];
    const bIn = patternBuf[i + 2];
    // Brightness is applied linearly (pre-gamma) so it matches how WLED /
    // FastLED scale the master brightness. Note: 255 is the LUT ceiling.
    const rDuty = Math.min(255, rIn * brightness) | 0;
    const gDuty = Math.min(255, gIn * brightness) | 0;
    const bDuty = Math.min(255, bIn * brightness) | 0;
    // Gamma via LUT then ABL scale.
    const rG = gammaLut[rDuty] * ablScale;
    const gG = gammaLut[gDuty] * ablScale;
    const bG = gammaLut[bDuty] * ablScale;
    // Color-order shuffle. Re-reference for clarity.
    const triple = [rG, gG, bG];
    floatOut[i + 0] = triple[sr];
    floatOut[i + 1] = triple[sg];
    floatOut[i + 2] = triple[sb];
    // `b` is referenced to keep it in the optimizer's sight for future
    // debugging (identical to brightness * ablScale, expanded inline above).
    void b;
  }
}

/**
 * Produce an 8-bit RGB byte buffer in **stream order** (not logical order)
 * for transport to hardware. Applies the same brightness + gamma + ABL +
 * color-order pipeline as bakeLinearFloats, then re-indexes through the
 * wiring address map so byte N of the output is the Nth LED the strip
 * expects to receive.
 *
 * Output length is streamOut.length (must equal patternBuf.length).
 */
export function bakeStreamBytes(
  patternBuf: Uint8ClampedArray,
  streamOut: Uint8Array,
  cfg: ColorConfig,
  gammaLut: Float32Array,
  ablScale: number,
  addressMap: Uint32Array,
): void {
  const [sr, sg, sb] = shuffleIndices(cfg.colorOrder);
  const brightness = cfg.brightness;
  const count = addressMap.length;

  for (let i = 0; i < count; i++) {
    const rIn = patternBuf[i * 3 + 0];
    const gIn = patternBuf[i * 3 + 1];
    const bIn = patternBuf[i * 3 + 2];
    const rDuty = Math.min(255, rIn * brightness) | 0;
    const gDuty = Math.min(255, gIn * brightness) | 0;
    const bDuty = Math.min(255, bIn * brightness) | 0;
    // Gamma → normalize to 0..1, apply ABL, scale to 0..255.
    const rG = Math.min(255, gammaLut[rDuty] * ablScale * 255) | 0;
    const gG = Math.min(255, gammaLut[gDuty] * ablScale * 255) | 0;
    const bG = Math.min(255, gammaLut[bDuty] * ablScale * 255) | 0;
    const triple = [rG, gG, bG];
    const stream = addressMap[i];
    streamOut[stream * 3 + 0] = triple[sr];
    streamOut[stream * 3 + 1] = triple[sg];
    streamOut[stream * 3 + 2] = triple[sb];
  }
}
