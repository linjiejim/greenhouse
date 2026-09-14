import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';

const mocks = vi.hoisted(() => ({
  judgeChatAnswer: vi.fn(),
  buildEvalContext: vi.fn(),
  loadReferenceSources: vi.fn(),
  retrieveKbForJudge: vi.fn(),
}));

vi.mock('../../chat/eval.js', () => mocks);

import { createEvalMessageTool } from '../eval-message.js';

function makeDb(ownerId = 'owner') {
  return {
    sessions: {
      getById: vi.fn().mockResolvedValue({ id: 'session-1', user_id: ownerId }),
      getMessages: vi.fn().mockResolvedValue([]),
    },
    sessionShares: {
      getSharedSessionIds: vi.fn().mockResolvedValue([]),
    },
  } as unknown as DatabaseProvider;
}

describe('eval_message session access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an unshared session before reading any messages', async () => {
    const db = makeDb('another-user');
    const evalTool = createEvalMessageTool(db, { userId: 'caller', userRole: 'team' });

    const result = await evalTool.execute!({ session_id: 'session-1', message_id: 'message-1' }, {} as never);

    expect(result).toEqual({ error: 'Session not found or unavailable', steps: [] });
    expect(db.sessionShares.getSharedSessionIds).toHaveBeenCalledWith('caller');
    expect(db.sessions.getMessages).not.toHaveBeenCalled();
    expect(mocks.loadReferenceSources).not.toHaveBeenCalled();
  });

  it('allows a shared reader to enter the message lookup path', async () => {
    const db = makeDb('another-user');
    vi.mocked(db.sessionShares.getSharedSessionIds).mockResolvedValue(['session-1']);
    const evalTool = createEvalMessageTool(db, { userId: 'caller', userRole: 'team' });

    const result = await evalTool.execute!({ session_id: 'session-1', message_id: 'missing-message' }, {} as never);

    expect(result).toMatchObject({ error: 'Message not found or not an assistant message' });
    expect(db.sessions.getMessages).toHaveBeenCalledWith('session-1');
  });
});
