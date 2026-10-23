/**
 * The share extension's Swift logic (targets/share/ShareLogic.swift), checked by compiling it with
 * ./ShareLogicCheck.swift and running the result. Needs `swiftc` (macOS with Xcode); skipped where
 * it is missing (Linux CI).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { darkHex, lightHex } from '../theme/palette';

const hasSwiftc = spawnSync('swiftc', ['--version'], { stdio: 'ignore' }).status === 0;
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

describe.skipIf(!hasSwiftc)('the share extension’s upload logic', () => {
  it('retries only the files not saved yet, speaks the app’s language and wears its green', () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-logic-'));
    try {
      const binary = join(dir, 'check');
      execFileSync('swiftc', ['-o', binary, here('../../targets/share/ShareLogic.swift'), here('./ShareLogicCheck.swift')], {
        stdio: 'pipe',
      });
      const run = spawnSync(binary, { encoding: 'utf8' });
      const lines = run.stdout.trim().split('\n');
      expect(lines.at(-1)).toBe('ok');
      expect(run.status).toBe(0);
      // the extension wears the app's green, light and dark, with the app's text on it
      const hex = (value: string) => value.replace('#', '').toUpperCase();
      expect(lines.find((line) => line.startsWith('brand '))).toBe(
        `brand ${[lightHex.accent, darkHex.accent, lightHex.onAccent, darkHex.onAccent].map(hex).join(' ')}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
