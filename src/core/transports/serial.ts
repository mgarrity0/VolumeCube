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

export class SerialTransport implements Transport {
  readonly name = 'USB Serial';

  async connect(cfg: OutputConfig): Promise<void> {
    if (!cfg.serialPort) throw new Error('Select a COM port first');
    await invoke('serial_open', {
      port: cfg.serialPort,
      baud: cfg.serialBaud,
    });
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
    await invoke('serial_send', { bytes: Array.from(frame) });
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
