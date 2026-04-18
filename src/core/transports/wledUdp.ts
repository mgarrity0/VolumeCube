// WLED realtime transport via DDP (Distributed Display Protocol).
//
// DDP picked over DRGB/DNRGB because it's the cleanest fit for >489-LED
// frames — the whole 10³ cube (3000 bytes) goes in one logical datagram.
// IP will fragment at the MTU boundary, which is fine on a LAN.
//
// Packet format (10-byte header + payload):
//   0: flags     — 0x41 (version 1, PUSH=1)
//   1: sequence  — 0–15 rolling sequence, 0 = unsequenced
//   2: data type — 0x01 = RGB 8-bit per channel
//   3: source id — 0x01 = primary display
//   4–7: offset  — 32-bit big-endian byte offset into the display buffer
//   8–9: length  — 16-bit big-endian payload bytes in this packet
//
// WLED listens on UDP 4048 by default. The JS side hands Rust a ready-to-
// go Uint8Array; Rust binds a local UDP socket and send_to()s it.

import { invoke } from '@tauri-apps/api/core';
import type { OutputConfig, Transport } from './index';

const DDP_HEADER_LEN = 10;

export class WledUdpTransport implements Transport {
  readonly name = 'WLED UDP (DDP)';
  private seq = 0;

  async connect(cfg: OutputConfig): Promise<void> {
    if (!cfg.wledIp || !cfg.wledPort) throw new Error('WLED IP and port required');
    // UDP is connectionless; Rust lazily binds on first send. We probe
    // by sending a zero-length push so the user sees errors right away
    // instead of silently dropping frames later.
    const probe = this.buildDdp(new Uint8Array(0), 0);
    await invoke('wled_send', {
      ip: cfg.wledIp,
      port: cfg.wledPort,
      bytes: Array.from(probe),
    });
  }

  async disconnect(): Promise<void> {
    // Nothing to tear down client-side; the OS owns the UDP socket.
  }

  async sendFrame(streamBytes: Uint8Array, cfg: OutputConfig): Promise<void> {
    // Fits in one UDP datagram for any reasonable cube size. Larger
    // frames could split at the 1400-byte boundary here, but we defer
    // that until someone actually runs >65k LEDs.
    const packet = this.buildDdp(streamBytes, 0);
    await invoke('wled_send', {
      ip: cfg.wledIp,
      port: cfg.wledPort,
      bytes: Array.from(packet),
    });
  }

  private buildDdp(payload: Uint8Array, offset: number): Uint8Array {
    const pkt = new Uint8Array(DDP_HEADER_LEN + payload.length);
    pkt[0] = 0x41;                  // version 1, PUSH set
    pkt[1] = this.seq & 0x0f;       // sequence 0..15
    this.seq = (this.seq + 1) & 0x0f;
    pkt[2] = 0x01;                  // type: RGB 8-bit
    pkt[3] = 0x01;                  // id: primary display
    // offset, big-endian 32-bit
    pkt[4] = (offset >>> 24) & 0xff;
    pkt[5] = (offset >>> 16) & 0xff;
    pkt[6] = (offset >>> 8) & 0xff;
    pkt[7] = offset & 0xff;
    // length, big-endian 16-bit
    pkt[8] = (payload.length >>> 8) & 0xff;
    pkt[9] = payload.length & 0xff;
    pkt.set(payload, DDP_HEADER_LEN);
    return pkt;
  }
}
