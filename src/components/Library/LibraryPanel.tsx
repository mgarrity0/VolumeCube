import { useMemo } from 'react';
import { useAppStore } from '../../state/store';
import { loadPattern } from '../../core/patternRuntime';
import { mergeParamValues } from '../../core/patternApi';

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
  const setActive = useAppStore((s) => s.setActivePattern);
  const setError = useAppStore((s) => s.setPatternError);
  const setParamValues = useAppStore((s) => s.setParamValues);

  const groups = useMemo(() => groupPatterns(available), [available]);

  const activate = async (name: string) => {
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
              {g.files.map((f) => (
                <li
                  key={f}
                  className={active?.name === f ? 'active' : ''}
                  onClick={() => activate(f)}
                  title={f}
                >
                  {fileLabel(f)}
                </li>
              ))}
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
