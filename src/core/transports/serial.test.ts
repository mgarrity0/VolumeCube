import { describe, it, expect } from 'vitest';
import { crc16Ccitt } from './serial';

// CRC-16/CCITT-FALSE is a widely-tested variant with well-known test vectors.
// These must match the firmware's implementation in
// firmware/esp32_serial_receiver/ byte for byte — a drift here would cause
// every frame to be rejected as corrupt.
describe('crc16Ccitt', () => {
  it('returns the 0xFFFF init value for an empty buffer', () => {
    expect(crc16Ccitt(new Uint8Array(0))).toBe(0xffff);
  });

  it('matches the canonical "123456789" → 0x29B1 test vector', () => {
    const data = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
    expect(crc16Ccitt(data)).toBe(0x29b1);
  });

  it('matches a single-byte 0xA5 → 0x04BF test vector', () => {
    // Hand-computed for CRC-16/CCITT-FALSE — locks the byte-level
    // behavior against accidental polynomial or init-value drift.
    expect(crc16Ccitt(new Uint8Array([0xa5]))).toBe(0x04bf);
  });

  it('is deterministic', () => {
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(crc16Ccitt(data)).toBe(crc16Ccitt(data));
  });

  it('rejects a flipped bit (CRC changes)', () => {
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const flipped = new Uint8Array(data);
    flipped[1] ^= 0x01;
    expect(crc16Ccitt(flipped)).not.toBe(crc16Ccitt(data));
  });
});
