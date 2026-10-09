/**
 * A Bot made outside this tab (another tab, the phone, a Bot's `team.create`)
 * must show up by name: its conversation used to render as "Deleted Bot" filed
 * under Archived until the page was reloaded.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotConversationSummary, BotView } from '@greenhouse/types/bots';

const api = vi.hoisted(() => ({
  listBots: vi.fn(),
  listConversations: vi.fn(),
}));

vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));

import { useBotsStore } from './bots-store';

function bot(id: string, name: string): BotView {
  return {
    id,
    name,
    role: '',
    instructions: '',
    avatar: { color: 'forest' },
    model_id: null,
    template_key: null,
    status: 'active',
    description: '',
    tools: null,
    connectors: null,
    max_steps: null,
    current_version: 1,
    user_id: 'u1',
    updated_at: '2026-10-05T00:00:00.000Z',
    dm_session_id: `dm-${id}`,
    last_active_at: null,
    created_at: '2026-10-05T00:00:00.000Z',
  };
}

function overview(bots: BotView[]) {
  return { bots, archived_bots: [], computer: null, vault_available: false, pending_requests: 0 };
}

function dm(botId: string): BotConversationSummary {
  return {
    session_id: `dm-${botId}`,
    kind: 'direct',
    owner_bot_id: botId,
    members: [{ bot_id: botId, role: 'owner' }],
    pending_requests: 0,
  } as unknown as BotConversationSummary;
}

const ivy = bot('bot_ivy', 'Ivy');
const sage = bot('bot_sage', 'Sage');

afterEach(() => {
  useBotsStore.getState().reset();
  vi.clearAllMocks();
});

describe('bots store — Bots made elsewhere', () => {
  it('re-reads the Bot list before publishing a conversation whose Bot it has not seen', async () => {
    api.listBots.mockResolvedValueOnce(overview([ivy]));
    await useBotsStore.getState().loadBots();

    // Sage was created on the phone; its DM arrives with the next list.
    api.listConversations.mockResolvedValueOnce({ conversations: [dm(ivy.id), dm(sage.id)] });
    api.listBots.mockResolvedValueOnce(overview([ivy, sage]));
    await useBotsStore.getState().loadConversations();

    const state = useBotsStore.getState();
    expect(api.listBots).toHaveBeenCalledTimes(2);
    expect(state.bots.map((b) => b.name)).toEqual(['Ivy', 'Sage']);
    expect(state.conversations).toHaveLength(2);
  });

  it('spends one refresh per unknown id, and none before the first load', async () => {
    await useBotsStore.getState().ensureBotsKnown(['bot_gone']);
    expect(api.listBots).not.toHaveBeenCalled();

    api.listBots.mockResolvedValue(overview([ivy]));
    await useBotsStore.getState().loadBots();
    await useBotsStore.getState().ensureBotsKnown(['bot_gone', ivy.id]);
    await useBotsStore.getState().ensureBotsKnown(['bot_gone']);
    // The first load + exactly one refresh for the id that stays unknown.
    expect(api.listBots).toHaveBeenCalledTimes(2);
  });
});
