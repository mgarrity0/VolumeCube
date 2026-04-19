// USB serial transport. Hardware runs the firmware sketch in
// firmware/esp32_serial_receiver/ which parses the exact frame format
// defined below.
//
// Frame format:
//   [0xCC][0xBE]           — magic prefix (sync on loss)
//   [len_hi][len_lo]       — big-endian 16-bit payload byte count
//   [rgb bytes ...]        — stream-ordered RGB (3 × ledCount)
//   [crc_hi][crc_lo]       — CRC-16/CCITT-FALSE over the rgb bytes
//
// Baud default 921600 (~30 fps for a 1000-LED cube). Larger cubes or
// higher frame rates need an ESP32 USB-native build and a MCU-side baud
// that matches — left to the user.

import { invoke } from '@tauri-apps/api/core';
import type { OutputConfig, Transport } from './index';

const MAGIC1 = 0xcc;
const MAGIC2 = 0xbe;
// Status reports the firmware sends back after a CRC mismatch:
// [STAT_MAGIC1][STAT_MAGIC2][count_hi][count_lo].
const STAT_MAGIC1 = 0xfe;
const STAT_MAGIC2 = 0xed;

export class SerialTransport implements Transport {
  readonly name = 'USB Serial';

  // Latest CRC-mismatch count reported by the firmware. Monotonic since
  // device boot (wraps at 65535, which we handle by treating any decrease
  // as a reboot — see updateFromStatus).
  crcMismatches = 0;

  // Rolling byte buffer for status parsing — in case a status frame
  // straddles two `serial_send` return payloads.
  private statusBuf: number[] = [];

  async connect(cfg: OutputConfig): Promise<void> {
    if (!cfg.serialPort) throw new Error('Select a COM port first');
    await invoke('serial_open', {
      port: cfg.serialPort,
      baud: cfg.serialBaud,
    });
    this.crcMismatches = 0;
    this.statusBuf = [];
  }

  async disconnect(): Promise<void> {
    await invoke('serial_close').catch(() => {});
  }

  async sendFrame(streamBytes: Uint8Array, _cfg: OutputConfig): Promise<void> {
    const len = streamBytes.length;
    const frame = new Uint8Array(4 + len + 2);
    frame[0] = MAGIC1;
    frame[1] = MAGIC2;
    frame[2] = (len >>> 8) & 0xff;
    frame[3] = len & 0xff;
    frame.set(streamBytes, 4);
    const crc = crc16Ccitt(streamBytes);
    frame[4 + len + 0] = (crc >>> 8) & 0xff;
    frame[4 + len + 1] = crc & 0xff;
    const reply = await invoke<number[]>('serial_send', { bytes: Array.from(frame) });
    if (reply && reply.length) this.ingestStatus(reply);
  }

  /**
   * Scan `bytes` for status frames [FE ED hi lo] and update the counter.
   * Keeps a trailing partial frame in `statusBuf` so a report split across
   * two `serial_send` calls is still counted correctly.
   */
  private ingestStatus(bytes: number[]): void {
    const buf = this.statusBuf.concat(bytes);
    let i = 0;
    while (i + 3 < buf.length) {
      if (buf[i] === STAT_MAGIC1 && buf[i + 1] === STAT_MAGIC2) {
        // Trust the firmware's cumulative count verbatim. A monotonic
        // decrease just means the device rebooted — we'd rather the UI
        // resync to the fresh value than stay stuck at the stale max.
        this.crcMismatches = (buf[i + 2] << 8) | buf[i + 3];
        i += 4;
      } else {
        i++;
      }
    }
    // Preserve up to 3 unconsumed bytes — enough for a straddling status
    // header — and discard anything older.
    this.statusBuf = buf.slice(Math.max(i, buf.length - 3));
  }
}

// List available COM/tty ports. Used by the OutputPanel dropdown.
export async function listSerialPorts(): Promise<string[]> {
  return await invoke<string[]>('serial_list');
}

/**
 * CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no xorout.
 * Matches the firmware-side implementation byte for byte.
 */
export function crc16Ccitt(data: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let b = 0; b < 8; b++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return crc;
}
