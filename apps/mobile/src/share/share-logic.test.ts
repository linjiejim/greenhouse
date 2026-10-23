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

const hasSwiftc = spawnSync('swiftc', ['--version'], { stdio: 'ignore' }).status === 0;
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

describe.skipIf(!hasSwiftc)('the share extension’s upload logic', () => {
  it('retries only the files not saved yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-logic-'));
    try {
      const binary = join(dir, 'check');
      execFileSync('swiftc', ['-o', binary, here('../../targets/share/ShareLogic.swift'), here('./ShareLogicCheck.swift')], {
        stdio: 'pipe',
      });
      const run = spawnSync(binary, { encoding: 'utf8' });
      expect(run.stdout.trim()).toBe('ok');
      expect(run.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
