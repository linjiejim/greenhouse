import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBotById: vi.fn(),
  getByLegacyCustomId: vi.fn(),
  getVersion: vi.fn(),
}));

vi.mock('@greenhouse/db', () => ({
  getDb: () => ({
    bots: {
      getBotById: mocks.getBotById,
      getByLegacyCustomId: mocks.getByLegacyCustomId,
      getVersion: mocks.getVersion,
    },
  }),
}));

import { assertBotProfileAccess, pinProfileIdForUser, ProfileAccessError } from './access.js';

const BOT = 'bot_0123456789abcdef';
const owner = { id: 'owner', role: 'team' as const };
const other = { id: 'other', role: 'team' as const };
const superUser = { id: 'super', role: 'super' as const };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: BOT,
    user_id: 'owner',
    status: 'active',
    current_version: 3,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBotById.mockImplementation(async (id: string) => (id === BOT ? row() : undefined));
  mocks.getByLegacyCustomId.mockImplementation(async (id: number) =>
    id === 7 ? row({ legacy_custom_id: 7 }) : undefined,
  );
  mocks.getVersion.mockImplementation(async (_botId: string, version: number) => ({ version }));
});

describe('Bot profile access policy', () => {
  it('does not query the database for a system profile', async () => {
    await expect(assertBotProfileAccess(other, 'team')).resolves.toBeNull();
    await expect(assertBotProfileAccess(other, 'sprouty')).resolves.toBeNull();
    expect(mocks.getBotById).not.toHaveBeenCalled();
  });

  it('allows the owner and super, and nobody else — Bots are private', async () => {
    await expect(assertBotProfileAccess(owner, `bot:${BOT}`)).resolves.toMatchObject({ id: BOT });
    await expect(assertBotProfileAccess(superUser, `bot:${BOT}`)).resolves.toMatchObject({ id: BOT });
    await expect(assertBotProfileAccess(other, `bot:${BOT}`)).rejects.toMatchObject({
      name: 'ProfileAccessError',
      status: 403,
    } satisfies Partial<ProfileAccessError>);
  });

  it('resolves a retired custom:<id> reference through legacy_custom_id', async () => {
    await expect(assertBotProfileAccess(owner, 'custom:7')).resolves.toMatchObject({ id: BOT, legacy_custom_id: 7 });
    await expect(assertBotProfileAccess(owner, 'custom:8')).rejects.toMatchObject({ status: 404 });
  });

  it('fails closed for missing and malformed Bot profile IDs', async () => {
    await expect(assertBotProfileAccess(owner, 'bot:bot_ffffffffffffffff')).rejects.toMatchObject({ status: 404 });
    await expect(assertBotProfileAccess(owner, 'bot:not-an-id')).rejects.toMatchObject({ status: 400 });
    await expect(assertBotProfileAccess(owner, 'custom:not-a-number')).rejects.toMatchObject({ status: 400 });
  });

  it('pins the owner to the current version, follows the live definition only on request', async () => {
    await expect(pinProfileIdForUser(owner, `bot:${BOT}`)).resolves.toBe(`bot:${BOT}@3`);
    // The owner's own Chat sessions may follow the latest definition instead.
    await expect(pinProfileIdForUser(owner, `bot:${BOT}`, undefined, { mode: 'live' })).resolves.toBe(`bot:${BOT}`);
    await expect(pinProfileIdForUser(owner, `bot:${BOT}@2`, undefined, { mode: 'live' })).resolves.toBe(`bot:${BOT}@2`);
    // A stored legacy reference is re-spelled on the way through.
    await expect(pinProfileIdForUser(owner, 'custom:7@2')).resolves.toBe(`bot:${BOT}@2`);
    // Super may run it for support; another member never can, pinned or not.
    await expect(pinProfileIdForUser(superUser, `bot:${BOT}`)).resolves.toBe(`bot:${BOT}@3`);
    await expect(pinProfileIdForUser(other, `bot:${BOT}`)).rejects.toMatchObject({ status: 403 });
    await expect(pinProfileIdForUser(other, `bot:${BOT}@3`)).rejects.toMatchObject({ status: 403 });
  });

  it('fails closed for archived Bots instead of selecting another one', async () => {
    mocks.getBotById.mockResolvedValue(row({ status: 'archived' }));
    await expect(pinProfileIdForUser(owner, `bot:${BOT}@2`)).rejects.toMatchObject({ status: 403 });
  });
});
