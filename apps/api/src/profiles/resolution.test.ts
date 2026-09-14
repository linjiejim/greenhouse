import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getById: vi.fn(async () => undefined) }));

vi.mock('@greenhouse/db', () => ({
  getDb: () => ({ customProfiles: { getById: mocks.getById } }),
}));

import { resolveProfileAsync } from './profile.js';

describe('custom Agent resolution', () => {
  it('fails explicitly when the asset is missing and never falls back to Sprouty', async () => {
    await expect(resolveProfileAsync('custom:404')).rejects.toThrow('Custom profile not found');
  });
});
