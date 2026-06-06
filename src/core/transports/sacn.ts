// sACN (ANSI E1.31) transport — multi-universe unicast UDP to each
// network target. This is the pro-AV-friendly path; TouchDesigner,
// xLights, Resolume, QLC+, and grandMA all speak sACN, so the same
// rig the simulator drives can later be addressed by external tools
// without changing firmware on the controllers.
//
// Packet structure (per ANSI E1.31 § 4):
//
//   ┌────────────────── Root Layer (38 bytes) ──────────────────┐
//   │ 0–1   Preamble Size          = 0x0010                     │
//   │ 2–3   Post-amble Size        = 0x0000                     │
//   │ 4–15  ACN Packet Identifier  = "ASC-E1.17\0\0\0"          │
//   │ 16–17 Flags+Length           = 0x7nnn (low 12 = pdu len)  │
//   │ 18–21 Vector                 = 0x00000004 (E131_DATA)     │
//   │ 22–37 Sender CID (UUID v4)                                │
//   └───────────────────────────────────────────────────────────┘
//   ┌──────────────── Framing Layer (77 bytes) ─────────────────┐
//   │ 38–39 Flags+Length                                        │
//   │ 40–43 Vector                 = 0x00000002 (DATA_PACKET)   │
//   │ 44–107 Source Name (UTF-8, null-padded to 64 B)           │
//   │ 108   Priority               = 100                        │
//   │ 109–110 Sync Universe        = 0x0000 (no sync)           │
//   │ 111   Sequence Number (per-universe, wraps 0–255)         │
//   │ 112   Options                = 0x00                       │
//   │ 113–114 Universe (1–63999)                                │
//   └───────────────────────────────────────────────────────────┘
//   ┌──────────────────── DMP Layer (10 B + data) ──────────────┐
//   │ 115–116 Flags+Length                                      │
//   │ 117     Vector               = 0x02 (SET_PROPERTY)        │
//   │ 118     Address/Data Type    = 0xa1                       │
//   │ 119–120 First Property Addr  = 0x0000                     │
//   │ 121–122 Address Increment    = 0x0001                     │
//   │ 123–124 Property Value Count = data length + 1            │
//   │ 125     DMX Start Code       = 0x00                       │
//   │ 126…    DMX channel data (up to 512 bytes)                │
//   └───────────────────────────────────────────────────────────┘
//
// Per-universe payload tops out at 512 DMX channels. WLED expects
// 510 channels = 170 RGB LEDs per universe — the standard convention.
// For a target carrying more than 170 LEDs we emit consecutive
// universes (universeStart, universeStart+1, …).
//
// No sync universe yet: two controllers receiving their respective
// unicast packets within ~1 ms of each other on a switched LAN don't
// produce visible seam tearing. The hook is in the packet (sync addr
// field) for when someone wants frame-perfect sync across more boards.

import { invoke } from '@tauri-apps/api/core';
import type { OutputConfig, Transport, NetworkTarget } from './index';
import type { UdpSender } from './udpSender';

const SACN_DEFAULT_PORT = 5568;
const CHANNELS_PER_UNIVERSE = 510;  // 170 RGB LEDs
const LEDS_PER_UNIVERSE = CHANNELS_PER_UNIVERSE / 3;
const SACN_HEADER_LEN = 126;
const SOURCE_NAME = 'VolumeCube';
const PRIORITY = 100;

// One CID per process — receivers see all our packets coming from the
// same source. Generated as a UUID v4 (random + variant bits) so it's
// statistically guaranteed unique without us tracking state.
const SOURCE_CID = generateCid();

function generateCid(): Uint8Array {
  const out = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && (crypto as any).getRandomValues) {
    (crypto as any).getRandomValues(out);
  } else {
    for (let i = 0; i < 16; i++) out[i] = Math.floor(Math.random() * 256);
  }
  out[6] = (out[6] & 0x0f) | 0x40;  // version 4
  out[8] = (out[8] & 0x3f) | 0x80;  // variant 10xx
  return out;
}

export class SacnTransport implements Transport {
  readonly name = 'sACN (E1.31)';
  // Per-universe sequence numbers — required by the spec so receivers
  // can detect dropped/reordered packets per universe.
  private seqByUniverse = new Map<number, number>();
  private sendUdp: UdpSender | null;

