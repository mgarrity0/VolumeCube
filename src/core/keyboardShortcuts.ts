// Keyboard shortcuts — a single window-level keydown handler that dispatches
// directly against useAppStore.getState(). Each shortcut is declared in the
// SHORTCUTS table so the help overlay can render the exact same list the
// runtime responds to — no drift between docs and behavior.
//
// Design notes:
//  - We skip events whose target is an editable element (input, textarea,
//    contenteditable), so typing a preset name doesn't steer the camera.
//  - Modifier-bearing events (Ctrl/Cmd) are ignored so OS/browser shortcuts
//    (Ctrl+S, Ctrl+R, etc.) keep working.
//  - Shortcut keys are matched by `event.key` (not `code`) so Shift+/ → '?'
//    works across layouts.

import { useEffect } from 'react';
import { useAppStore, StructureMode, CameraPreset } from '../state/store';
import { loadPattern } from './patternRuntime';
import { mergeParamValues } from './patternApi';

type Action = () => void | Promise<void>;

export type Shortcut = {
  keys: string[];            // event.key values that trigger this shortcut
  label: string;             // user-visible key rendering (e.g. "?", "1–4")
  description: string;       // what it does (shown in help overlay)
  group: 'View' | 'Library' | 'Debug' | 'Help';
  run: Action;
};

const MODES: StructureMode[] = ['clean', 'ghost', 'full'];
const PRESETS: CameraPreset[] = ['front', 'side', 'top', 'iso'];

async function reloadActive(): Promise<void> {
  const st = useAppStore.getState();
  const name = st.pattern.active?.name;
  if (!name) return;
  const res = await loadPattern(name);
  if (!res.ok) {
    st.setPatternError(res.error);
    return;
  }
  const prior = st.pattern.paramValues[name] ?? {};
  st.setParamValues(name, mergeParamValues(res.pattern.params, prior));
  st.setActivePattern(res.pattern);
}

async function stepPattern(dir: 1 | -1): Promise<void> {
  const st = useAppStore.getState();
  const list = st.pattern.available;
  if (list.length === 0) return;
  const cur = st.pattern.active?.name;
  const idx = cur ? list.indexOf(cur) : -1;
  const next = list[((idx + dir) + list.length) % list.length];
  const res = await loadPattern(next);
  if (!res.ok) {
    st.setPatternError(res.error);
    return;
  }
  const prior = st.pattern.paramValues[next] ?? {};
  st.setParamValues(next, mergeParamValues(res.pattern.params, prior));
  st.setActivePattern(res.pattern);
}

function cycleStructureMode(): void {
  const st = useAppStore.getState();
  const i = MODES.indexOf(st.structureMode);
  st.setStructureMode(MODES[(i + 1) % MODES.length]);
}

function toggleWiringPath(): void {
  const st = useAppStore.getState();
  st.setShowWiringPath(!st.showWiringPath);
}

function toggleHelp(): void {
  const st = useAppStore.getState();
  st.setShowShortcuts(!st.showShortcuts);
}

function closeHelp(): void {
  useAppStore.getState().setShowShortcuts(false);
}

function setPreset(p: CameraPreset): void {
  useAppStore.getState().setCameraPreset(p);
}

// Exported so the help overlay can render the exact same table we dispatch.
export const SHORTCUTS: Shortcut[] = [
  ...PRESETS.map((p, i): Shortcut => ({
    keys: [String(i + 1)],
    label: String(i + 1),
    description: `Camera: ${p[0].toUpperCase()}${p.slice(1)}`,
    group: 'View',
    run: () => setPreset(p),
  })),
  {
    keys: ['b', 'B'],
    label: 'B',
    description: 'Cycle structure mode (clean → ghost → full)',
    group: 'View',
    run: cycleStructureMode,
  },
  {
    keys: ['w', 'W'],
    label: 'W',
    description: 'Toggle wiring-path overlay',
    group: 'View',
    run: toggleWiringPath,
  },
  {
    keys: ['s', 'S'],
    label: 'S',
    description: 'Save snapshot PNG',
    group: 'View',
    run: () => useAppStore.getState().requestSnapshot(),
  },
  {
    keys: [','],
    label: ',',
    description: 'Previous pattern',
    group: 'Library',
    run: () => stepPattern(-1),
  },
  {
    keys: ['.'],
    label: '.',
    description: 'Next pattern',
    group: 'Library',
    run: () => stepPattern(1),
  },
  {
    keys: ['r', 'R'],
    label: 'R',
    description: 'Reload active pattern',
    group: 'Library',
    run: reloadActive,
  },
  {
    keys: ['?', '/'],
    label: '?',
    description: 'Show this help',
    group: 'Help',
    run: toggleHelp,
  },
  {
    keys: ['Escape'],
    label: 'Esc',
    description: 'Close help overlay',
    group: 'Help',
    run: closeHelp,
  },
];

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

// Pre-index the shortcut table by key for O(1) lookup on every keypress.
const BY_KEY = new Map<string, Shortcut>();
for (const s of SHORTCUTS) {
  for (const k of s.keys) BY_KEY.set(k, s);
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditable(e.target)) return;
      const sc = BY_KEY.get(e.key);
      if (!sc) return;
      e.preventDefault();
      void sc.run();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
