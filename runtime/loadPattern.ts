// Node-side pattern loader. The desktop app loads patterns via Tauri
// commands and a Blob URL; on Node we just `await import()` the file
// directly off disk.
//
// Why fileURL: dynamic-importing a raw path on Windows fails because
// of the drive-letter colon ("C:\\path") being parsed as a URL scheme.
// pathToFileURL wraps it correctly as "file:///C:/path".

import * as path from 'node:path';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { adaptModule, isPatternModule, type LoadedPattern, type PatternModule } from '../src/core/patternApi';

/**
 * Load a pattern by relative path (e.g. "classics/plasma.js").
 * `patternsRoot` is the absolute path of the patterns/ directory.
 */
export async function loadPatternFromDisk(
  patternsRoot: string,
  relPath: string,
): Promise<LoadedPattern> {
  const fullPath = path.resolve(patternsRoot, relPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Pattern not found: ${fullPath}`);
  }
  // file:// URL so the Node loader accepts it on Windows.
  const fileUrl = pathToFileURL(fullPath).href;
  const mod = (await import(fileUrl)) as PatternModule;
  if (!isPatternModule(mod)) {
    throw new Error(
      `Pattern ${relPath}: module must export a default pattern (function-API or class-API).`,
    );
  }
  return adaptModule(relPath, mod);
}

/** List every .js/.mjs file under patterns/ (relative paths, posix slashes). */
export function listPatternsOnDisk(patternsRoot: string): string[] {
  const out: string[] = [];
  walk(patternsRoot, patternsRoot, out);
  out.sort();
  return out;
}

function walk(base: string, dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(base, full, out);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      const rel = path.relative(base, full).replace(/\\/g, '/');
      out.push(rel);
    }
  }
}
