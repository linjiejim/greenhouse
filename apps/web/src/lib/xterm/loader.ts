/**
 * Lazy loader for xterm.js (the Bots computer's terminal).
 *
 * Only members who open the Terminal tab need it, so — like noVNC, chart.js
 * and mermaid — it is never part of the main bundle: the first call imports
 * the library, its fit addon and its stylesheet; later calls reuse the same
 * promise. A failed import (offline, stale deploy) clears the cache so the
 * next attempt retries instead of failing forever.
 */

import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

export interface XtermModules {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
}

let pending: Promise<XtermModules> | null = null;

/**
 * Both packages ship UMD bundles: depending on the bundler's CommonJS interop
 * (Vite's dev pre-bundling vs the production build) their classes sit on the
 * module namespace or on its `default` export.
 */
function fromModule<T>(module: unknown, name: string): T {
  const namespace = module as Record<string, unknown> & { default?: Record<string, unknown> };
  const value = namespace[name] ?? namespace.default?.[name];
  if (typeof value !== 'function') throw new Error(`xterm: ${name} is missing from the bundle`);
  return value as T;
}

export function loadXterm(): Promise<XtermModules> {
  if (!pending) {
    pending = Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')])
      .then(([xterm, fit]) => ({
        Terminal: fromModule<typeof Terminal>(xterm, 'Terminal'),
        FitAddon: fromModule<typeof FitAddon>(fit, 'FitAddon'),
      }))
      .catch((err: unknown) => {
        pending = null;
        throw err;
      });
  }
  return pending;
}
