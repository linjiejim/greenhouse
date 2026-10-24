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
    id: '7',
    user_id: 'owner',
    is_shared: false,
    version: 3,
  });
  mocks.getVersion.mockImplementation(async (_profileId: string, version: number) => ({ version }));
});

describe('custom profile access policy', () => {
  it('does not query the database for a system profile', async () => {
    await expect(assertCustomProfileAccess(other, 'team')).resolves.toBeNull();
    expect(mocks.getById).not.toHaveBeenCalled();
  });

  it('allows the owner, a shared reader, and super', async () => {
    await expect(assertCustomProfileAccess(owner, 'custom:7')).resolves.toMatchObject({ id: '7' });

    mocks.getById.mockResolvedValueOnce({ id: '7', user_id: 'owner', is_shared: true, version: 2 });
    await expect(assertCustomProfileAccess(other, 'custom:7')).resolves.toMatchObject({ id: '7' });

    mocks.getById.mockResolvedValueOnce({ id: '7', user_id: 'owner', is_shared: false });
    await expect(assertCustomProfileAccess(superUser, 'custom:7')).resolves.toMatchObject({ id: '7' });
  });

  it('fails closed for private, missing, and malformed custom profile IDs', async () => {
    await expect(assertCustomProfileAccess(other, 'custom:7')).rejects.toMatchObject({
      name: 'ProfileAccessError',
      status: 403,
    } satisfies Partial<ProfileAccessError>);

    mocks.getById.mockResolvedValueOnce(undefined);
    await expect(assertCustomProfileAccess(owner, 'custom:8')).rejects.toMatchObject({ status: 404 });

    await expect(assertCustomProfileAccess(owner, 'custom:not a valid id')).rejects.toMatchObject({ status: 400 });
  });

  it('pins owners and shared readers alike to the current version', async () => {
    await expect(pinProfileIdForUser(owner, 'custom:7')).resolves.toBe('custom:7@3');
    await expect(pinProfileIdForUser(other, 'custom:7')).rejects.toMatchObject({ status: 403 });

    mocks.getById.mockResolvedValue({ id: '7', user_id: 'owner', is_shared: true, version: 3 });
    await expect(pinProfileIdForUser(other, 'custom:7')).resolves.toBe('custom:7@3');
  });

  it('keeps an existing pin resolving after the Agent moved on, but not a version that never existed', async () => {
    mocks.getById.mockResolvedValue({ id: '7', user_id: 'owner', is_shared: true, version: 3 });
    await expect(pinProfileIdForUser(other, 'custom:7@2', undefined, { existingPin: true })).resolves.toBe(
      'custom:7@2',
    );

    mocks.getVersion.mockResolvedValueOnce(undefined);
    await expect(pinProfileIdForUser(other, 'custom:7@9', undefined, { existingPin: true })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('never lets a non-owner pick an older version themselves (it may never have been shared)', async () => {
    mocks.getById.mockResolvedValue({ id: '7', user_id: 'owner', is_shared: true, version: 3 });
    await expect(pinProfileIdForUser(other, 'custom:7@1')).rejects.toMatchObject({ status: 403 });
    await expect(pinProfileIdForUser(other, 'custom:7@3')).resolves.toBe('custom:7@3');
    // The owner may still pin any of their own versions.
    await expect(pinProfileIdForUser(owner, 'custom:7@1')).resolves.toBe('custom:7@1');
  });
});
