import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../state/store';
import {
  transportManager,
  defaultPortForKind,
  type NetworkTarget,
  type OutputStats,
  type TransportKind,
} from '../../core/transports';
import { listSerialPorts } from '../../core/transports/serial';
import { exportFastLed, estimateExportSize } from '../../core/transports/fastledExport';
import { ledCount } from '../../core/cubeGeometry';

// OutputPanel — choose and connect a transport, export FastLED sketches.
//
// "Connect" flips a persistent transport on (streaming). "Export" is a
// one-shot action — clicking "Bake .ino" freezes the active pattern's
// simulation for N seconds and writes the generated sketch to exports/.
//
// Network transports ('wled', 'sacn') accept multiple controllers via
// the Targets table. Each row carries an IP, port, byte-range owned by
// that controller, and (for sACN) the first universe — successive
// universes pack 170 LEDs each automatically.
//
// Stats (fps, dropped frames, last error) update via a 250ms tick so the
// render loop never has to touch React state.

type PanelKind = TransportKind | 'export';

const KIND_LABEL: Record<PanelKind, string> = {
  off: 'Off',
  wled: 'WLED UDP (DDP)',
  sacn: 'sACN (E1.31)',
  serial: 'USB Serial',
  export: 'FastLED Export',
};

const LEDS_PER_SACN_UNIVERSE = 170;

