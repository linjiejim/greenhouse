/**
 * Remove every generated frontend artifact. Vite's outDir is the repository-root
 * public/ directory (not tracked by git; static assets come from apps/web/public),
 * so a stale hashed bundle would otherwise be served next to the fresh one.
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const publicDir = resolve(import.meta.dirname, '..', 'public');
if (basename(publicDir) !== 'public') {
  throw new Error(`Refusing to clean unexpected output directory: ${publicDir}`);
}

// Nothing to clean on a fresh checkout or inside a Docker build, where the
// directory has never been created — vite makes it on the way out.
if (existsSync(publicDir)) {
  for (const entry of readdirSync(publicDir, { withFileTypes: true })) {
    rmSync(resolve(publicDir, entry.name), { recursive: true, force: true });
  }
}
