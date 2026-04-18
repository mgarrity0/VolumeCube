import { useAppStore } from '../../state/store';
import { ledCount } from '../../core/cubeGeometry';
import type { LayerOrder, LayerStart, RowDirection } from '../../core/wiring';

// StructurePanel covers both the physical dimensions (N, edge length)
// and the wiring order the LED data stream follows through the cube.
// Wiring settings feed the address map used by the transports and the
// wiring-path overlay (Phase 5).

export function StructurePanel() {
  const cube = useAppStore((s) => s.cube);
  const patch = useAppStore((s) => s.patchCube);
  const wiring = useAppStore((s) => s.wiring);
  const patchWiring = useAppStore((s) => s.patchWiring);
  const showWiringPath = useAppStore((s) => s.showWiringPath);
  const setShowWiringPath = useAppStore((s) => s.setShowWiringPath);

  const N = cube.N;
  const edge = cube.edgeMeters;

  return (
    <section className="panel-section">
      <h2>Structure</h2>
      <div className="field">
        <span>Cube size N</span>
        <input
          type="number"
          min={2}
          max={32}
          step={1}
          value={N}
          onChange={(e) => {
            const v = Math.max(2, Math.min(32, Number(e.target.value) || 2));
            patch({ N: v });
          }}
        />
      </div>
      <div className="field">
        <span>Edge length (m)</span>
        <input
          type="number"
          min={0.1}
          max={10}
          step={0.01}
          value={edge}
          onChange={(e) => {
            const v = Math.max(0.1, Math.min(10, Number(e.target.value) || 0.1));
            patch({ edgeMeters: v });
          }}
        />
      </div>
      <div className="field">
        <span>Layers</span>
        <input type="number" value={N} readOnly />
      </div>
      <div className="field">
        <span>LEDs per row</span>
        <input type="number" value={N} readOnly />
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
          <option value="corner-N0">Corner (N-1, 0)</option>
          <option value="corner-0N">Corner (0, N-1)</option>
          <option value="corner-NN">Corner (N-1, N-1)</option>
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
