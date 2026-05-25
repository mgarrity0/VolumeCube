// Transport abstraction + module-level singleton manager.
//
// "Transport" = anything that eats a stream-ordered Uint8 buffer per
// frame and ships it to hardware. Current implementations:
//   - wledUdp  : DDP over UDP. Multi-target capable — the stream byte
//                range is sliced per controller and a PUSH-only-on-the-
//                last-packet pattern syncs both ends of the seam.
//   - sacn     : E1.31 / sACN over UDP. Multi-target × multi-universe;
//                unicast per controller. The pro-AV path for when
//                TouchDesigner / xLights / Resolume need to talk to
//                the same rig.
//   - serial   : framed custom protocol over USB serial to FastLED firmware
//
// FastLED Export is *not* a Transport — it's a one-shot bake action
// invoked from the OutputPanel.
//
// The manager lives outside Zustand (module singleton) so Cube.tsx's
// useFrame can call `trySend()` without subscribing to React state.
// Connection + config changes go through Zustand so the UI stays reactive.

export type TransportKind = 'off' | 'wled' | 'sacn' | 'serial';

/**
 * One physical controller in the LED network. The byte range that this
 * target receives is [ledStart*3 ... (ledStart+ledCount)*3), taken
 * straight out of the stream-ordered buffer.
 *
 * `universeStart` is the first sACN universe this target listens to.
 * Subsequent universes are universeStart, universeStart+1, … packed
 * 170 RGB LEDs each. WLED's default is universe 1 → output 0, so
 * 1/4/7/… is the typical sequence per controller.
 *
 * Ignored by DDP (it just streams bytes to the controller's local
 * buffer starting at offset 0).
 */
export type NetworkTarget = {
  id: string;
  ip: string;
  port: number;       // DDP: 4048; sACN: 5568
  ledStart: number;
  ledCount: number;
  universeStart: number;
};

export type OutputConfig = {
  kind: TransportKind | 'export';
  // Multi-target network controllers (used by 'wled' and 'sacn'). If
  // the list is empty, the network transports synthesize a single
  // target from wledIp/wledPort below for backwards compatibility with
  // single-controller setups.
  targets: NetworkTarget[];
  wledIp: string;
  wledPort: number;
  wledTimeoutSecs: number;
  serialPort: string;
  serialBaud: number;
  exportSeconds: number;
  exportFps: number;
  // Legacy single-pin field (kept for backwards compat with saved configs).
  exportPin: number;
  // 'single-pin' = old one-sketch-one-output behavior.
  // 'multi-board' = bake one sketch per board, each with multiple
  //                 FastLED outputs driving the configured pin map.
  exportMode: ExportMode;
  exportBoards: ExportBoard[];
  sendIntervalMs: number;
};

export const defaultOutputConfig: OutputConfig = {
  kind: 'off',
  targets: [],
  wledIp: '192.168.1.100',
  wledPort: 4048, // DDP port
  wledTimeoutSecs: 2,
  serialPort: '',
  serialBaud: 921600,
  exportSeconds: 5,
  exportFps: 30,
  // Default to GPIO 16 — the QuinLED Dig-Quad's Q1 output. Other common
  // ESP32 LED pins: 2 (most dev boards), 18, 19. Override per project.
  exportPin: 16,
  exportMode: 'single-pin',
  exportBoards: [],
  sendIntervalMs: 20, // 50 fps cap
};

/**
 * Auto-populate an exportBoards layout for a given LED count, board
 * count, and outputs-per-board. Assumes the Dig-Octa pin map and an
 * even split — caller can tweak per-output afterwards.
 */
export function autoLayoutDigOcta(
  totalLeds: number,
  boards: number,
  outputsPerBoard: number,
  pinMap: readonly number[] = DIG_OCTA_PINS,
  labels: readonly string[] = DIG_OCTA_LABELS,
): ExportBoard[] {
  const totalOutputs = boards * outputsPerBoard;
  if (totalOutputs === 0) return [];
  const ledsPerOutput = Math.floor(totalLeds / totalOutputs);
  const remainder = totalLeds - ledsPerOutput * totalOutputs;
  const out: ExportBoard[] = [];
  let cursor = 0;
  let outIdx = 0;
  for (let b = 0; b < boards; b++) {
    const id = String.fromCharCode(65 + b); // "A", "B", "C", …
    const outputs: ExportOutput[] = [];
    const boardStart = cursor;
    for (let o = 0; o < outputsPerBoard; o++) {
      const extra = outIdx < remainder ? 1 : 0;
      const count = ledsPerOutput + extra;
      outputs.push({
        pin: pinMap[o] ?? pinMap[pinMap.length - 1],
        ledStart: cursor - boardStart,
        ledCount: count,
        label: labels[o] ?? `O${o + 1}`,
      });
      cursor += count;
      outIdx++;
    }
    out.push({
      id,
      name: `Board ${id}`,
      ledStart: boardStart,
      ledCount: cursor - boardStart,
      outputs,
    });
  }
  return out;
}

/** Default port per protocol. Used by the UI when adding a new target row. */
export function defaultPortForKind(kind: TransportKind): number {
  if (kind === 'sacn') return 5568;
  return 4048; // DDP default
}

// -------- Multi-board FastLED export --------
//
// For builds that need more outputs than a single ESP32 GPIO (e.g.
// QuinLED Dig-Octa Brainboard with 8 outputs, two boards networked
// together for a 10-panel cube), the exporter bakes ONE sketch per
// board, each with multiple FastLED.addLeds<>() calls — one per output
// pin pointing at the right slice of that board's local CRGB buffer.

export type ExportOutput = {
  /** GPIO number for this output channel. */
  pin: number;
  /** First LED in this output's chain (stream-order, board-relative). */
  ledStart: number;
  /** Number of LEDs on this output. */
  ledCount: number;
  /** Optional label shown in the UI / sketch comments (e.g. "Q1"). */
  label?: string;
};

export type ExportBoard = {
  id: string;          // stable UI key, also used in the output filename
  /** Human-readable label, e.g. "Board A". */
  name: string;
  /** First LED owned by this board in the stream-order buffer. */
  ledStart: number;
  /** Number of LEDs owned by this board. */
  ledCount: number;
  outputs: ExportOutput[];
};

// QuinLED-Dig-Octa Brainboard 32-8L pin map. Outputs Q1..Q8 → these
// GPIOs in order. Q2/Q3 reuse the bootloader UART pins which the
// Brainboard breaks out as data outputs — safe because the bootloader
// is only active during flashing.
export const DIG_OCTA_PINS: readonly number[] = [16, 3, 1, 17, 19, 22, 21, 18];
export const DIG_OCTA_LABELS: readonly string[] = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8'];

export type ExportMode = 'single-pin' | 'multi-board';

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
import { SacnTransport } from './sacn';

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
    const t =
      kind === 'wled' ? new WledUdpTransport() :
      kind === 'sacn' ? new SacnTransport() :
      new SerialTransport();
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
