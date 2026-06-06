// Node-side UDP sender — backs the WLED/sACN transports with Node's
// built-in `dgram` module instead of Tauri's bundled UdpSocket. One
// long-lived socket is bound at startup and reused for every send.
//
// The socket binds to 0.0.0.0:0 (ephemeral OS-assigned port) just like
// the Tauri Rust side; we don't care which source port we send from.

import * as dgram from 'node:dgram';
import type { UdpSender } from '../src/core/transports/udpSender';

let _socket: dgram.Socket | null = null;

function getSocket(): dgram.Socket {
  if (_socket) return _socket;
  const sock = dgram.createSocket('udp4');
  // Bind explicitly so the OS picks an ephemeral source port up-front;
  // first send_to() otherwise lazy-binds and the first packet has a
  // measurable latency hiccup.
  sock.bind(0);
  _socket = sock;
  return sock;
}

export function nodeUdpSender(): UdpSender {
  return (ip: string, port: number, bytes: Uint8Array): Promise<void> => {
    const sock = getSocket();
    // Node's dgram.send takes a Buffer or array of Buffers. A Uint8Array
    // works directly (Buffer is a subclass) but we convert explicitly
    // to avoid TS friction.
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return new Promise((resolve, reject) => {
      sock.send(buf, port, ip, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };
}

/** Close the singleton socket — call on graceful shutdown. */
export function closeUdpSocket(): void {
  if (_socket) {
    _socket.close();
    _socket = null;
  }
}
