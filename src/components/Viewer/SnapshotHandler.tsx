import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../../state/store';

// Sits inside the R3F <Canvas> and watches useAppStore().snapshotToken.
// When it ticks, we grab the canvas pixels directly. The Canvas is
// configured with preserveDrawingBuffer: true so toDataURL always sees
// a fully rendered frame including EffectComposer post-processing.

function isTauri(): boolean {
  return typeof (window as any).__TAURI_INTERNALS__ !== 'undefined'
    || typeof (window as any).__TAURI__ !== 'undefined';
}

function timestampName(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `cube-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`
  );
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.split(',', 2)[1] ?? '';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function persistPng(bytes: Uint8Array): Promise<string | null> {
  if (!isTauri()) {
    // Browser-only fallback: trigger a download via a temporary anchor.
    const blob = new Blob([bytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = timestampName();
    a.click();
    URL.revokeObjectURL(url);
    return null;
  }

  // Default to exports/snapshots/<timestamp>.png so repeated snapshots
  // pile up without nagging the user for a location each time.
  const chosen = await saveDialog({
    defaultPath: `snapshots/${timestampName()}`,
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (!chosen) return null;

  return await invoke<string>('snapshot_write', {
    absPath: chosen,
    bytes: Array.from(bytes),
  });
}

export function SnapshotHandler() {
  const token = useAppStore((s) => s.snapshotToken);
  const { gl } = useThree();

  useEffect(() => {
    if (token === 0) return;
    // Small RAF defer so the click that bumped the token doesn't race the
    // render — the frame after the click has already committed by the
    // time this callback runs.
    const id = requestAnimationFrame(() => {
      const dataUrl = gl.domElement.toDataURL('image/png');
      const bytes = dataUrlToBytes(dataUrl);
      void persistPng(bytes).catch((e) => {
        console.error('snapshot failed', e);
      });
    });
    return () => cancelAnimationFrame(id);
  }, [token, gl]);

  return null;
}
