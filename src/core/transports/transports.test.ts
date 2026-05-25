import { describe, it, expect, vi, beforeEach } from 'vitest';

// Both transports go through Tauri's invoke('wled_send', { ip, port, bytes }),
// so we mock the whole @tauri-apps/api/core module and capture every send.
// That gives us exact-byte assertions without touching the network and
// lets us verify multi-target / multi-universe behaviour deterministically.

type Sent = { ip: string; port: number; bytes: Uint8Array };
const sent: Sent[] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (_cmd: string, args: any) => {
    sent.push({
      ip: args.ip,
      port: args.port,
      bytes: new Uint8Array(args.bytes),
    });
  }),
}));

beforeEach(() => {
  sent.length = 0;
});

import { WledUdpTransport } from './wledUdp';
import { SacnTransport } from './sacn';
import { defaultOutputConfig, type NetworkTarget } from './index';

function makeCfg(targets: NetworkTarget[]) {
  return { ...defaultOutputConfig, kind: 'wled' as const, targets };
}

function streamOf(leds: number): Uint8Array {
  // Distinguishable per-LED bytes so we can verify slicing.
  const b = new Uint8Array(leds * 3);
  for (let i = 0; i < leds; i++) {
    b[i * 3 + 0] = (i + 1) & 0xff;
    b[i * 3 + 1] = ((i + 1) >> 8) & 0xff;
    b[i * 3 + 2] = 0x55;
  }
  return b;
}

describe('WLED DDP — single target legacy fallback', () => {
  it('synthesizes a single target from wledIp/wledPort when targets is empty', async () => {
    const transport = new WledUdpTransport();
    const stream = streamOf(100);
    await transport.sendFrame(stream, { ...defaultOutputConfig, kind: 'wled' });
    expect(sent.length).toBe(1);
    expect(sent[0].ip).toBe(defaultOutputConfig.wledIp);
    expect(sent[0].port).toBe(defaultOutputConfig.wledPort);
    // PUSH bit should be set on the lone packet of the lone target.
    expect(sent[0].bytes[0]).toBe(0x41);
    // Payload length matches the stream.
    expect(sent[0].bytes.length).toBe(10 + stream.length);
  });
});

describe('WLED DDP — multi-target with PUSH sync', () => {
  it('emits one packet per target, with PUSH only on the last', async () => {
    const transport = new WledUdpTransport();
    const stream = streamOf(1000); // 500 LEDs × 2 controllers
    const cfg = makeCfg([
      { id: 'a', ip: '10.0.0.10', port: 4048, ledStart: 0,   ledCount: 500, universeStart: 1 },
      { id: 'b', ip: '10.0.0.11', port: 4048, ledStart: 500, ledCount: 500, universeStart: 4 },
    ]);
    await transport.sendFrame(stream, cfg);

    // 500 LEDs × 3 = 1500 bytes — fits in two DDP packets (MAX_PAYLOAD 1440).
    // So we expect 2 fragments per target = 4 sends total.
    expect(sent.length).toBe(4);
    // Order: A frag 1 (no push), A frag 2 (no push), B frag 1 (no push), B frag 2 (PUSH).
    expect(sent[0].ip).toBe('10.0.0.10');
    expect(sent[1].ip).toBe('10.0.0.10');
    expect(sent[2].ip).toBe('10.0.0.11');
    expect(sent[3].ip).toBe('10.0.0.11');
    expect(sent[0].bytes[0]).toBe(0x40);
    expect(sent[1].bytes[0]).toBe(0x40);
    expect(sent[2].bytes[0]).toBe(0x40);
    expect(sent[3].bytes[0]).toBe(0x41); // only the final packet pushes
  });

  it("each controller's DDP offset starts at zero (local buffer), not the stream-global offset", async () => {
    const transport = new WledUdpTransport();
    const stream = streamOf(20); // 60 bytes — single packet per target
    const cfg = makeCfg([
      { id: 'a', ip: '10.0.0.10', port: 4048, ledStart: 0,  ledCount: 10, universeStart: 1 },
      { id: 'b', ip: '10.0.0.11', port: 4048, ledStart: 10, ledCount: 10, universeStart: 2 },
    ]);
    await transport.sendFrame(stream, cfg);
    expect(sent.length).toBe(2);
    // DDP offset = bytes[4..7] big-endian. Both should be zero.
    for (const s of sent) {
      const off = (s.bytes[4] << 24) | (s.bytes[5] << 16) | (s.bytes[6] << 8) | s.bytes[7];
      expect(off).toBe(0);
    }
    // Payload bytes verify the slice: target A → LEDs 1..10, target B → LEDs 11..20.
    expect(sent[0].bytes[10]).toBe(1);   // first LED of stream
    expect(sent[1].bytes[10]).toBe(11);  // first LED of target B's slice
  });

  it('fragments a single huge target across multiple packets', async () => {
    const transport = new WledUdpTransport();
    // 600 LEDs × 3 = 1800 bytes → 2 fragments (1440 + 360).
    const stream = streamOf(600);
    const cfg = makeCfg([
      { id: 'a', ip: '10.0.0.10', port: 4048, ledStart: 0, ledCount: 600, universeStart: 1 },
    ]);
    await transport.sendFrame(stream, cfg);
    expect(sent.length).toBe(2);
    expect(sent[0].bytes[0]).toBe(0x40); // first fragment, no push
    expect(sent[1].bytes[0]).toBe(0x41); // second fragment, push
    // Second fragment's offset should be 1440 bytes into the local buffer.
    const off1 = (sent[1].bytes[4] << 24) | (sent[1].bytes[5] << 16) | (sent[1].bytes[6] << 8) | sent[1].bytes[7];
    expect(off1).toBe(1440);
  });
});

