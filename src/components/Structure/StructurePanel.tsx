import { useAppStore } from '../../state/store';
import {
  edges,
  ledCount,
  discRadius,
  DEFAULT_LATTICE_CUBE,
  DEFAULT_FIBONACCI_CUBE,
  type CubeSpec,
} from '../../core/cubeGeometry';
import type { ChainStyle, LayerOrder, LayerStart, RowDirection } from '../../core/wiring';

// StructurePanel covers the geometry of the LED rig and (in lattice
// mode) the wiring topology. Two top-level shapes:
//
//   Lattice   — Nx × Ny × Nz integer grid with configurable wiring.
//   Fibonacci — Vogel-spiral disc of N nodes with K LEDs hanging from
//               each node. Wiring is fixed (down each strand, jump to
//               top of next spiral position) so the wiring config is
//               hidden in this mode.

const MIN_N = 1;
const MAX_N = 64;
const MIN_FIB_N = 1;
const MAX_FIB_N = 1024;
const MIN_STRAND = 1;
const MAX_STRAND = 256;

function clampN(v: number): number {
  return Math.max(MIN_N, Math.min(MAX_N, Math.round(Number.isFinite(v) ? v : MIN_N)));
}

function clampFibN(v: number): number {
  return Math.max(MIN_FIB_N, Math.min(MAX_FIB_N, Math.round(Number.isFinite(v) ? v : MIN_FIB_N)));
}

function clampStrand(v: number): number {
  return Math.max(MIN_STRAND, Math.min(MAX_STRAND, Math.round(Number.isFinite(v) ? v : MIN_STRAND)));
}

// Kept in sync with LibraryPanel.tsx.
const LATTICE_ONLY = new Set<string>([
  'classics/pong-3d.js',
  'classics/tetris3d.js',
  'classics/life3d.js',
  'spatial/hilbert-curve.js',
]);

export function StructurePanel() {
  const cube = useAppStore((s) => s.cube);
  const setCube = useAppStore((s) => s.setCube);
  const patch = useAppStore((s) => s.patchCube);
  const wiring = useAppStore((s) => s.wiring);
  const patchWiring = useAppStore((s) => s.patchWiring);
  const showWiringPath = useAppStore((s) => s.showWiringPath);
  const setShowWiringPath = useAppStore((s) => s.setShowWiringPath);
  const activePattern = useAppStore((s) => s.pattern.active);
  const setActivePattern = useAppStore((s) => s.setActivePattern);

  const e = edges(cube);
  const total = ledCount(cube);

  // Mode switch resets to that mode's defaults — easier to reason about
  // than carrying both partial states forward, and the user can save
  // presets if they want to bounce back and forth. We also clear any
  // active lattice-only pattern so the cube doesn't render garbage on
  // the new geometry.
  const onModeChange = (next: 'lattice' | 'fibonacci') => {
    if (next === cube.kind) return;
    setCube(next === 'lattice' ? { ...DEFAULT_LATTICE_CUBE } : { ...DEFAULT_FIBONACCI_CUBE });
    if (next === 'fibonacci' && activePattern && LATTICE_ONLY.has(activePattern.name)) {
      setActivePattern(null);
    }
  };

  return (
    <section className="panel-section">
      <h2>Structure</h2>
      <div className="field">
        <span>Layout</span>
        <select
          value={cube.kind}
          onChange={(ev) => onModeChange(ev.target.value as 'lattice' | 'fibonacci')}
          title="Lattice: Nx×Ny×Nz integer voxel grid. Fibonacci: Vogel-spiral disc with hanging strands of LEDs."
        >
          <option value="lattice">Lattice (cube)</option>
          <option value="fibonacci">Fibonacci spiral</option>
        </select>
      </div>

      {cube.kind === 'lattice' && <LatticeFields cube={cube} patch={patch} />}
      {cube.kind === 'fibonacci' && <FibonacciFields cube={cube} patch={patch} />}

      <div className="stat-line">
        Bounds: <strong>{e.x.toFixed(2)} × {e.y.toFixed(2)} × {e.z.toFixed(2)} m</strong>
      </div>
      <div className="stat-line">
        Total LEDs: <strong>{total.toLocaleString()}</strong>
      </div>

      {cube.kind === 'lattice' ? (
        <>
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
        </>
      ) : (
        <div className="stat-line" style={{ marginTop: 6 }}>
          Wiring: <strong>spiral × strand (fixed)</strong>
          <div style={{ opacity: 0.7, fontSize: 11 }}>
            Strip enters at the disc center, walks down strand 0, jumps to the top of strand 1, etc.
          </div>
        </div>
      )}

      <div className="field" style={{ marginTop: 8 }}>
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

function LatticeFields({
  cube,
  patch,
}: {
  cube: Extract<CubeSpec, { kind: 'lattice' }>;
  patch: (p: Record<string, unknown>) => void;
}) {
  return (
    <>
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
    </>
  );
}

function FibonacciFields({
  cube,
  patch,
}: {
  cube: Extract<CubeSpec, { kind: 'fibonacci' }>;
  patch: (p: Record<string, unknown>) => void;
}) {
  const radius = discRadius(cube);
  return (
    <>
      <div className="field">
        <span>Spiral nodes (N)</span>
        <input
          type="number"
          min={MIN_FIB_N}
          max={MAX_FIB_N}
          step={1}
          value={cube.spiralCount}
          onChange={(e) => patch({ spiralCount: clampFibN(Number(e.target.value)) })}
          title="Number of LEDs in the disc spiral (one strand hangs from each)."
        />
      </div>
      <div className="field">
        <span>Min disc spacing (m)</span>
        <input
          type="number"
          min={0.005}
          max={1}
          step={0.001}
          value={cube.minSpacing}
          onChange={(ev) => {
            const v = Math.max(0.005, Math.min(1, Number(ev.target.value) || 0.005));
            patch({ minSpacing: v });
          }}
          title="Vogel constant c — disc radius is c·√(N-1). Smaller = denser disc."
        />
      </div>
      <div className="field">
        <span>Strand length (K)</span>
        <input
          type="number"
          min={MIN_STRAND}
          max={MAX_STRAND}
          step={1}
          value={cube.strandLength}
          onChange={(e) => patch({ strandLength: clampStrand(Number(e.target.value)) })}
          title="LEDs per hanging strand."
        />
      </div>
      <div className="field">
        <span>Strand spacing (m)</span>
        <input
          type="number"
          min={0.005}
          max={1}
          step={0.001}
          value={cube.strandSpacing}
          onChange={(ev) => {
            const v = Math.max(0.005, Math.min(1, Number(ev.target.value) || 0.005));
            patch({ strandSpacing: v });
          }}
          title='"Hanging density" — vertical pitch between LEDs in a strand.'
        />
      </div>
      <div className="stat-line">
        Disc radius: <strong>{radius.toFixed(3)} m</strong>
      </div>
    </>
  );
}
