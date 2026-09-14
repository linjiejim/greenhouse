import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  getVersion: vi.fn(),
}));

vi.mock('@greenhouse/db', () => ({
  getDb: () => ({ customProfiles: { getById: mocks.getById, getVersion: mocks.getVersion } }),
}));

import { assertCustomProfileAccess, pinProfileIdForUser, ProfileAccessError } from './access.js';

const owner = { id: 'owner', role: 'team' as const };
const other = { id: 'other', role: 'team' as const };
const superUser = { id: 'super', role: 'super' as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getById.mockResolvedValue({
    id: 7,
    user_id: 'owner',
    is_shared: false,
    lifecycle_status: 'draft',
    current_version: 3,
    published_version: null,
  });
  mocks.getVersion.mockImplementation(async (_profileId: number, version: number) => ({ version }));
});

describe('custom profile access policy', () => {
  it('does not query the database for a system profile', async () => {
    await expect(assertCustomProfileAccess(other, 'team')).resolves.toBeNull();
    expect(mocks.getById).not.toHaveBeenCalled();
  });

  it('allows the owner, a shared reader, and super', async () => {
    await expect(assertCustomProfileAccess(owner, 'custom:7')).resolves.toMatchObject({ id: 7 });

    mocks.getById.mockResolvedValueOnce({
      id: 7,
      user_id: 'owner',
      is_shared: true,
      lifecycle_status: 'verified',
      published_version: 2,
    });
    await expect(assertCustomProfileAccess(other, 'custom:7')).resolves.toMatchObject({ id: 7 });

    mocks.getById.mockResolvedValueOnce({ id: 7, user_id: 'owner', is_shared: false });
    await expect(assertCustomProfileAccess(superUser, 'custom:7')).resolves.toMatchObject({ id: 7 });
  });

  it('fails closed for private, missing, and malformed custom profile IDs', async () => {
    await expect(assertCustomProfileAccess(other, 'custom:7')).rejects.toMatchObject({
      name: 'ProfileAccessError',
      status: 403,
    } satisfies Partial<ProfileAccessError>);

    mocks.getById.mockResolvedValueOnce(undefined);
    await expect(assertCustomProfileAccess(owner, 'custom:8')).rejects.toMatchObject({ status: 404 });

    await expect(assertCustomProfileAccess(owner, 'custom:not-a-number')).rejects.toMatchObject({ status: 400 });
  });

  it('pins owners to current and shared readers to the reviewed published version', async () => {
    await expect(pinProfileIdForUser(owner, 'custom:7')).resolves.toBe('custom:7@3');

    mocks.getById.mockResolvedValue({
      id: 7,
      user_id: 'owner',
      is_shared: true,
      lifecycle_status: 'pilot',
      current_version: 3,
      published_version: 2,
    });
    await expect(pinProfileIdForUser(other, 'custom:7')).resolves.toBe('custom:7@2');
    await expect(pinProfileIdForUser(other, 'custom:7@3')).rejects.toMatchObject({ status: 403 });
  });

  it('fails closed for suspended assets instead of selecting another Agent', async () => {
    mocks.getById.mockResolvedValue({
      id: 7,
      user_id: 'owner',
      is_shared: false,
      lifecycle_status: 'suspended',
      current_version: 3,
      published_version: 2,
    });
    await expect(pinProfileIdForUser(owner, 'custom:7@2')).rejects.toMatchObject({ status: 403 });
  });
});
