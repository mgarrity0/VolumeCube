// Transport abstraction + module-level singleton manager.
//
// "Transport" = anything that eats a stream-ordered Uint8 buffer per
// frame and ships it to hardware. Current implementations:
//   - wledUdp  : DDP over UDP to a WLED-firmware ESP32
//   - serial   : framed custom protocol over USB serial to FastLED firmware
//
// FastLED Export is *not* a Transport — it's a one-shot bake action
// invoked from the OutputPanel.
//
// The manager lives outside Zustand (module singleton) so Cube.tsx's
// useFrame can call `tryTrySend()` without subscribing to React state.
// Connection + config changes go through Zustand so the UI stays reactive.

export type TransportKind = 'off' | 'wled' | 'serial';

export type OutputConfig = {
  kind: TransportKind | 'export';
  wledIp: string;
  wledPort: number;
  wledTimeoutSecs: number;
  serialPort: string;
  serialBaud: number;
  exportSeconds: number;
  exportFps: number;
  exportPin: number;
  sendIntervalMs: number;
};

export const defaultOutputConfig: OutputConfig = {
  kind: 'off',
  wledIp: '192.168.1.100',
  wledPort: 4048, // DDP port
  wledTimeoutSecs: 2,
  serialPort: '',
  serialBaud: 921600,
  exportSeconds: 5,
  exportFps: 30,
  exportPin: 6,
  sendIntervalMs: 20, // 50 fps cap
};

export type OutputStats = {
  fps: number;
  droppedFrames: number;
  // Cumulative CRC mismatches reported by the firmware (serial transport
  // only). Stays at 0 for transports that don't report status back.
  crcMismatches: number;
  connected: boolean;
  lastError: string | null;
};

export const defaultOutputStats: OutputStats = {
  fps: 0,
  droppedFrames: 0,
  crcMismatches: 0,
  connected: false,
  lastError: null,
};

export interface Transport {
  readonly name: string;
  connect(cfg: OutputConfig): Promise<void>;
  disconnect(): Promise<void>;
  sendFrame(streamBytes: Uint8Array, cfg: OutputConfig): Promise<void>;
}

import { WledUdpTransport } from './wledUdp';
import { SerialTransport } from './serial';

type Listener = (stats: OutputStats) => void;

class TransportManager {
  private current: Transport | null = null;
  private listeners: Set<Listener> = new Set();
  private stats: OutputStats = { ...defaultOutputStats };

  // Rate-limit state.
  private lastSendAt = 0;
  // Rolling fps window.
  private sendTimes: number[] = [];

  get connected(): boolean {
    return this.stats.connected;
  }

  getStats(): OutputStats {
    // Let the current transport refresh its own stat fields (e.g. serial
    // CRC mismatches come out of firmware status frames parsed per send).
    if (this.current instanceof SerialTransport) {
      this.stats.crcMismatches = this.current.crcMismatches;
    }
    return this.stats;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.stats);
  }

  private setStats(patch: Partial<OutputStats>) {
    this.stats = { ...this.stats, ...patch };
    this.emit();
  }

  async connect(kind: TransportKind, cfg: OutputConfig): Promise<void> {
    await this.disconnect();
    if (kind === 'off') {
      this.setStats({ connected: false, lastError: null });
      return;
    }
    const t = kind === 'wled' ? new WledUdpTransport() : new SerialTransport();
    try {
      await t.connect(cfg);
    } catch (e: any) {
      this.setStats({ connected: false, lastError: e?.message ?? String(e) });
      throw e;
    }
    this.current = t;
    this.sendTimes = [];
    this.setStats({
      connected: true,
      lastError: null,
      droppedFrames: 0,
      crcMismatches: 0,
    });
  }

  async disconnect(): Promise<void> {
    if (this.current) {
      try {
        await this.current.disconnect();
      } catch {
        /* best-effort */
      }
    }
    this.current = null;
    this.setStats({ connected: false });
  }

  /**
   * Call from the render loop with the latest stream-ordered RGB bytes.
   * Returns true if a frame was queued for sending, false if rate-limited
   * or disconnected. Errors are swallowed after being recorded in stats
   * so a transient network blip doesn't crash the render loop.
   */
  trySend(streamBytes: Uint8Array, cfg: OutputConfig): boolean {
    if (!this.current || !this.stats.connected) return false;
    const now = performance.now();
    if (now - this.lastSendAt < cfg.sendIntervalMs) return false;
    this.lastSendAt = now;

    // fps window: keep timestamps in the last second.
    this.sendTimes.push(now);
    const cutoff = now - 1000;
    while (this.sendTimes.length && this.sendTimes[0] < cutoff) this.sendTimes.shift();
    this.stats.fps = this.sendTimes.length;

    const transport = this.current;
    transport.sendFrame(streamBytes, cfg).catch((e: any) => {
      this.setStats({
        droppedFrames: this.stats.droppedFrames + 1,
        lastError: e?.message ?? String(e),
      });
    });
    // Don't spam the emitter for fps changes — UI polls stats separately.
    return true;
  }
}

export const transportManager = new TransportManager();
