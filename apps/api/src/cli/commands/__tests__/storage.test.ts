import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('maps local uploads and drive files to their object keys and leaves everything else alone', async () => {
  vi.resetModules();
  vi.stubEnv('TENCENT_CLOUD_COS_PREFIX', '');
  vi.stubEnv('TENCENT_CLOUD_COS_DRIVE_PREFIX', '');
  const { localObjects } = await import('../storage.js');
  root = mkdtempSync(join(tmpdir(), 'gh-storage-'));
  const upload = '1784639633034-32fd7fa6-01a2-4bdd-9733-737e835da203.webp';
  writeFileSync(join(root, upload), 'img');
  writeFileSync(join(root, 'gen-1784639629506-b776711a.png'), 'gen');
  mkdirSync(join(root, 'drive/plugins/assets/ab'), { recursive: true });
  writeFileSync(join(root, 'drive/plugins/assets/ab/original.mp4'), 'video');
  mkdirSync(join(root, 'drive/tables/base_1'), { recursive: true });
  writeFileSync(join(root, 'drive/tables/base_1/f.pdf'), 'pdf');
  mkdirSync(join(root, '.tmp'));
  writeFileSync(join(root, '.tmp/partial'), 'x');
  writeFileSync(join(root, 'notes.txt'), 'stray');

  const { objects, skipped } = localObjects(root);
  expect(objects.map(({ key, size, contentType }) => ({ key, size, contentType }))).toEqual([
    { key: `uploads/${upload}`, size: 3, contentType: 'image/webp' },
    { key: 'drive/plugins/assets/ab/original.mp4', size: 5, contentType: 'video/mp4' },
    { key: 'drive/tables/base_1/f.pdf', size: 3, contentType: 'application/octet-stream' },
    { key: 'generate/gen-1784639629506-b776711a.png', size: 3, contentType: 'image/png' },
  ]);
  expect(skipped).toEqual(['notes.txt']);
});
