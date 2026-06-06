// WLED realtime transport via DDP (Distributed Display Protocol).
//
// Multi-target capable. Given a stream-ordered byte buffer and a list
// of targets each owning a contiguous LED range, this transport slices
// the buffer per controller and emits DDP packets:
//
//   • Per-target byte range = streamBytes[ledStart*3 ... (ledStart+ledCount)*3)
//   • Each target's DDP offset starts at 0 — controllers have their
//     own local LED buffer; we never use the stream-global offset.
//   • Packets are fragmented at DDP_MAX_PAYLOAD when a single target
//     carries more than fits in one UDP datagram.
//   • PUSH flag is OFF on every packet except the very last one of the
//     very last target. WLED buffers the partial frame and only commits
//     when it sees a packet with PUSH=1, which is how we keep the seam
//     between two controllers tear-free.
//
// Packet format (10-byte header + payload):
//   0: flags     — 0x40 (version 1, PUSH=0) or 0x41 (PUSH=1)
//   1: sequence  — 0–15 rolling sequence, 0 = unsequenced
//   2: data type — 0x01 = RGB 8-bit per channel
//   3: source id — 0x01 = primary display
//   4–7: offset  — 32-bit big-endian byte offset into the display buffer
//   8–9: length  — 16-bit big-endian payload bytes in this packet
//
// WLED listens on UDP 4048 by default.

import { invoke } from '@tauri-apps/api/core';
import type { OutputConfig, Transport, NetworkTarget } from './index';
import type { UdpSender } from './udpSender';

const DDP_HEADER_LEN = 10;
// Safely under typical 1500-byte MTU after IP+UDP headers. WLED accepts
// up to ~1440 payload bytes per DDP packet in practice; we leave a bit
// of slack so wonky home-router MTUs don't surprise us.
const DDP_MAX_PAYLOAD = 1440;

export class WledUdpTransport implements Transport {
  readonly name = 'WLED UDP (DDP)';
  private seq = 0;
  private sendUdp: UdpSender | null;

  /**
   * @param sendUdp Optional UDP sender override (used by the Node-side
   *                runtime to use `dgram` instead of Tauri). When null,
   *                falls back to the bundled Tauri `wled_send` command.
   */
  constructor(sendUdp: UdpSender | null = null) {
    this.sendUdp = sendUdp;
  }

  private async send(ip: string, port: number, bytes: Uint8Array): Promise<void> {
    if (this.sendUdp) {
      return this.sendUdp(ip, port, bytes);
    }
    await invoke('wled_send', { ip, port, bytes: Array.from(bytes) });
  }

  async connect(cfg: OutputConfig): Promise<void> {
    const targets = resolveTargets(cfg, 0);
    if (targets.length === 0) throw new Error('WLED transport requires at least one target');
    // Probe each target with a zero-length push so the user sees
    // unreachable controllers as a connect-time error instead of
    // silently dropping frames later.
    for (const tgt of targets) {
      const probe = this.buildDdp(new Uint8Array(0), 0, true);
      await this.send(tgt.ip, tgt.port, probe);
    }
  }

  async disconnect(): Promise<void> {
    // UDP is connectionless on our side; nothing to tear down.
  }

  async sendFrame(streamBytes: Uint8Array, cfg: OutputConfig): Promise<void> {
    const totalLeds = streamBytes.length / 3;
    const targets = resolveTargets(cfg, totalLeds);
    if (targets.length === 0) return;

    // Precompute per-target fragment counts so we know which packet is
    // the absolute last (it's the one that gets PUSH=1).
    const fragsPerTarget: number[] = targets.map((t) =>
      Math.max(1, Math.ceil((t.ledCount * 3) / DDP_MAX_PAYLOAD)),
    );
    const totalFrags = fragsPerTarget.reduce((a, b) => a + b, 0);

    let fragIdx = 0;
    for (let ti = 0; ti < targets.length; ti++) {
      const tgt = targets[ti];
      const startByte = tgt.ledStart * 3;
      const totalBytes = tgt.ledCount * 3;
      // Clamp to actual buffer length — handles the legacy
      // ledCount=0/oversized target case without an exception.
      const endByte = Math.min(streamBytes.length, startByte + totalBytes);
      let sent = startByte;
      while (sent < endByte) {
        const remaining = endByte - sent;
        const chunkLen = Math.min(remaining, DDP_MAX_PAYLOAD);
        const slice = streamBytes.subarray(sent, sent + chunkLen);
        const offsetInTarget = sent - startByte;
        fragIdx++;
        const push = fragIdx === totalFrags;
        const packet = this.buildDdp(slice, offsetInTarget, push);
        await this.send(tgt.ip, tgt.port, packet);
        sent += chunkLen;
      }
    }
  }

  private buildDdp(payload: Uint8Array, offset: number, push: boolean): Uint8Array {
    const pkt = new Uint8Array(DDP_HEADER_LEN + payload.length);
    pkt[0] = push ? 0x41 : 0x40;       // version 1, PUSH bit
    pkt[1] = this.seq & 0x0f;
    this.seq = (this.seq + 1) & 0x0f;
    pkt[2] = 0x01;                      // type: RGB 8-bit
    pkt[3] = 0x01;                      // id: primary display
    pkt[4] = (offset >>> 24) & 0xff;
    pkt[5] = (offset >>> 16) & 0xff;
    pkt[6] = (offset >>> 8) & 0xff;
    pkt[7] = offset & 0xff;
    pkt[8] = (payload.length >>> 8) & 0xff;
    pkt[9] = payload.length & 0xff;
    pkt.set(payload, DDP_HEADER_LEN);
    return pkt;
  }
}

/**
 * Materialize the effective target list. If the user has configured a
 * target table we honor it verbatim; otherwise we synthesize a single
 * target from the legacy single-controller fields so existing setups
 * keep working without a UI migration.
 *
 * `totalLeds` is used to fill in ledCount=0 sentinels (legacy mode,
 * "whatever the stream gives me").
 */
export function resolveTargets(cfg: OutputConfig, totalLeds: number): NetworkTarget[] {
  if (cfg.targets && cfg.targets.length > 0) {
    return cfg.targets.map((t) => ({
      ...t,
      ledCount: t.ledCount > 0 ? t.ledCount : Math.max(0, totalLeds - t.ledStart),
    }));
  }
  return [{
    id: 'legacy',
    ip: cfg.wledIp,
    port: cfg.wledPort,
    ledStart: 0,
    ledCount: totalLeds,
    universeStart: 1,
  }];
}