  /**
   * @param sendUdp Optional UDP sender override (used by the Node-side
   *                runtime). Falls back to Tauri's bundled `wled_send`
   *                command when null.
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
    const targets = resolveSacnTargets(cfg, 0);
    if (targets.length === 0) throw new Error('sACN transport requires at least one target');
    // No probe — pure unicast UDP, first real frame validates the route.
    // Reset sequence numbers so a reconnect starts fresh.
    this.seqByUniverse.clear();
  }

  async disconnect(): Promise<void> {}

  async sendFrame(streamBytes: Uint8Array, cfg: OutputConfig): Promise<void> {
    const totalLeds = streamBytes.length / 3;
    const targets = resolveSacnTargets(cfg, totalLeds);
    if (targets.length === 0) return;

    for (const tgt of targets) {
      const startByte = tgt.ledStart * 3;
      const totalBytes = Math.min(streamBytes.length - startByte, tgt.ledCount * 3);
      const numUniverses = Math.max(1, Math.ceil(tgt.ledCount / LEDS_PER_UNIVERSE));
      for (let u = 0; u < numUniverses; u++) {
        const universe = tgt.universeStart + u;
        const offset = u * CHANNELS_PER_UNIVERSE;
        if (offset >= totalBytes) break;
        const end = Math.min(offset + CHANNELS_PER_UNIVERSE, totalBytes);
        const payload = streamBytes.subarray(startByte + offset, startByte + end);
        const packet = this.buildPacket(universe, payload);
        await this.send(tgt.ip, tgt.port || SACN_DEFAULT_PORT, packet);
      }
    }
  }

  private buildPacket(universe: number, data: Uint8Array): Uint8Array {
    const dataLen = data.length;
    const totalLen = SACN_HEADER_LEN + dataLen;
    const pkt = new Uint8Array(totalLen);

    // ---- Root Layer ----
    pkt[0] = 0x00; pkt[1] = 0x10;             // Preamble Size = 16
    pkt[2] = 0x00; pkt[3] = 0x00;             // Post-amble Size = 0
    // ACN Packet Identifier: "ASC-E1.17\0\0\0"
    const pid = [0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00];
    for (let i = 0; i < 12; i++) pkt[4 + i] = pid[i];
    // Root flags+length: high nibble 0x7, low 12 bits = (total - 16)
    writePdu(pkt, 16, totalLen - 16);
    // Vector = E131_DATA = 0x00000004
    pkt[18] = 0; pkt[19] = 0; pkt[20] = 0; pkt[21] = 0x04;
    // Sender CID
    pkt.set(SOURCE_CID, 22);

    // ---- Framing Layer ----
    writePdu(pkt, 38, totalLen - 38);
    // Vector = DATA_PACKET = 0x00000002
    pkt[40] = 0; pkt[41] = 0; pkt[42] = 0; pkt[43] = 0x02;
    // Source Name — UTF-8, null-padded to 64 bytes
    const nameBytes = new TextEncoder().encode(SOURCE_NAME);
    const nameLen = Math.min(64, nameBytes.length);
    for (let i = 0; i < nameLen; i++) pkt[44 + i] = nameBytes[i];
    pkt[108] = PRIORITY;
    pkt[109] = 0; pkt[110] = 0;              // No sync universe yet
    pkt[111] = this.nextSeq(universe);
    pkt[112] = 0;                             // Options
    pkt[113] = (universe >> 8) & 0xff;
    pkt[114] = universe & 0xff;

    // ---- DMP Layer ----
    writePdu(pkt, 115, totalLen - 115);
    pkt[117] = 0x02;                          // VECTOR_DMP_SET_PROPERTY
    pkt[118] = 0xa1;                          // Address & Data Type
    pkt[119] = 0; pkt[120] = 0;               // First Property Address
    pkt[121] = 0; pkt[122] = 0x01;            // Address Increment
    const valCount = dataLen + 1;             // +1 for the DMX start code
    pkt[123] = (valCount >> 8) & 0xff;
    pkt[124] = valCount & 0xff;
    pkt[125] = 0x00;                          // DMX Start Code
    pkt.set(data, 126);

    return pkt;
  }

  private nextSeq(universe: number): number {
    const cur = this.seqByUniverse.get(universe) ?? 0;
    this.seqByUniverse.set(universe, (cur + 1) & 0xff);
    return cur;
  }
}

/**
 * Resolve effective targets for sACN. Same legacy fallback as DDP, but
 * the synthesized single target uses the sACN default port instead of
 * blindly inheriting the wledPort (which is configured for DDP=4048).
 */
function resolveSacnTargets(cfg: OutputConfig, totalLeds: number): NetworkTarget[] {
  if (cfg.targets && cfg.targets.length > 0) {
    return cfg.targets.map((t) => ({
      ...t,
      port: t.port || SACN_DEFAULT_PORT,
      ledCount: t.ledCount > 0 ? t.ledCount : Math.max(0, totalLeds - t.ledStart),
      universeStart: t.universeStart || 1,
    }));
  }
  return [{
    id: 'legacy',
    ip: cfg.wledIp,
    port: SACN_DEFAULT_PORT,
    ledStart: 0,
    ledCount: totalLeds,
    universeStart: 1,
  }];
}

/** Write an ACN flags+length pair at `pos` covering `len` bytes. */
function writePdu(pkt: Uint8Array, pos: number, len: number): void {
  pkt[pos] = 0x70 | ((len >> 8) & 0x0f);
  pkt[pos + 1] = len & 0xff;
}