function newTargetId(): string {
  return `t_${Math.random().toString(36).slice(2, 8)}`;
}

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

  const totalLeds = useMemo(() => ledCount(cube), [cube]);
  const isNetwork = output.kind === 'wled' || output.kind === 'sacn';

  useEffect(() => {
    const id = setInterval(() => {
      const live: OutputStats = { ...transportManager.getStats() };
      const prev = useAppStore.getState().outputStats;
      if (
        prev.fps !== live.fps ||
        prev.droppedFrames !== live.droppedFrames ||
        prev.crcMismatches !== live.crcMismatches ||
        prev.connected !== live.connected ||
        prev.lastError !== live.lastError
      ) {
        setOutputStats(live);
      }
    }, 250);
    return () => clearInterval(id);
  }, [setOutputStats]);

  useEffect(() => {
    if (output.kind === 'serial') refreshPorts();
  }, [output.kind]);

  const refreshPorts = async () => {
    try {
      const p = await listSerialPorts();
      setPorts(p);
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

  // -------- Targets table helpers --------

  const setTargets = (next: NetworkTarget[]) => patchOutput({ targets: next });

  const patchTarget = (id: string, patch: Partial<NetworkTarget>) => {
    setTargets(output.targets.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const addTarget = () => {
    const kind = output.kind as TransportKind;
    const port = defaultPortForKind(kind);
    // Seed new rows so they slot in after the last existing range.
    const last = output.targets[output.targets.length - 1];
    const ledStart = last ? last.ledStart + Math.max(1, last.ledCount) : 0;
    const universeStart = last
      ? last.universeStart + Math.max(1, Math.ceil(Math.max(1, last.ledCount) / LEDS_PER_SACN_UNIVERSE))
      : 1;
    const seedIp = last?.ip ?? output.wledIp;
    setTargets([
      ...output.targets,
      { id: newTargetId(), ip: seedIp, port, ledStart, ledCount: 0, universeStart },
    ]);
  };

  const removeTarget = (id: string) => {
    setTargets(output.targets.filter((t) => t.id !== id));
  };

  /** Evenly split the cube's total LED count across the current rows. */
  const autoSplit = () => {
    if (output.targets.length === 0) return;
    const n = output.targets.length;
    const base = Math.floor(totalLeds / n);
    const remainder = totalLeds - base * n;
    let start = 0;
    let universe = output.targets[0].universeStart || 1;
    const next: NetworkTarget[] = output.targets.map((t, i) => {
      const count = base + (i < remainder ? 1 : 0);
      const row: NetworkTarget = {
        ...t,
        ledStart: start,
        ledCount: count,
        universeStart: universe,
      };
      start += count;
      universe += Math.max(1, Math.ceil(count / LEDS_PER_SACN_UNIVERSE));
      return row;
    });
    setTargets(next);
  };

  // -------- Targets table validation --------

  const validation = useMemo(() => {
    if (output.targets.length === 0) return { warnings: [] as string[], totalCovered: 0 };
    const warnings: string[] = [];
    const sorted = [...output.targets].sort((a, b) => a.ledStart - b.ledStart);
    let covered = 0;
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      const eff = t.ledCount > 0 ? t.ledCount : totalLeds - t.ledStart;
      covered += eff;
      if (i > 0) {
        const prev = sorted[i - 1];
        const prevEnd = prev.ledStart + (prev.ledCount > 0 ? prev.ledCount : totalLeds - prev.ledStart);
        if (t.ledStart < prevEnd) warnings.push(`Targets overlap at LED ${t.ledStart}`);
        if (t.ledStart > prevEnd) warnings.push(`Gap between targets at LED ${prevEnd}..${t.ledStart - 1}`);
      }
      if (t.ledStart + eff > totalLeds) warnings.push(`Target ${t.ip} reaches past LED count (${totalLeds})`);
    }
    if (covered < totalLeds) warnings.push(`Targets cover ${covered} of ${totalLeds} LEDs`);
    return { warnings, totalCovered: covered };
  }, [output.targets, totalLeds]);

  const showConnectButton = isNetwork || output.kind === 'serial';
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
          {(['off', 'wled', 'sacn', 'serial', 'export'] as PanelKind[]).map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
      </div>

      {isNetwork && (
        <>
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
          <TargetsTable
            kind={output.kind as TransportKind}
            targets={output.targets}
            totalLeds={totalLeds}
            onPatch={patchTarget}
            onAdd={addTarget}
            onRemove={removeTarget}
            onAutoSplit={autoSplit}
            warnings={validation.warnings}
          />
          {output.targets.length === 0 && (
            <div className="stat-line" style={{ opacity: 0.7, fontSize: 11 }}>
              No targets configured — will fall back to legacy single-controller send
              to <code>{output.wledIp}:{output.kind === 'sacn' ? 5568 : output.wledPort}</code>.
              Click "Add target" to set up explicit multi-controller routing.
            </div>
          )}
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
              onChange={(e) => patchOutput({ exportPin: Math.max(0, Number(e.target.value) || 16) })}
            />
          </div>
          <div className="stat-line">
            Est. size:{' '}
            <strong>
              {(estimateExportSize(cube, output.exportSeconds, output.exportFps) / 1024).toFixed(0)} KB
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
      {output.kind === 'serial' && stats.connected && (
        <div className="stat-line">
          CRC mismatches (firmware):{' '}
          <strong
            style={{
              color: stats.crcMismatches > 0 ? '#ff9060' : undefined,
            }}
          >
            {stats.crcMismatches}
          </strong>
        </div>
      )}
      {stats.lastError && <div className="library-error">{stats.lastError}</div>}
    </section>
  );
}

// -------- Targets table component --------

function TargetsTable({
  kind,
  targets,
  totalLeds,
  onPatch,
  onAdd,
  onRemove,
  onAutoSplit,
  warnings,
}: {
  kind: TransportKind;
  targets: NetworkTarget[];
  totalLeds: number;
  onPatch: (id: string, patch: Partial<NetworkTarget>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onAutoSplit: () => void;
  warnings: string[];
}) {
  const showUniverse = kind === 'sacn';
  return (
    <div style={{ marginTop: 8, fontSize: 11 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <strong>Targets</strong>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={onAutoSplit} disabled={targets.length < 2} title="Evenly divide the cube's LED count across the configured rows.">
            Auto-split
          </button>
          <button onClick={onAdd}>+ Add</button>
        </div>
      </div>
      {targets.length > 0 && (
        <div style={{ display: 'grid', gap: 2, gridTemplateColumns: showUniverse ? '2.6fr 0.9fr 0.9fr 0.9fr 0.9fr 0.4fr' : '3.2fr 0.9fr 0.9fr 0.9fr 0.4fr' }}>
          <span style={{ opacity: 0.7 }}>IP</span>
          <span style={{ opacity: 0.7 }}>Port</span>
          <span style={{ opacity: 0.7 }}>Start</span>
          <span style={{ opacity: 0.7 }}>Count</span>
          {showUniverse && <span style={{ opacity: 0.7 }}>Univ</span>}
          <span></span>
          {targets.map((t) => (
            <TargetRow
              key={t.id}
              t={t}
              totalLeds={totalLeds}
              showUniverse={showUniverse}
              onPatch={(patch) => onPatch(t.id, patch)}
              onRemove={() => onRemove(t.id)}
            />
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div style={{ marginTop: 6, color: '#ff9060', fontSize: 11 }}>
          {warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function TargetRow({
  t, totalLeds, showUniverse, onPatch, onRemove,
}: {
  t: NetworkTarget;
  totalLeds: number;
  showUniverse: boolean;
  onPatch: (patch: Partial<NetworkTarget>) => void;
  onRemove: () => void;
}) {
  return (
    <>
      <input
        type="text"
        value={t.ip}
        placeholder="192.168.1.x"
        onChange={(e) => onPatch({ ip: e.target.value })}
      />
      <input
        type="number"
        min={1}
        max={65535}
        value={t.port}
        onChange={(e) => onPatch({ port: Number(e.target.value) || 4048 })}
      />
      <input
        type="number"
        min={0}
        max={Math.max(0, totalLeds - 1)}
        value={t.ledStart}
        onChange={(e) => onPatch({ ledStart: Math.max(0, Number(e.target.value) || 0) })}
      />
      <input
        type="number"
        min={0}
        max={totalLeds}
        value={t.ledCount}
        title="0 = all remaining LEDs from Start."
        onChange={(e) => onPatch({ ledCount: Math.max(0, Number(e.target.value) || 0) })}
      />
      {showUniverse && (
        <input
          type="number"
          min={1}
          max={63999}
          value={t.universeStart}
          onChange={(e) => onPatch({ universeStart: Math.max(1, Number(e.target.value) || 1) })}
        />
      )}
      <button onClick={onRemove} title="Remove this target">×</button>
    </>
  );
}
