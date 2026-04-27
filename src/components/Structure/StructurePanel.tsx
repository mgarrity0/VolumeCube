import { useAppStore } from '../../state/store';
import { edges, ledCount } from '../../core/cubeGeometry';
import type { ChainStyle, LayerOrder, LayerStart, RowDirection } from '../../core/wiring';

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
        <span>Wiring style</span>
        <select
          value={wiring.chainStyle}
          onChange={(e) => patchWiring({ chainStyle: e.target.value as ChainStyle })}
          title="Panels: Y outermost — strip fills one Nx×Nz layer at a time. Columns: Y innermost — strip walks each (X,Z) column's full height before moving sideways."
        >
          <option value="panels">Panels (Y-slices)</option>
          <option value="columns">Columns (vertical chains)</option>
        </select>
      </div>
      <div className="field">
        <span>{wiring.chainStyle === 'columns' ? 'Column direction' : 'Layer order'}</span>
        <select
          value={wiring.layerOrder}
          onChange={(e) => patchWiring({ layerOrder: e.target.value as LayerOrder })}
          title={
            wiring.chainStyle === 'columns'
              ? 'First column travels bottom-up (start at y=0) or top-down (start at y=Ny-1).'
              : 'Strip enters the bottom (y=0) or top (y=Ny-1) layer first.'
          }
        >
          <option value="bottom-up">Bottom-up</option>
          <option value="top-down">Top-down</option>
        </select>
      </div>
      <div className="field">
        <span>Entry corner</span>
        <select
          value={wiring.layerStart}
          onChange={(e) => patchWiring({ layerStart: e.target.value as LayerStart })}
          title="Which (X, Z) corner the strip enters from."
        >
          <option value="corner-00">Corner (0, 0)</option>
          <option value="corner-N0">Corner (Nx-1, 0)</option>
          <option value="corner-0N">Corner (0, Nz-1)</option>
          <option value="corner-NN">Corner (Nx-1, Nz-1)</option>
        </select>
      </div>
      <div className="field">
        <span>{wiring.chainStyle === 'columns' ? 'Chain columns along' : 'Row direction'}</span>
        <select
          value={wiring.rowDirection}
          onChange={(e) => patchWiring({ rowDirection: e.target.value as RowDirection })}
          title={
            wiring.chainStyle === 'columns'
              ? 'Which axis chains columns first (the column-walk direction).'
              : 'Within a layer, do rows run along X or Z?'
          }
        >
          <option value="x-major">X-major</option>
          <option value="z-major">Z-major</option>
        </select>
      </div>
      <div className="field">
        <span>{wiring.chainStyle === 'columns' ? 'Snake Y (alternate up/down)' : 'Serpentine rows'}</span>
        <input
          type="checkbox"
          checked={wiring.serpentine}
          onChange={(e) => patchWiring({ serpentine: e.target.checked })}
          title={
            wiring.chainStyle === 'columns'
              ? 'ON: flip column direction every other column (snake the strip up-down). OFF: every column starts at the same Y end ("jumps back to top" — your build).'
              : 'Flip the inner row direction every other row.'
          }
        />
      </div>
      <div className="field">
        <span>{wiring.chainStyle === 'columns' ? 'Zigzag column-walk' : 'Serpentine layers'}</span>
        <input
          type="checkbox"
          checked={wiring.layerSerpentine}
          onChange={(e) => patchWiring({ layerSerpentine: e.target.checked })}
          title={
            wiring.chainStyle === 'columns'
              ? 'Flip the column-walk direction every other XZ row.'
              : 'Flip the entry corner every other layer.'
          }
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
