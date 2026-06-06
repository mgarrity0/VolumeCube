import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../state/store';
import {
  transportManager,
  defaultPortForKind,
  autoLayoutDigOcta,
  DIG_OCTA_PINS,
  DIG_OCTA_LABELS,
  type ExportBoard,
  type ExportOutput,
  type NetworkTarget,
  type OutputStats,
  type TransportKind,
} from '../../core/transports';
import { listSerialPorts } from '../../core/transports/serial';
import { exportFastLed, estimateExportSize, estimateBoardSize } from '../../core/transports/fastledExport';
import { bakeForSdCard, estimateBinSize } from '../../core/transports/sdCardExport';
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
  // SD-card mode: which patterns to include in the bake. Defaults to
  // every pattern in the library when the user switches to this mode.
  const availablePatterns = useAppStore((s) => s.pattern.available);
  const allParamValues = useAppStore((s) => s.pattern.paramValues);
  const [sdPickedPatterns, setSdPickedPatterns] = useState<Set<string>>(new Set());

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
    if (output.exportMode === 'sd-card') {
      return onExportSdCard();
    }
    if (!pattern) {
      setExportStatus('Load a pattern first.');
      return;
    }
    setBusy(true);
    setExportStatus('Baking…');
    try {
      const multi = output.exportMode === 'multi-board' && output.exportBoards.length > 0;
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
          sketchStem: pattern.displayName,
          ...(multi
            ? { boards: output.exportBoards }
            : { dataPin: output.exportPin }),
        },
      });
      if (res.paths.length === 1) {
        setExportStatus(`Wrote ${res.frames} frames (${res.sizeKb} KB) → ${res.paths[0]}`);
      } else {
        setExportStatus(
          `Wrote ${res.paths.length} sketches × ${res.frames} frames (${res.sizeKb} KB total)\n${res.paths.join('\n')}`,
        );
      }
    } catch (e: any) {
      setExportStatus('Error: ' + (e?.message ?? String(e)));
    } finally {
      setBusy(false);
    }
  };

  const onExportSdCard = async () => {
    const picks = Array.from(sdPickedPatterns);
    if (picks.length === 0) {
      setExportStatus('Pick at least one pattern to bake.');
      return;
    }
    if (output.exportBoards.length === 0) {
      setExportStatus('Configure a board layout first (auto-fit in the table above).');
      return;
    }
    setBusy(true);
    setExportStatus('Baking SD-card layout…');
    try {
      const res = await bakeForSdCard(
        {
          patternNames: picks,
          cube,
          wiring,
          color,
          power,
          boards: output.exportBoards,
          paramValues: allParamValues,
          seconds: output.exportSeconds,
          fps: output.exportFps,
        },
        (msg) => setExportStatus(`Baking SD-card layout… ${msg}`),
      );
      const lines: string[] = [
        `Wrote ${res.patternsBaked} patterns × ${output.exportBoards.length} boards (${res.totalSizeKb} KB total)`,
        `Folder: exports/${res.baseDir}/`,
        ...(res.errors.length ? [`Errors:`, ...res.errors.map((e) => `  ${e}`)] : []),
      ];
      setExportStatus(lines.join('\n'));
    } catch (e: any) {
      setExportStatus('Error: ' + (e?.message ?? String(e)));
    } finally {
      setBusy(false);
    }
  };

  // -------- Multi-board (FastLED export) helpers --------

  const switchExportMode = (mode: 'single-pin' | 'multi-board' | 'sd-card') => {
    if (mode === output.exportMode) return;
    if ((mode === 'multi-board' || mode === 'sd-card') && output.exportBoards.length === 0) {
      // Seed with the user's standard build: 2 Dig-Octa boards, 5 outputs
      // each. They can tweak per-output afterwards.
      const totalLeds = ledCount(cube);
      patchOutput({
        exportMode: mode,
        exportBoards: autoLayoutDigOcta(totalLeds, 2, 5),
      });
    } else {
      patchOutput({ exportMode: mode });
    }
    // First time entering sd-card mode: pre-select all available patterns
    // so the user can bake the whole library by default.
    if (mode === 'sd-card' && sdPickedPatterns.size === 0) {
      setSdPickedPatterns(new Set(availablePatterns));
    }
  };

  const refitBoards = (boards: number, outputsPerBoard: number) => {
    const totalLeds = ledCount(cube);
    patchOutput({
      exportBoards: autoLayoutDigOcta(totalLeds, boards, outputsPerBoard),
    });
  };

  const patchBoard = (boardId: string, patch: Partial<ExportBoard>) => {
    patchOutput({
      exportBoards: output.exportBoards.map((b) => (b.id === boardId ? { ...b, ...patch } : b)),
    });
  };

  const patchBoardOutput = (boardId: string, idx: number, patch: Partial<ExportOutput>) => {
    patchOutput({
      exportBoards: output.exportBoards.map((b) => {
        if (b.id !== boardId) return b;
        const outputs = b.outputs.map((o, i) => (i === idx ? { ...o, ...patch } : o));
        return { ...b, outputs };
      }),
    });
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
            <span>Mode</span>
            <select
              value={output.exportMode}
              onChange={(e) => switchExportMode(e.target.value as 'single-pin' | 'multi-board' | 'sd-card')}
              title="Single pin: one sketch driving one GPIO. Multi-board: one sketch per board with multiple outputs. SD card: bake N patterns × M boards as .bin files for the player firmware to load from microSD."
            >
              <option value="single-pin">Single pin (one sketch)</option>
              <option value="multi-board">Multi-board (Dig-Octa)</option>
              <option value="sd-card">SD card (multi-board, multi-pattern)</option>
            </select>
          </div>

          {output.exportMode === 'single-pin' && (
            <>
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
            </>
          )}

          {(output.exportMode === 'multi-board' || output.exportMode === 'sd-card') && (
            <MultiBoardEditor
              boards={output.exportBoards}
              totalLeds={ledCount(cube)}
              seconds={output.exportSeconds}
              fps={output.exportFps}
              onPatchBoard={patchBoard}
              onPatchOutput={patchBoardOutput}
              onRefit={refitBoards}
            />
          )}

          {output.exportMode === 'sd-card' && (
            <SdCardPatternPicker
              available={availablePatterns}
              picked={sdPickedPatterns}
              onTogglePattern={(name) => {
                const next = new Set(sdPickedPatterns);
                if (next.has(name)) next.delete(name);
                else next.add(name);
                setSdPickedPatterns(next);
              }}
              onSelectAll={() => setSdPickedPatterns(new Set(availablePatterns))}
              onSelectNone={() => setSdPickedPatterns(new Set())}
              perPatternKb={Math.round(
                estimateBinSize(
                  output.exportBoards[0]?.ledCount ?? 0,
                  output.exportSeconds,
                  output.exportFps,
                ) / 1024,
              )}
            />
          )}

          <button
            onClick={onExport}
            disabled={
              busy ||
              (output.exportMode === 'sd-card'
                ? sdPickedPatterns.size === 0 || output.exportBoards.length === 0
                : !pattern)
            }
            style={{ marginTop: 8, width: '100%' }}
          >
            {busy
              ? 'Baking…'
              : output.exportMode === 'sd-card'
              ? `Bake ${sdPickedPatterns.size} patterns × ${output.exportBoards.length} boards`
              : output.exportMode === 'multi-board' && output.exportBoards.length > 0
              ? `Bake ${output.exportBoards.length} .ino files`
              : 'Bake .ino'}
          </button>
          {exportStatus && (
            <div
              className="stat-line"
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, whiteSpace: 'pre-wrap' }}
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

// -------- SD-card pattern picker --------
//
// Multi-select list of every available pattern. Checking a pattern
// includes it in the bake — each checked pattern becomes one .bin per
// board in the SD-card export.

function SdCardPatternPicker({
  available,
  picked,
  onTogglePattern,
  onSelectAll,
  onSelectNone,
  perPatternKb,
}: {
  available: string[];
  picked: Set<string>;
  onTogglePattern: (name: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  perPatternKb: number;
}) {
  const totalKb = perPatternKb * picked.size;
  return (
    <div style={{ marginTop: 8, fontSize: 11 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <strong>Patterns to bake ({picked.size}/{available.length})</strong>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={onSelectAll}>All</button>
          <button onClick={onSelectNone}>None</button>
        </div>
      </div>
      <div
        style={{
          maxHeight: 200,
          overflowY: 'auto',
          border: '1px solid #2a3a70',
          borderRadius: 4,
          padding: 4,
        }}
      >
        {available.map((name) => (
          <label
            key={name}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px' }}
          >
            <input
              type="checkbox"
              checked={picked.has(name)}
              onChange={() => onTogglePattern(name)}
            />
            <span>{name.replace(/\.(js|mjs)$/, '')}</span>
          </label>
        ))}
        {available.length === 0 && (
          <div style={{ opacity: 0.6 }}>No patterns found. Add files to patterns/ first.</div>
        )}
      </div>
      <div className="stat-line" style={{ marginTop: 4 }}>
        Per-pattern size (per board): <strong>~{perPatternKb} KB</strong> ·
        Total: <strong>~{totalKb.toLocaleString()} KB</strong> per board
      </div>
    </div>
  );
}

// -------- Multi-board (FastLED export) editor --------

function MultiBoardEditor({
  boards,
  totalLeds,
  seconds,
  fps,
  onPatchBoard,
  onPatchOutput,
  onRefit,
}: {
  boards: ExportBoard[];
  totalLeds: number;
  seconds: number;
  fps: number;
  onPatchBoard: (boardId: string, patch: Partial<ExportBoard>) => void;
  onPatchOutput: (boardId: string, idx: number, patch: Partial<ExportOutput>) => void;
  onRefit: (boards: number, outputsPerBoard: number) => void;
}) {
  const [refitBoards, setRefitBoards] = useState(boards.length || 2);
  const [refitOutputs, setRefitOutputs] = useState(boards[0]?.outputs.length || 5);

  const totalCovered = boards.reduce((a, b) => a + b.ledCount, 0);
  const coverageWarning = totalCovered !== totalLeds
    ? `Boards cover ${totalCovered} of ${totalLeds} LEDs`
    : null;

  return (
    <div style={{ marginTop: 6, fontSize: 11 }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
        <strong style={{ flex: 1 }}>Layout</strong>
        <span style={{ opacity: 0.7 }}>Boards</span>
        <input
          type="number"
          min={1}
          max={8}
          style={{ width: 40 }}
          value={refitBoards}
          onChange={(e) => setRefitBoards(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
        />
        <span style={{ opacity: 0.7 }}>× Outputs</span>
        <input
          type="number"
          min={1}
          max={8}
          style={{ width: 40 }}
          value={refitOutputs}
          onChange={(e) => setRefitOutputs(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
        />
        <button onClick={() => onRefit(refitBoards, refitOutputs)} title="Auto-fit cube LED count across this many boards × outputs, using Dig-Octa pin map.">
          Auto-fit
        </button>
      </div>

      {boards.map((b) => (
        <BoardCard
          key={b.id}
          board={b}
          seconds={seconds}
          fps={fps}
          onPatchBoard={onPatchBoard}
          onPatchOutput={onPatchOutput}
        />
      ))}

      {coverageWarning && (
        <div style={{ marginTop: 6, color: '#ff9060', fontSize: 11 }}>
          ⚠ {coverageWarning}
        </div>
      )}
      <div style={{ marginTop: 4, opacity: 0.7, fontSize: 10 }}>
        Dig-Octa pin map (Q1..Q8): {DIG_OCTA_PINS.map((p, i) => `${DIG_OCTA_LABELS[i]}=${p}`).join(', ')}
      </div>
    </div>
  );
}

function BoardCard({
  board,
  seconds,
  fps,
  onPatchBoard,
  onPatchOutput,
}: {
  board: ExportBoard;
  seconds: number;
  fps: number;
  onPatchBoard: (boardId: string, patch: Partial<ExportBoard>) => void;
  onPatchOutput: (boardId: string, idx: number, patch: Partial<ExportOutput>) => void;
}) {
  const sizeKb = estimateBoardSize(board, seconds, fps) / 1024;
  return (
    <div style={{ border: '1px solid #2a3a70', borderRadius: 4, padding: 6, marginBottom: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <input
          type="text"
          value={board.name}
          onChange={(e) => onPatchBoard(board.id, { name: e.target.value })}
          style={{ fontWeight: 600, flex: 1 }}
        />
        <span style={{ opacity: 0.7 }}>
          LEDs {board.ledStart}..{board.ledStart + board.ledCount - 1} · {sizeKb.toFixed(0)} KB
        </span>
      </div>
      <div style={{ display: 'grid', gap: 2, gridTemplateColumns: '0.7fr 0.7fr 0.9fr 0.9fr' }}>
        <span style={{ opacity: 0.6 }}>Label</span>
        <span style={{ opacity: 0.6 }}>Pin</span>
        <span style={{ opacity: 0.6 }}>Start</span>
        <span style={{ opacity: 0.6 }}>Count</span>
        {board.outputs.map((o, i) => (
          <OutputRow
            key={i}
            o={o}
            onPatch={(patch) => onPatchOutput(board.id, i, patch)}
          />
        ))}
      </div>
    </div>
  );
}

function OutputRow({ o, onPatch }: { o: ExportOutput; onPatch: (patch: Partial<ExportOutput>) => void }) {
  return (
    <>
      <input
        type="text"
        value={o.label ?? ''}
        placeholder="Q1"
        onChange={(e) => onPatch({ label: e.target.value })}
      />
      <input
        type="number"
        min={0}
        max={48}
        value={o.pin}
        onChange={(e) => onPatch({ pin: Math.max(0, Number(e.target.value) || 0) })}
      />
      <input
        type="number"
        min={0}
        value={o.ledStart}
        onChange={(e) => onPatch({ ledStart: Math.max(0, Number(e.target.value) || 0) })}
      />
      <input
        type="number"
        min={0}
        value={o.ledCount}
        onChange={(e) => onPatch({ ledCount: Math.max(0, Number(e.target.value) || 0) })}
      />
    </>
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
