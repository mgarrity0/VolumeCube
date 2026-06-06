// UDP send injection point.
//
// The DDP and sACN transports share their packet-building logic across
// two environments:
//   • Tauri desktop — uses the bundled `wled_send` Rust command to bind
//     a UdpSocket and send_to(). Picked at module load via dynamic
//     import so this file can also be consumed by a pure-Node runtime
//     that has no Tauri at all.
//   • Node runtime (NUC streamer) — passes a sender backed by Node's
//     `dgram` module. See runtime/nodeUdpSender.ts.
//
// Tests can inject their own mock sender to assert on exact bytes
// without touching the network OR the Tauri mock.

export type UdpSender = (ip: string, port: number, bytes: Uint8Array) => Promise<void>;

// Lazy-resolved Tauri sender. Imported on first use so a Node process
// that never instantiates a transport with the default sender doesn't
// crash trying to load @tauri-apps/api/core.
let _tauriInvoke: ((cmd: string, args: any) => Promise<any>) | null = null;

async function tauriUdpSender(ip: string, port: number, bytes: Uint8Array): Promise<void> {
  if (!_tauriInvoke) {
    const mod = await import('@tauri-apps/api/core');
    _tauriInvoke = mod.invoke;
  }
  await _tauriInvoke('wled_send', { ip, port, bytes: Array.from(bytes) });
}

/** Default sender — uses Tauri's wled_send. Override per-transport via the constructor. */
export function defaultUdpSender(): UdpSender {
  return tauriUdpSender;
}
