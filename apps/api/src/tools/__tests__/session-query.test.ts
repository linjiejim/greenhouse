/**
 * session_query applies the same hide-by-default rule as the session lists
 * (`defaultSessionListHiding`), and Bots conversations stay owner-only for
 * every action — a super can read anyone's ordinary chat, never their Bots.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { BOT_TASK_SESSION_PREFIX, defaultSessionListHiding } from '@greenhouse/types/session';
import { createSessionQueryTool, type SessionQueryContext } from '../session-query.js';

const sessions = {
  list: vi.fn(),
  searchByTitle: vi.fn(),
  getById: vi.fn(),
  getMessages: vi.fn(),
  getMessageCount: vi.fn(),
  getUsage: vi.fn(),
};
const db = { sessions } as unknown as DatabaseProvider;

function session(id: string, userId: string, channel: string) {
  return {
    id,
    title: id,
    status: 'active',
    rating: null,
    profile_id: 'sprouty',
    user_id: userId,
    channel,
    created_at: '2026-10-05T00:00:00.000Z',
    updated_at: '2026-10-05T00:00:00.000Z',
  };
}

async function run(ctx: SessionQueryContext, input: Record<string, unknown>) {
  const tool = createSessionQueryTool(db, ctx);
  return (await tool.execute!(input as never, { toolCallId: 't', messages: [], context: {} })) as Record<
    string,
    unknown
  >;
}

const team: SessionQueryContext = { userId: 'u-team', userRole: 'team' };
const boss: SessionQueryContext = { userId: 'u-boss', userRole: 'super' };

beforeEach(() => {
  vi.clearAllMocks();
  sessions.list.mockResolvedValue([]);
  sessions.searchByTitle.mockResolvedValue([]);
  sessions.getMessages.mockResolvedValue([]);
  sessions.getMessageCount.mockResolvedValue(0);
});

describe('session_query list', () => {
  it('hides Bots conversations, workflow internals and Bot task children by default', async () => {
    await run(team, { action: 'list' });
    expect(sessions.list).toHaveBeenCalledWith(
      expect.objectContaining({ ...defaultSessionListHiding(), userId: 'u-team' }),
    );
    const opts = sessions.list.mock.calls[0]![0] as { excludeChannels: string[]; excludeIdPrefixes: string[] };
    expect(opts.excludeChannels).toEqual(expect.arrayContaining(['bots', 'workflow']));
    expect(opts.excludeIdPrefixes).toContain(BOT_TASK_SESSION_PREFIX);
  });

  it('hides nothing for an explicit channel', async () => {
    await run(team, { action: 'list', channel: 'subagent' });
    const opts = sessions.list.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.channel).toBe('subagent');
    expect(opts).not.toHaveProperty('excludeChannels');
    expect(opts).not.toHaveProperty('excludeIdPrefixes');
  });

  it('a super lists everyone’s ordinary chats but only their own Bots conversations', async () => {
    await run(boss, { action: 'list', channel: 'web' });
    expect(sessions.list).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'web', userId: undefined }));
    await run(boss, { action: 'list', channel: 'bots' });
    expect(sessions.list).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'bots', userId: 'u-boss' }));
  });
});

describe('session_query get / messages', () => {
  it('a super reads another member’s ordinary chat', async () => {
    sessions.getById.mockResolvedValue(session('s-web', 'u-team', 'web'));
    const result = await run(boss, { action: 'get', session_id: 's-web' });
    expect(result).toHaveProperty('session');
  });

  it('a super cannot read another member’s Bots conversation', async () => {
    sessions.getById.mockResolvedValue(session('s-bots', 'u-team', 'bots'));
    for (const action of ['get', 'messages', 'usage']) {
      const result = await run(boss, { action, session_id: 's-bots' });
      expect(result.error).toMatch(/Access denied/);
    }
    expect(sessions.getMessages).not.toHaveBeenCalled();
  });

  it('the owner reads their own Bots conversation', async () => {
    sessions.getById.mockResolvedValue(session('s-bots', 'u-team', 'bots'));
    const result = await run(team, { action: 'messages', session_id: 's-bots' });
    expect(result).toMatchObject({ session_id: 's-bots', total: 0 });
  });
});
