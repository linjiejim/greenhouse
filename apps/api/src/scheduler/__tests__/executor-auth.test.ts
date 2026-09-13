import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTaskRow } from '@greenhouse/db';

const mocks = vi.hoisted(() => ({
  db: {
    users: { getById: vi.fn() },
    userTools: { getTools: vi.fn() },
    userFeatures: { isEnabled: vi.fn() },
    scheduledTasks: { updateRunStatus: vi.fn() },
    notifications: {
      createWithStatus: vi.fn(),
      createDelivery: vi.fn(),
      countUnread: vi.fn(),
    },
    sessions: {
      create: vi.fn(),
      getById: vi.fn(),
      update: vi.fn(),
      addMessage: vi.fn(),
      addMessageOnce: vi.fn(),
      getLatestMessage: vi.fn(),
      touch: vi.fn(),
    },
  },
  runAgentInSession: vi.fn(),
}));

vi.mock('@greenhouse/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/db')>()),
  getDb: () => mocks.db,
}));

vi.mock('../../agent-runtime/run-agent.js', () => ({
  runAgentInSession: mocks.runAgentInSession,
  SessionTranscriptChangedError: class SessionTranscriptChangedError extends Error {},
}));

import {
  executeTaskInSession,
  prepareTask,
  resolveActiveTaskOwner,
  resolveTaskOwnerState,
  scheduledToolBase,
} from '../executor.js';
import { SessionTranscriptChangedError } from '../../agent-runtime/run-agent.js';

