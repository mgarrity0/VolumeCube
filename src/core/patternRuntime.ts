// Pattern loader + hot-reload wiring (adapted from Orbiter).
//
// Flow:
//   1. Rust side `list_patterns` enumerates {project_root}/patterns/**/*.{js,mjs}.
//   2. Rust side `read_pattern` returns file text.
//   3. We wrap the text in a Blob, create an object URL, and dynamic-import
//      that URL. Each reload gets a fresh URL so module caching never bites.
//   4. Rust side `watch_patterns_dir` emits `patterns-changed` events via
//      notify::RecommendedWatcher. We debounce 120ms and re-run list + reload.

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { adaptModule, isPatternModule, LoadedPattern, PatternModule } from './patternApi';

export type LoadResult =
  | { ok: true; pattern: LoadedPattern; source: string }
  | { ok: false; error: string };

export async function listPatterns(): Promise<string[]> {
  try {
    return await invoke<string[]>('list_patterns');
  } catch (e) {
    console.error('list_patterns failed', e);
    return [];
  }
}

export async function readPatternSource(name: string): Promise<string> {
  return await invoke<string>('read_pattern', { name });
}

export async function loadPattern(name: string): Promise<LoadResult> {
  let source: string;
  try {
    source = await readPatternSource(name);
  } catch (e) {
    return { ok: false, error: `read ${name}: ${String(e)}` };
  }

  const blob = new Blob([source], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    const mod = (await import(/* @vite-ignore */ url)) as PatternModule;
    if (!isPatternModule(mod)) {
      return {
        ok: false,
        error: `${name}: module must export a default pattern (object with render(ctx,xyz) or a class with render(ctx,out))`,
      };
    }
    const loaded = adaptModule(name, mod);
    return { ok: true, pattern: loaded, source };
  } catch (e) {
    return { ok: false, error: `${name}: ${String(e)}` };
  } finally {
    // The module is fully resolved and held by the JS engine; revoking
    // the URL frees the Blob without affecting the import.
    URL.revokeObjectURL(url);
  }
}

export async function startWatching(patternsDir: string): Promise<void> {
  await invoke('watch_patterns_dir', { path: patternsDir });
}

export async function onPatternsChanged(
  handler: (paths: string[]) => void,
): Promise<UnlistenFn> {
  return await listen<{ kind: string; paths: string[] }>(
    'patterns-changed',
    (ev) => {
      handler(ev.payload.paths ?? []);
    },
  );
}

export async function getProjectRoot(): Promise<string> {
  return await invoke<string>('project_root');
}

export function patternsDirFor(projectRoot: string): string {
  const sep = projectRoot.includes('\\') ? '\\' : '/';
  return projectRoot.endsWith(sep)
    ? `${projectRoot}patterns`
    : `${projectRoot}${sep}patterns`;
}

// ---- Debouncer helper for the file-change handler ----
export function debounce<T extends any[]>(fn: (...args: T) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: T) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}

// Detect whether the Tauri IPC is available. When the app is served with
// `vite` alone (no Tauri shell), invoke() is unavailable — we fall back to
// an empty pattern list rather than crashing.
export function isTauri(): boolean {
  return typeof (window as any).__TAURI_INTERNALS__ !== 'undefined'
    || typeof (window as any).__TAURI__ !== 'undefined';
}
