import { useEffect } from 'react';
import { useAppStore } from '../state/store';
import { mergeParamValues } from './patternApi';
import {
  debounce,
  getProjectRoot,
  isTauri,
  listPatterns,
  loadPattern,
  onPatternsChanged,
  patternsDirFor,
  startWatching,
} from './patternRuntime';

// Top-level hook: listens to the filesystem watcher, keeps the available
// list + the active module fresh, and re-imports changed files without a
// full app reload.

export function usePatternHost() {
  const setAvailable = useAppStore((s) => s.setAvailablePatterns);
  const setActive = useAppStore((s) => s.setActivePattern);
  const setError = useAppStore((s) => s.setPatternError);
  const setParamValues = useAppStore((s) => s.setParamValues);

  useEffect(() => {
    if (!isTauri()) {
      // Web-only `pnpm dev` mode — no backend; show an empty list.
      setAvailable([]);
      return;
    }

    let alive = true;
    let unlisten: (() => void) | null = null;

    async function activateIfFresh(name: string) {
      const res = await loadPattern(name);
      if (!alive) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const prior = useAppStore.getState().pattern.paramValues[name] ?? {};
      setParamValues(name, mergeParamValues(res.pattern.params, prior));
      setActive(res.pattern);
    }

    async function refreshList() {
      const names = await listPatterns();
      if (!alive) return;
      setAvailable(names);
    }

    const handleChange = debounce(async (_paths: string[]) => {
      await refreshList();
      const active = useAppStore.getState().pattern.active;
      if (!active) return;
      // Always re-import the active module when anything in patterns/
      // changes — simpler than path-matching on Windows vs. posix and
      // cheap enough.
      await activateIfFresh(active.name);
    }, 120);

    (async () => {
      try {
        const root = await getProjectRoot();
        await refreshList();
        await startWatching(patternsDirFor(root));
        unlisten = await onPatternsChanged(handleChange);
      } catch (e) {
        setError(`pattern host init: ${String(e)}`);
      }
    })();

    return () => {
      alive = false;
      if (unlisten) unlisten();
    };
  }, [setAvailable, setActive, setError, setParamValues]);
}
