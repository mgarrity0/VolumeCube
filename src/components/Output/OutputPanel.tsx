import { useEffect, useState } from 'react';
import { useAppStore } from '../../state/store';
import {
  transportManager,
  type OutputStats,
  type TransportKind,
} from '../../core/transports';
import { listSerialPorts } from '../../core/transports/serial';
import { exportFastLed, estimateExportSize } from '../../core/transports/fastledExport';

// OutputPanel — choose and connect a transport, export FastLED sketches.
//
// "Connect" flips a persistent transport on (streaming). "Export" is a
// one-shot action — clicking "Bake .ino" freezes the active pattern's
// simulation for N seconds and writes the generated sketch to exports/.
//
// Stats (fps, dropped frames, last error) update via a 250ms tick so the
// render loop never has to touch React state.

type PanelKind = TransportKind | 'export';

const KIND_LABEL: Record<PanelKind, string> = {
  off: 'Off',
  wled: 'WLED UDP (DDP)',
  serial: 'USB Serial',
  export: 'FastLED Export',
};

export function OutputPanel() {
  const output = useAppStore((s) => s.output);
  const stats = useAppStore((s) => s.outputStats);
  const patchOutput = useAppStore((s) => s.patchOutput);
  const setOutputStats = useAppStore((s) => s.setOutputStats);

  const pattern = useAppStore((s) => s.pattern.active);
  const paramValues = useAppStore((s) =>
    pattern ? s.pattern.paramValues[pattern.name] : undefined,
  );
  const cube = useAppStore((s) => s.cube);
  const color = useAppStore((s) => s.color);
  const power = useAppStore((s) => s.power);
  const wiring = useAppStore((s) => s.wiring);

  const [ports, setPorts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  // Poll transport stats into Zustand on a slow tick — the render loop
  // updates manager-local stats, but React only re-renders this panel
  // when the store changes, so we snapshot-copy here.
  useEffect(() => {
    const id = setInterval(() => {
      const live: OutputStats = { ...transportManager.getStats() };
      const prev = useAppStore.getState().outputStats;
      if (
        prev.fps !== live.fps ||
        prev.droppedFrames !== live.droppedFrames ||
        prev.connected !== live.connected ||
        prev.lastError !== live.lastError
      ) {
        setOutputStats(live);
      }
    }, 250);
    return () => clearInterval(id);
  }, [setOutputStats]);

  // Keep the serial-port dropdown fresh when the user switches to the
  // serial mode, and via a refresh button they can click anytime.
  useEffect(() => {
    if (output.kind === 'serial') refreshPorts();
  }, [output.kind]);

  const refreshPorts = async () => {
    try {
      const p = await listSerialPorts();
      setPorts(p);
      // Read current state here (not the closed-over value) so the first
      // effect-triggered refresh after mount doesn't race the first render.
      const currentPort = useAppStore.getState().output.serialPort;
      if (p.length && !currentPort) patchOutput({ serialPort: p[0] });
    } catch (e: any) {
      setOutputStats({ ...stats, lastError: e?.message ?? String(e) });
    }
  };

  const onConnect = async () => {
    setBusy(true);
    try {
      if (output.kind === 'off' || output.kind === 'export') {
        await transportManager.disconnect();
        return;
      }
      await transportManager.connect(output.kind as TransportKind, output);
    } catch (e: any) {
      setOutputStats({ ...stats, connected: false, lastError: e?.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    setBusy(true);
    try {
      await transportManager.disconnect();
    } finally {
      setBusy(false);
    }
  };

  const onExport = async () => {
    if (!pattern) {
      setExportStatus('Load a pattern first.');
      return;
    }
    setBusy(true);
    setExportStatus('Baking…');
    try {
      const res = await exportFastLed({
        pattern,
        paramValues: paramValues ?? {},
        cube,
        color,
        power,
        wiring,
        options: {
          seconds: output.exportSeconds,
          fps: output.exportFps,
          dataPin: output.exportPin,
          sketchStem: pattern.displayName,
        },
      });
      setExportStatus(`Wrote ${res.frames} frames (${res.sizeKb} KB) → ${res.path}`);
    } catch (e: any) {
      setExportStatus('Error: ' + (e?.message ?? String(e)));
    } finally {
      setBusy(false);
    }
  };

  const showConnectButton = output.kind === 'wled' || output.kind === 'serial';
  const connectLabel = stats.connected ? 'Disconnect' : 'Connect';

  return (
    <section className="panel-section">
      <h2>Output</h2>
      <div className="field">
        <span>Transport</span>
        <select
          value={output.kind}
          onChange={(e) => patchOutput({ kind: e.target.value as PanelKind })}
        >
          {(['off', 'wled', 'serial', 'export'] as PanelKind[]).map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
      </div>

      {output.kind === 'wled' && (
        <>
          <div className="field">
            <span>IP</span>
            <input
              type="text"
              value={output.wledIp}
              onChange={(e) => patchOutput({ wledIp: e.target.value })}
            />
          </div>
          <div className="field">
            <span>Port</span>
            <input
              type="number"
              min={1}
              max={65535}
              value={output.wledPort}
              onChange={(e) => patchOutput({ wledPort: Number(e.target.value) || 4048 })}
            />
          </div>
          <div className="field">
            <span>Send every (ms)</span>
            <input
              type="number"
              min={5}
              max={200}
              step={1}
              value={output.sendIntervalMs}
              onChange={(e) => patchOutput({ sendIntervalMs: Math.max(5, Number(e.target.value) || 20) })}
            />
          </div>
        </>
      )}

      {output.kind === 'serial' && (
        <>
          <div className="field">
            <span>COM port</span>
            <select
              value={output.serialPort}
              onChange={(e) => patchOutput({ serialPort: e.target.value })}
            >
              {ports.length === 0 && <option value="">(no ports)</option>}
              {ports.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <span>Baud</span>
            <select
              value={output.serialBaud}
              onChange={(e) => patchOutput({ serialBaud: Number(e.target.value) })}
            >
              {[115200, 230400, 460800, 921600, 2000000].map((b) => (
                <option key={b} value={b}>{b.toLocaleString()}</option>
              ))}
            </select>
          </div>
          <button onClick={refreshPorts} disabled={busy} style={{ marginBottom: 8 }}>
            Rescan ports
          </button>
        </>
      )}

      {output.kind === 'export' && (
        <>
          <div className="field">
            <span>Seconds</span>
            <input
              type="number"
              min={1}
              max={60}
              step={1}
              value={output.exportSeconds}
              onChange={(e) => patchOutput({ exportSeconds: Math.max(1, Number(e.target.value) || 5) })}
            />
          </div>
          <div className="field">
            <span>FPS</span>
            <input
              type="number"
              min={5}
              max={60}
              step={1}
              value={output.exportFps}
              onChange={(e) => patchOutput({ exportFps: Math.max(5, Number(e.target.value) || 30) })}
            />
          </div>
          <div className="field">
            <span>Data pin</span>
            <input
              type="number"
              min={0}
              max={48}
              step={1}
              value={output.exportPin}
              onChange={(e) => patchOutput({ exportPin: Math.max(0, Number(e.target.value) || 6) })}
            />
          </div>
          <div className="stat-line">
            Est. size:{' '}
            <strong>
              {(estimateExportSize(cube.N, output.exportSeconds, output.exportFps) / 1024).toFixed(0)} KB
            </strong>
          </div>
          <button
            onClick={onExport}
            disabled={busy || !pattern}
            style={{ marginTop: 8, width: '100%' }}
          >
            {busy ? 'Baking…' : 'Bake .ino'}
          </button>
          {exportStatus && (
            <div
              className="stat-line"
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 }}
            >
              {exportStatus}
            </div>
          )}
        </>
      )}

      {showConnectButton && (
        <button
          onClick={stats.connected ? onDisconnect : onConnect}
          disabled={busy}
          className={stats.connected ? 'active' : ''}
          style={{ marginTop: 8, width: '100%' }}
        >
          {busy ? '…' : connectLabel}
        </button>
      )}

      {(stats.connected || stats.fps > 0) && (
        <div className="power-readout" style={{ marginTop: 10 }}>
          <div>FPS<strong>{stats.fps}</strong></div>
          <div>Dropped<strong>{stats.droppedFrames}</strong></div>
        </div>
      )}
      {stats.lastError && <div className="library-error">{stats.lastError}</div>}
    </section>
  );
}
