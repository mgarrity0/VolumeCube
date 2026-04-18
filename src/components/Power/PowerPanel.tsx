import { useAppStore } from '../../state/store';
import { fmtAmps, fmtWatts, type PowerMode } from '../../core/power';

// Power panel — configuration on top, live readouts below.
//
// The readouts tint red when `overBudget` is true. In auto-dim mode the
// reported amps/watts are post-ABL (what the strip actually draws), so
// the numbers plateau at budgetAmps when the limiter is active — that's
// the correct behavior: ABL kept the PSU safe.

const MODES: { value: PowerMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'warn', label: 'Warn' },
  { value: 'auto-dim', label: 'Auto-dim (ABL)' },
];

export function PowerPanel() {
  const power = useAppStore((s) => s.power);
  const live = useAppStore((s) => s.powerLive);
  const patch = useAppStore((s) => s.patchPower);

  const overBudget = power.mode !== 'off' && live.overBudget;
  const ablActive = power.mode === 'auto-dim' && live.scale < 1;

  return (
    <section className="panel-section">
      <h2>Power</h2>
      <div className="field">
        <span>Mode</span>
        <select
          value={power.mode}
          onChange={(e) => patch({ mode: e.target.value as PowerMode })}
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <span>Budget (A)</span>
        <input
          type="number"
          min={0}
          max={500}
          step={0.5}
          value={power.budgetAmps}
          onChange={(e) =>
            patch({ budgetAmps: Math.max(0, Number(e.target.value) || 0) })
          }
        />
      </div>
      <div className="field">
        <span>Voltage (V)</span>
        <input
          type="number"
          min={3}
          max={48}
          step={0.1}
          value={power.voltage}
          onChange={(e) =>
            patch({ voltage: Math.max(3, Number(e.target.value) || 12) })
          }
        />
      </div>
      <div className="field">
        <span>mA / channel</span>
        <input
          type="number"
          min={1}
          max={100}
          step={0.5}
          value={power.mAPerChannel}
          onChange={(e) =>
            patch({ mAPerChannel: Math.max(1, Number(e.target.value) || 20) })
          }
        />
      </div>
      <div className={'power-readout' + (overBudget ? ' over' : '')}>
        <div>Amps<strong>{fmtAmps(live.amps)}</strong></div>
        <div>Watts<strong>{fmtWatts(live.watts)}</strong></div>
      </div>
      {ablActive && (
        <div className="stat-line">
          ABL active — scale <strong>{(live.scale * 100).toFixed(0)}%</strong>
        </div>
      )}
    </section>
  );
}
