/**
 * Memory scopes in the prompt index and the weekly consolidation
 * (docs/specs/20261005-personal-assistant-bots.md §3.5): consolidation runs one
 * partition (user-level, each Bot's private notes) at a time and a merge never
 * crosses partitions; the index block gives a Bot its own notes under their own
 * header and never reads another scope; a non-Bot caller never reads Bot notes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const row = (id: number, botId: string | null) => ({
    id,
    user_id: 'user-1',
    category: 'fact',
    title: botId ? `Bot note ${id}` : `Shared note ${id}`,
    content: `content ${id}`,
    pinned: false,
    status: 'active',
    source: 'agent',
    bot_id: botId,
    last_used_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    superseded_by: null,
  });
  const shared = Array.from({ length: 10 }, (_, i) => row(i + 1, null));
  const botA = Array.from({ length: 10 }, (_, i) => row(101 + i, 'botA'));
  const prompts: string[] = [];
  const db = {
    users: { getById: vi.fn(async () => ({ id: 'user-1', role: 'team', status: 'active' })) },
    userMemories: {
      demoteStale: vi.fn(async () => 0),
      listUsersForConsolidation: vi.fn(async () => [{ user_id: 'user-1' }]),
      listActiveScopes: vi.fn(async () => [
        { bot_id: null, count: 10 },
        { bot_id: 'botA', count: 10 },
      ]),
      listForIndex: vi.fn(async (_userId: string, scope: { botId: string | null; exact?: boolean }) => {
        if (scope.botId === null) return shared;
        return scope.exact ? botA : [...shared, ...botA];
      }),
      create: vi.fn(async (input: Record<string, unknown>) => ({ ...input, id: 999 })),
      setStatus: vi.fn(async () => undefined),
    },
  };
  return { db, prompts };
});

vi.mock('@greenhouse/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@greenhouse/db')>();
  return { ...actual, getDb: () => mocks.db };
});
vi.mock('@greenhouse/agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@greenhouse/agent-core')>();
  return {
    ...actual,
    resolveModelConfig: (model: unknown) => model,
    createModelFromConfig: vi.fn(async () => ({})),
    buildProviderOptions: vi.fn(() => undefined),
  };
});
vi.mock('../usage-budget.js', () => ({ createProviderAttemptBudgetHook: () => undefined }));
vi.mock('../../auth/features.js', () => ({ userHasFeature: vi.fn(async () => true) }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(async (input: { messages: Array<{ content: string }> }) => {
      const listing = input.messages[0]!.content;
      mocks.prompts.push(listing);
      // In the Bot's partition the "model" merges two of its notes — and also
      // tries to merge across into a shared note, which must be dropped.
      if (listing.includes('id=101 ')) {
        return {
          text: JSON.stringify([
            {
              op: 'merge',
              ids: [101, 102],
              title: 'Merged bot note',
              content: 'content 101 and content 102',
              category: 'fact',
            },
            { op: 'merge', ids: [103, 1], title: 'Cross-scope merge', content: 'nope', category: 'fact' },
          ]),
        };
      }
      return { text: '[]' };
    }),
  };
});

import { buildMemoryIndexBlock, runMemoryConsolidation } from '../memory.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prompts.length = 0;
});

describe('consolidation partitions', () => {
  it('consolidates each scope on its own; a merge stays inside its partition', async () => {
    const stats = await runMemoryConsolidation();
    expect(stats.opsApplied).toBe(1);

    const scopes = mocks.db.userMemories.listForIndex.mock.calls.map((call) => call[1]);
    expect(scopes).toEqual([
      { botId: null, exact: true },
      { botId: 'botA', exact: true },
    ]);
    // The user-level prompt never lists Bot notes, and vice versa.
    expect(mocks.prompts[0]).not.toContain('Bot note');
    expect(mocks.prompts[1]).not.toContain('Shared note');

    expect(mocks.db.userMemories.create).toHaveBeenCalledTimes(1);
    expect(mocks.db.userMemories.create).toHaveBeenCalledWith(expect.objectContaining({ bot_id: 'botA' }));
    const retired = mocks.db.userMemories.setStatus.mock.calls.map((call) => (call as unknown[])[0]);
    expect(retired).toEqual([101, 102]);
  });
});

describe('memory index block', () => {
  it('a Bot gets the shared layer plus its own notes under their own header', async () => {
    const block = await buildMemoryIndexBlock('user-1', { botId: 'botA' });
    expect(block).toContain('Shared note 1');
    expect(block).toMatch(/Your own private notes \(only you see these\):\n- \[fact\] Bot note 101/);
    const scopes = mocks.db.userMemories.listForIndex.mock.calls.map((call) => call[1]);
    expect(scopes).toEqual([{ botId: null }, { botId: 'botA', exact: true }]);
    // The private part has its own small budget.
    const privatePart = block!.split('Your own private notes (only you see these):\n')[1]!.split('\n\n')[0]!;
    expect(privatePart.length).toBeLessThanOrEqual(1200 + 200);
  });

  it('a non-Bot caller never reads Bot notes', async () => {
    const block = await buildMemoryIndexBlock('user-1');
    expect(block).not.toContain('Bot note');
    expect(block).not.toContain('private notes');
    const scopes = mocks.db.userMemories.listForIndex.mock.calls.map((call) => call[1]);
    expect(scopes).toEqual([{ botId: null }]);
  });
});
