/**
 * sweepExpiredUploads — periodic cleanup of expired local-disk exports.
 *
 * Runs over a throwaway temp dir (not the real UPLOADS_DIR) so the sweep is
 * hermetic. The driver-no-op case runs LAST on purpose: the storage-driver
 * registry is module-level with no unregister (see extensions.test.ts), so once
 * a driver is registered it stays for the rest of this file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepExpiredUploads, makeExpiringId } from './uploads.js';
import { registerStorageDriver, type StorageDriver } from './extensions.js';

const NOW = 1_700_000_000_000; // fixed clock (ms)
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh-sweep-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function touch(id: string): string {
  writeFileSync(join(dir, id), 'x');
  return id;
}

describe('sweepExpiredUploads', () => {
  it('deletes expired exports and leaves live exports + non-expiring uploads', () => {
    const expired1 = touch(makeExpiringId('csv', -1_000, NOW)); // deadline in the past
    const expired2 = touch(makeExpiringId('xlsx', -60_000, NOW));
    const live = touch(makeExpiringId('csv', 60_000, NOW)); // deadline in the future
    const image = touch('gen-abc-abcdef12.png'); // no encoded expiry
    const legacy = touch('1715-abcd.jpg'); // no encoded expiry

    expect(sweepExpiredUploads(dir, NOW)).toBe(2);

    expect(existsSync(join(dir, expired1))).toBe(false);
    expect(existsSync(join(dir, expired2))).toBe(false);
    expect(existsSync(join(dir, live))).toBe(true);
    expect(existsSync(join(dir, image))).toBe(true);
    expect(existsSync(join(dir, legacy))).toBe(true);
  });

  it('returns 0 when the directory does not exist', () => {
    expect(sweepExpiredUploads(join(dir, 'does-not-exist'), NOW)).toBe(0);
  });

  // MUST stay last — registers a module-level driver that has no unregister.
  it('is a no-op when a storage driver is registered (fork owns cleanup)', () => {
    const expired = touch(makeExpiringId('csv', -1_000, NOW));
    const driver: StorageDriver = {
      put: async () => {},
      get: async () => null,
      delete: async () => {},
    };
    registerStorageDriver(driver);

    expect(sweepExpiredUploads(dir, NOW)).toBe(0);
    expect(existsSync(join(dir, expired))).toBe(true); // left untouched
  });
});