describe('sACN — packet structure', () => {
  function parseHeader(bytes: Uint8Array) {
    return {
      preamble: (bytes[0] << 8) | bytes[1],
      pid: String.fromCharCode(...bytes.subarray(4, 16)).replace(/\0+$/, ''),
      rootVector: (bytes[18] << 24) | (bytes[19] << 16) | (bytes[20] << 8) | bytes[21],
      framingVector: (bytes[40] << 24) | (bytes[41] << 16) | (bytes[42] << 8) | bytes[43],
      sourceName: String.fromCharCode(...bytes.subarray(44, 44 + 64)).replace(/\0+$/, ''),
      priority: bytes[108],
      syncUniverse: (bytes[109] << 8) | bytes[110],
      seq: bytes[111],
      universe: (bytes[113] << 8) | bytes[114],
      dmpVector: bytes[117],
      valueCount: (bytes[123] << 8) | bytes[124],
      startCode: bytes[125],
    };
  }

  it('builds a valid E1.31 packet with the right vectors and universe', async () => {
    const transport = new SacnTransport();
    const stream = streamOf(100);
    const cfg = makeCfg([
      { id: 'a', ip: '10.0.0.10', port: 5568, ledStart: 0, ledCount: 100, universeStart: 7 },
    ]);
    await transport.sendFrame(stream, cfg);
    expect(sent.length).toBe(1);
    const h = parseHeader(sent[0].bytes);
    expect(h.preamble).toBe(0x0010);
    expect(h.pid).toBe('ASC-E1.17');
    expect(h.rootVector).toBe(0x00000004);
    expect(h.framingVector).toBe(0x00000002);
    expect(h.sourceName).toBe('VolumeCube');
    expect(h.priority).toBe(100);
    expect(h.universe).toBe(7);
    expect(h.dmpVector).toBe(0x02);
    expect(h.startCode).toBe(0x00);
    // 100 LEDs × 3 = 300 channels; value count = 300 + 1 for the start code.
    expect(h.valueCount).toBe(301);
  });

  it('splits a 500-LED target across 3 universes (170, 170, 160)', async () => {
    const transport = new SacnTransport();
    const stream = streamOf(500);
    const cfg = makeCfg([
      { id: 'a', ip: '10.0.0.10', port: 5568, ledStart: 0, ledCount: 500, universeStart: 1 },
    ]);
    await transport.sendFrame(stream, cfg);
    expect(sent.length).toBe(3);
    const universes = sent.map((s) => (s.bytes[113] << 8) | s.bytes[114]);
    expect(universes).toEqual([1, 2, 3]);
    // Channel counts: first two are 510 (170 LEDs × 3), last is 160 × 3 = 480.
    const counts = sent.map((s) => (s.bytes[123] << 8) | s.bytes[124]);
    expect(counts).toEqual([511, 511, 481]); // +1 each for start code
  });

  it('per-universe sequence number increments independently', async () => {
    const transport = new SacnTransport();
    const stream = streamOf(340); // exactly 2 universes
    const cfg = makeCfg([
      { id: 'a', ip: '10.0.0.10', port: 5568, ledStart: 0, ledCount: 340, universeStart: 1 },
    ]);
    await transport.sendFrame(stream, cfg);
    await transport.sendFrame(stream, cfg);
    // 4 packets: u=1 seq=0, u=2 seq=0, u=1 seq=1, u=2 seq=1
    expect(sent.length).toBe(4);
    expect(sent[0].bytes[111]).toBe(0);
    expect(sent[1].bytes[111]).toBe(0);
    expect(sent[2].bytes[111]).toBe(1);
    expect(sent[3].bytes[111]).toBe(1);
  });

  it('routes each target to its own IP with its own universe range', async () => {
    const transport = new SacnTransport();
    const stream = streamOf(1000);
    const cfg = makeCfg([
      { id: 'a', ip: '10.0.0.10', port: 5568, ledStart: 0,   ledCount: 500, universeStart: 1 },
      { id: 'b', ip: '10.0.0.11', port: 5568, ledStart: 500, ledCount: 500, universeStart: 10 },
    ]);
    await transport.sendFrame(stream, cfg);
    // 500 LEDs each → 3 universes each → 6 packets total.
    expect(sent.length).toBe(6);
    expect(sent.slice(0, 3).every((s) => s.ip === '10.0.0.10')).toBe(true);
    expect(sent.slice(3, 6).every((s) => s.ip === '10.0.0.11')).toBe(true);
    expect(sent.slice(0, 3).map((s) => (s.bytes[113] << 8) | s.bytes[114])).toEqual([1, 2, 3]);
    expect(sent.slice(3, 6).map((s) => (s.bytes[113] << 8) | s.bytes[114])).toEqual([10, 11, 12]);
  });
});
