import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBotById: vi.fn(async () => undefined),
  getByLegacyCustomId: vi.fn(async () => undefined),
}));

vi.mock('@greenhouse/db', () => ({
  getDb: () => ({ bots: { getBotById: mocks.getBotById, getByLegacyCustomId: mocks.getByLegacyCustomId } }),
}));

import { resolveProfileAsync } from './profile.js';

describe('Bot profile resolution', () => {
  it('fails explicitly when the Bot is missing and never falls back to Sprouty', async () => {
    await expect(resolveProfileAsync('custom:404')).rejects.toThrow('Custom profile not found');
    await expect(resolveProfileAsync('bot:bot_0123456789abcdef')).rejects.toThrow('Bot not found');
    await expect(resolveProfileAsync('bot:nope')).rejects.toThrow('Invalid Bot profile ID');
  });
});
