import { useAppStore } from '../../state/store';
import { edges, ledCount } from '../../core/cubeGeometry';
import type { LayerOrder, LayerStart, RowDirection } from '../../core/wiring';

// StructurePanel covers both the physical dimensions (Nx/Ny/Nz, pitch)
// and the wiring order the LED data stream follows through the cube.
// Wiring settings feed the address map used by the transports and the
// wiring-path overlay.

const MIN_N = 1;
const MAX_N = 64;

function clampN(v: number): number {
  return Math.max(MIN_N, Math.min(MAX_N, Math.round(Number.isFinite(v) ? v : MIN_N)));
}

export function StructurePanel() {
  const cube = useAppStore((s) => s.cube);
  const patch = useAppStore((s) => s.patchCube);
  const wiring = useAppStore((s) => s.wiring);
  const patchWiring = useAppStore((s) => s.patchWiring);
  const showWiringPath = useAppStore((s) => s.showWiringPath);
  const setShowWiringPath = useAppStore((s) => s.setShowWiringPath);

  const e = edges(cube);

  return (
    <section className="panel-section">
      <h2>Structure</h2>
      <div className="field">
        <span>X (width)</span>
        <input
          type="number"
          min={MIN_N}
          max={MAX_N}
          step={1}
          value={cube.Nx}
          onChange={(e) => patch({ Nx: clampN(Number(e.target.value)) })}
        />
      </div>
      <div className="field">
        <span>Y (height)</span>
        <input
          type="number"
          min={MIN_N}
          max={MAX_N}
          step={1}
          value={cube.Ny}
          onChange={(e) => patch({ Ny: clampN(Number(e.target.value)) })}
        />
      </div>
      <div className="field">
        <span>Z (depth / panels)</span>
        <input
          type="number"
          min={MIN_N}
          max={MAX_N}
          step={1}
          value={cube.Nz}
          onChange={(e) => patch({ Nz: clampN(Number(e.target.value)) })}
        />
      </div>
      <div className="field">
        <span>LED pitch (m)</span>
        <input
          type="number"
          min={0.005}
          max={1}
          step={0.001}
          value={cube.pitchMeters}
          onChange={(ev) => {
            const v = Math.max(0.005, Math.min(1, Number(ev.target.value) || 0.005));
            patch({ pitchMeters: v });
          }}
        />
      </div>
      <div className="stat-line">
        Edge: <strong>{e.x.toFixed(2)} × {e.y.toFixed(2)} × {e.z.toFixed(2)} m</strong>
      </div>
      <div className="stat-line">
        Total LEDs: <strong>{ledCount(cube).toLocaleString()}</strong>
      </div>

      <h3>Wiring</h3>
      <div className="field">
        <span>Layer order</span>
        <select
          value={wiring.layerOrder}
          onChange={(e) => patchWiring({ layerOrder: e.target.value as LayerOrder })}
        >
          <option value="bottom-up">Bottom-up</option>
          <option value="top-down">Top-down</option>
        </select>
      </div>
      <div className="field">
        <span>Layer start</span>
        <select
          value={wiring.layerStart}
          onChange={(e) => patchWiring({ layerStart: e.target.value as LayerStart })}
        >
          <option value="corner-00">Corner (0, 0)</option>
          <option value="corner-N0">Corner (Nx-1, 0)</option>
          <option value="corner-0N">Corner (0, Nz-1)</option>
          <option value="corner-NN">Corner (Nx-1, Nz-1)</option>
        </select>
      </div>
      <div className="field">
        <span>Row direction</span>
        <select
          value={wiring.rowDirection}
          onChange={(e) => patchWiring({ rowDirection: e.target.value as RowDirection })}
        >
          <option value="x-major">X-major</option>
          <option value="z-major">Z-major</option>
        </select>
      </div>
      <div className="field">
        <span>Serpentine rows</span>
        <input
          type="checkbox"
          checked={wiring.serpentine}
          onChange={(e) => patchWiring({ serpentine: e.target.checked })}
        />
      </div>
      <div className="field">
        <span>Serpentine layers</span>
        <input
          type="checkbox"
          checked={wiring.layerSerpentine}
          onChange={(e) => patchWiring({ layerSerpentine: e.target.checked })}
        />
      </div>
      <div className="field">
        <span>Show wiring path</span>
        <input
          type="checkbox"
          checked={showWiringPath}
          onChange={(e) => setShowWiringPath(e.target.checked)}
        />
      </div>
    </section>
  );
}
