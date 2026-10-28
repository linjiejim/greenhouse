import { createHash } from 'node:crypto';
import { it, expect } from 'vitest';
import { projectsManifest } from '../platform/manifest.js';
it('keeps the published projects manifest unchanged', () => {
  expect(createHash('sha256').update(JSON.stringify(projectsManifest)).digest('hex')).toBe(
    '603d8c2644b53ec3cae159121b3f3e853c34378533ebf03dedd84f551a348951',
  );
});
