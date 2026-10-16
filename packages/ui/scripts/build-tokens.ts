/**
 * Writes packages/ui/src/tokens/haven.css from the token module.
 * Run with `pnpm tokens:build` after editing packages/ui/src/tokens/haven.ts.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderHavenCss } from '../src/tokens/render-css';

const target = fileURLToPath(new URL('../src/tokens/haven.css', import.meta.url));
writeFileSync(target, renderHavenCss());
console.log(`wrote ${target}`);