function task(overrides: Partial<ScheduledTaskRow> = {}): ScheduledTaskRow {
  return {
    id: 1,
    user_id: 'owner-1',
    name: 'Evaluation review',
    profile_id: 'eval-judge',
    task_prompt: 'Review the latest evaluation results',
    schedule: '0 * * * *',
    timezone: 'UTC',
    enabled: true,
    max_steps: 10,
    notify_webhook: null,
    notify_email: false,
    notify_wecom: false,
    notify_feishu: false,
    unattended_tools: '[]',
    last_run_at: null,
    last_status: null,
    next_run_at: null,
    run_count: 0,
    created_at: '2026-07-21T00:00:00.000Z',
    updated_at: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('scheduled task executor authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.users.getById.mockResolvedValue({ id: 'owner-1', status: 'active', role: 'team' });
    mocks.db.userTools.getTools.mockResolvedValue([]);
    mocks.db.userFeatures.isEnabled.mockResolvedValue(false);
    mocks.db.scheduledTasks.updateRunStatus.mockResolvedValue(undefined);
    mocks.db.notifications.createWithStatus.mockResolvedValue({
      created: true,
      notification: {
        id: 'notification-1',
        kind: 'runtime_failed',
        title: 'Evaluation review needs review',
      },
    });
    mocks.db.notifications.createDelivery.mockResolvedValue(undefined);
    mocks.db.notifications.countUnread.mockResolvedValue(1);
    mocks.db.sessions.create.mockResolvedValue({
      id: 'session-1',
      user_id: 'owner-1',
      profile_id: 'eval-judge',
      channel: 'task',
    });
    mocks.db.sessions.getById.mockResolvedValue(undefined);
    mocks.db.sessions.update.mockResolvedValue(undefined);
    mocks.db.sessions.addMessage.mockResolvedValue(undefined);
    mocks.db.sessions.addMessageOnce.mockResolvedValue(undefined);
    mocks.db.sessions.getLatestMessage.mockResolvedValue({
      id: 'prepared-user',
      role: 'user',
      content: 'Persisted canonical task prompt',
    });
    mocks.db.sessions.touch.mockResolvedValue(undefined);
    mocks.runAgentInSession.mockResolvedValue({
      text: 'done',
      durationMs: 1,
      pipeline: [],
      references: [],
      toolEvidence: [],
      persisted: true,
    });
  });

  it.each([
    ['disabled team', { id: 'owner-1', status: 'disabled', role: 'team' }],
    ['active external', { id: 'owner-1', status: 'active', role: 'external' }],
    ['missing owner', undefined],
  ])('fails closed for a %s owner', async (_label, owner) => {
    mocks.db.users.getById.mockResolvedValue(owner);
    await expect(resolveActiveTaskOwner(task(), mocks.db as never)).resolves.toBeNull();
  });

  it('distinguishes password setup suspension from a permanently invalid owner', async () => {
    mocks.db.users.getById.mockResolvedValue({ id: 'owner-1', status: 'reset_required', role: 'team' });
    await expect(resolveTaskOwnerState(task(), mocks.db as never)).resolves.toEqual({ state: 'paused' });
  });

  it('does not create a session when manual preparation sees a revoked owner', async () => {
    mocks.db.users.getById.mockResolvedValue({ id: 'owner-1', status: 'disabled', role: 'team' });

    await expect(prepareTask(task())).rejects.toThrow(/active internal user/);
    expect(mocks.db.sessions.create).not.toHaveBeenCalled();
  });

  it('runs a system-profile task with the owner allow-set narrowed to replay-safe reads', async () => {
    const adminTool = { execute: vi.fn() };
    await executeTaskInSession(task(), 'session-1', {
      knowledge_query: { execute: vi.fn() },
      session_query: { execute: vi.fn() },
      eval_message: adminTool,
      query_eval_runs: adminTool,
      manage_eval_dataset: adminTool,
    });

    const tools = mocks.runAgentInSession.mock.calls[0]?.[0].tools;
    expect(mocks.runAgentInSession.mock.calls[0]?.[0].prompt).toBe('Persisted canonical task prompt');
    // System profiles run with the owner's full allow-set (chat parity) — the
    // YAML tools list is not a runtime narrowing. Global read tools are in.
    expect(tools).toHaveProperty('session_query');
    expect(tools).toHaveProperty('knowledge_query');
    // Admin-granted tools without a replay-safe declaration never survive the
    // unattended filter, whatever the owner's role.
    expect(tools).not.toHaveProperty('eval_message');
    expect(tools).not.toHaveProperty('query_eval_runs');
    expect(tools).not.toHaveProperty('manage_eval_dataset');
  });

  it('re-resolves a role downgrade and never adds tools absent from the profile', async () => {
    const registry = {
      knowledge_query: { execute: vi.fn() },
      eval_message: { execute: vi.fn() },
      query_eval_runs: { execute: vi.fn() },
      manage_eval_dataset: { execute: vi.fn() },
      session_query: { execute: vi.fn() },
    };
    mocks.db.users.getById.mockResolvedValue({ id: 'owner-1', status: 'active', role: 'super' });
    await executeTaskInSession(task(), 'session-super', registry);

    const superTools = mocks.runAgentInSession.mock.calls[0]?.[0].tools;
    expect(superTools).not.toHaveProperty('eval_message');
    expect(superTools).not.toHaveProperty('query_eval_runs');
    expect(superTools).toHaveProperty('session_query');
    expect(superTools).not.toHaveProperty('manage_eval_dataset');

    mocks.db.users.getById.mockResolvedValue({ id: 'owner-1', status: 'active', role: 'team' });
    await executeTaskInSession(task(), 'session-team', registry);

    const teamTools = mocks.runAgentInSession.mock.calls[1]?.[0].tools;
    expect(teamTools).toHaveProperty('session_query');
    expect(teamTools).not.toHaveProperty('eval_message');
    expect(teamTools).not.toHaveProperty('query_eval_runs');
    expect(teamTools).not.toHaveProperty('manage_eval_dataset');
  });

  it('never lets writes or human-gated tools into the scheduled tool base', () => {
    expect(
      scheduledToolBase(['knowledge_query', 'knowledge_query', 'knowledge_mutation', 'spawn_session', 'call_llm']),
    ).toEqual(['knowledge_query', 'knowledge_query']);
  });

  it('checks owner status again immediately before invoking the model', async () => {
    mocks.db.users.getById.mockResolvedValue({ id: 'owner-1', status: 'disabled', role: 'team' });

    await expect(executeTaskInSession(task(), 'session-1', {})).rejects.toThrow(/active internal user/);
    expect(mocks.runAgentInSession).not.toHaveBeenCalled();
    expect(mocks.db.scheduledTasks.updateRunStatus).toHaveBeenCalledWith(task().id, 'failed', expect.any(String));
  });

  it('marks a transcript conflict failed without appending a misleading status turn', async () => {
    mocks.runAgentInSession.mockRejectedValueOnce(new SessionTranscriptChangedError('transcript changed'));

    await expect(executeTaskInSession(task(), 'session-1', {})).rejects.toThrow('transcript changed');

    expect(mocks.db.sessions.addMessage).not.toHaveBeenCalled();
    expect(mocks.db.scheduledTasks.updateRunStatus).toHaveBeenCalledWith(task().id, 'failed', expect.any(String));
  });
});
