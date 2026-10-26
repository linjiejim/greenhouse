import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { tablesManifest } from '../platform/manifest.js';
it('preserves the Tables manifest contract', () =>
  expect(createHash('sha256').update(JSON.stringify(tablesManifest)).digest('hex')).toBe(
    '3f15cbbfae3ab9302f15dcf2be886afd119eb8285e94dde94dbf004895af1a07',
  ));
