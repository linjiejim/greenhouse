/**
 * GUARD + BEHAVIOR TEST — the storage-driver fork extension point.
 *
 * Upstream has NO driver (local-disk default). Registering a driver routes
 * put/get/delete/presign through it — a fork swaps in COS/S3 without editing
 * uploads.ts. (Ordered: the null-default assertion runs before registration,
 * since the registry is module-level with no unregister.)
 */

import { describe, it, expect } from 'vitest';
import { getStorageDriver, registerStorageDriver, type StorageDriver } from './extensions.js';
import { putUpload, getUpload, deleteUpload, presignUpload } from './uploads.js';

describe('storage driver extension seam', () => {
  it('has no driver upstream (local-disk default)', () => {
    expect(getStorageDriver()).toBeNull();
  });

  it('routes put/get/delete/presign through a registered driver', async () => {
    const store = new Map<string, Buffer>();
    const calls: string[] = [];
    const driver: StorageDriver = {
      put: async (id, buf) => {
        calls.push('put:' + id);
        store.set(id, buf);
      },
      get: async (id) => (store.has(id) ? { buffer: store.get(id)!, contentType: 'image/png' } : null),
      delete: async (id) => {
        calls.push('delete:' + id);
        store.delete(id);
      },
      presignGet: async (id) => `https://cdn.example/${id}`,
    };
    registerStorageDriver(driver);

    await putUpload('a.png', Buffer.from('x'), 'image/png');
    expect((await getUpload('a.png'))?.contentType).toBe('image/png');
    expect(await presignUpload('a.png')).toBe('https://cdn.example/a.png');
    await deleteUpload('a.png');
    expect(await getUpload('a.png')).toBeNull();
    expect(calls).toEqual(['put:a.png', 'delete:a.png']);
  });
});
