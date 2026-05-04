import { useMemo } from 'react';
import { useAppStore } from '../../state/store';
import { loadPattern } from '../../core/patternRuntime';
import { mergeParamValues } from '../../core/patternApi';

// Patterns whose visuals depend on a regular (X, Y, Z) integer lattice
// — XZ-layer collapse, Moore-neighborhood neighbors, paddles on Z faces,
// the Hilbert space-filling curve. These are disabled when the cube is
// in Fibonacci mode rather than silently looking weird on non-lattice
// geometry. Other patterns (the spatial / classic majority) only depend
// on cx/cy/cz Euclidean coords and run on either shape.
const LATTICE_ONLY = new Set<string>([
  'classics/pong-3d.js',
  'classics/tetris3d.js',
  'classics/life3d.js',
  'spatial/hilbert-curve.js',
]);

// Groups patterns by their top-level folder (the bit before the first '/').
// Flat files live under 'library'.
type Group = { name: string; files: string[] };

function groupPatterns(names: string[]): Group[] {
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const slash = n.indexOf('/');
    const group = slash === -1 ? 'library' : n.slice(0, slash);
    (groups.get(group) ?? groups.set(group, []).get(group)!).push(n);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, files]) => ({ name, files }));
}

function fileLabel(name: string): string {
  const base = name.split('/').pop() ?? name;
  return base.replace(/\.(mjs|js)$/i, '');
}

export function LibraryPanel() {
  const available = useAppStore((s) => s.pattern.available);
  const active = useAppStore((s) => s.pattern.active);
  const error = useAppStore((s) => s.pattern.error);
  const cubeKind = useAppStore((s) => s.cube.kind);
  const setActive = useAppStore((s) => s.setActivePattern);
  const setError = useAppStore((s) => s.setPatternError);
  const setParamValues = useAppStore((s) => s.setParamValues);

  const groups = useMemo(() => groupPatterns(available), [available]);
  const isDisabled = (name: string) => cubeKind !== 'lattice' && LATTICE_ONLY.has(name);

  const activate = async (name: string) => {
    if (isDisabled(name)) return;
    const res = await loadPattern(name);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const prior = useAppStore.getState().pattern.paramValues[name] ?? {};
    setParamValues(name, mergeParamValues(res.pattern.params, prior));
    setActive(res.pattern);
  };

  const stop = () => {
    setActive(null);
    setError(null);
  };

  return (
    <aside className="library-panel">
      <h2>Library</h2>
      {available.length === 0 ? (
        <p className="library-empty">
          Drop <code>.js</code> files into <code>patterns/</code> (or its
          subfolders) — they'll appear here automatically.
        </p>
      ) : (
        groups.map((g) => (
          <div className="library-group" key={g.name}>
            <div className="library-group-head">{g.name}</div>
            <ul className="library-list">
              {g.files.map((f) => {
                const disabled = isDisabled(f);
                const cls = [
                  active?.name === f ? 'active' : '',
                  disabled ? 'disabled' : '',
                ].filter(Boolean).join(' ');
                return (
                  <li
                    key={f}
                    className={cls}
                    onClick={() => activate(f)}
                    title={disabled ? `${f} — needs lattice geometry` : f}
                    style={disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                  >
                    {fileLabel(f)}
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
      <button className="library-stop" onClick={stop} disabled={!active}>
        Stop
      </button>
      {error && <div className="library-error">{error}</div>}
    </aside>
  );
}
