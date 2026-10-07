import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotOwnershipCandidate, BotRow, DatabaseProvider, UserRow } from '@greenhouse/db';

import { startAgentGovernanceWorker } from './worker.js';

const AT = '2026-08-12T08:00:00.000Z';

function user(id: string, overrides: Partial<UserRow> = {}): UserRow {
  return {
    id,
    email: `${id}@example.test`,
    password_hash: 'hash',
    auth_version: 0,
    nickname: id,
    role: 'team',
    status: 'active',
    daily_message_limit: 200,
    monthly_token_limit: 20_000_000,
    notes: null,
    locale: 'en',
    created_by: null,
    created_at: AT,
    updated_at: AT,
    last_login_at: null,
    ...overrides,
  };
}

/** Numeric ids keep the fixtures readable; the worker only treats them as opaque strings. */
function botId(id: number): string {
  return `bot_${String(id).padStart(16, '0')}`;
}

function profile(id: number, overrides: Partial<BotRow> = {}): BotRow {
  return {
    id: botId(id),
    user_id: `owner-${id}`,
    name: `Agent ${id}`,
    name_key: `agent ${id}`,
    role: '',
    description: '',
    instructions: 'Help the team.',
    avatar: '{}',
    model_id: 'flash',
    tools: '[]',
    max_steps: 12,
    template_key: null,
    status: 'active',
    is_shared: true,
    forked_from: null,
    current_version: 3,
    published_version: 3,
    lifecycle_status: 'verified',
    lifecycle_note: null,
    owner_backup_user_id: null,
    reviewed_by: 'reviewer',
    reviewed_at: AT,
    next_review_at: '2026-08-12T07:00:00.000Z',
    legacy_custom_id: null,
    last_active_at: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
}

function candidate(
  row: BotRow,
  ownerStatus: BotOwnershipCandidate['owner_status'],
  backupStatus: BotOwnershipCandidate['backup_owner_status'] = null,
): BotOwnershipCandidate {
  return { bot: row, owner_status: ownerStatus, backup_owner_status: backupStatus };
}

function fakeDb(input: {
  users?: UserRow[];
  due?: BotRow[];
  ownership?: (limit: number, afterId: string) => Promise<BotOwnershipCandidate[]>;
}) {
  const users = { list: vi.fn().mockResolvedValue(input.users ?? []) };
  const botsService = {
    listReviewDue: vi.fn().mockResolvedValue(input.due ?? []),
    listActiveWithOwners: vi.fn().mockImplementation(input.ownership ?? (async () => [] as BotOwnershipCandidate[])),
    transitionLifecycle: vi.fn(),
  };
  let notificationSequence = 0;
  const notifications = {
    createWithStatus: vi.fn().mockImplementation(async (entry) => ({
      created: true,
      notification: {
        id: `notification-${++notificationSequence}`,
        kind: entry.kind,
        title: entry.title,
      },
    })),
    countUnread: vi.fn().mockResolvedValue(1),
  };
  return {
    db: { users, bots: botsService, notifications } as unknown as DatabaseProvider,
    users,
    botsService,
    notifications,
  };
}

describe('Agent governance worker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('suspends overdue published Agents and permanently notifies every active steward', async () => {
    const due = profile(7, { owner_backup_user_id: 'backup-7' });
    const suspended = profile(7, {
      owner_backup_user_id: 'backup-7',
      lifecycle_status: 'suspended',
      is_shared: false,
      next_review_at: null,
      reviewed_by: 'system:agent-governance',
      updated_at: '2026-08-12T08:00:01.000Z',
    });
    const state = fakeDb({
      due: [due],
      users: [
        user('owner-7'),
        user('backup-7'),
        user('super-1', { role: 'super' }),
        user('disabled-super', { role: 'super', status: 'disabled' }),
      ],
    });
    state.botsService.transitionLifecycle.mockResolvedValue(suspended);
    const worker = await startAgentGovernanceWorker({
      db: state.db,
      skipBootPass: true,
      intervalMs: 60_000,
      now: () => new Date(AT),
    });

    await worker.runOnce();
    worker.stop();

    expect(state.botsService.listReviewDue).toHaveBeenCalledWith(AT, 100);
    expect(state.botsService.transitionLifecycle).toHaveBeenCalledWith(botId(7), {
      status: 'suspended',
      actor_user_id: 'system:agent-governance',
      note: 'Automatic suspension: review deadline elapsed at 2026-08-12T07:00:00.000Z.',
    });
    expect(state.notifications.createWithStatus).toHaveBeenCalledTimes(3);
    expect(
      state.notifications.createWithStatus.mock.calls.map(([entry]) => [entry.user_id, entry.kind]).sort(),
    ).toEqual([
      ['backup-7', 'agent_review_due'],
      ['owner-7', 'agent_review_due'],
      ['super-1', 'agent_review_due'],
    ]);
    expect(state.notifications.createWithStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: `bot:${botId(7)}`,
        dedupe_key: `agent-governance:review_due:${botId(7)}:v3:2026-08-12T08:00:01.000Z`,
      }),
    );
  });

  it('pages owner checks, isolates one transition failure, and keeps an active backup available', async () => {
    const first = profile(1, { user_id: 'disabled-1', next_review_at: '2027-01-01T00:00:00.000Z' });
    const second = profile(2, { user_id: 'disabled-2', next_review_at: '2027-01-01T00:00:00.000Z' });
    const third = profile(3, {
      user_id: 'disabled-3',
      owner_backup_user_id: 'backup-3',
      next_review_at: '2027-01-01T00:00:00.000Z',
    });
    const state = fakeDb({
      users: [
        user('disabled-1', { status: 'disabled' }),
        user('disabled-2', { status: 'disabled' }),
        user('disabled-3', { status: 'disabled' }),
        user('backup-3'),
        user('super-1', { role: 'super' }),
      ],
      ownership: async (_limit, afterId) => {
        if (afterId === '') return [candidate(first, 'disabled'), candidate(second, 'disabled')];
        if (afterId === botId(2)) return [candidate(third, 'disabled', 'active')];
        return [];
      },
    });
    state.botsService.transitionLifecycle
      .mockRejectedValueOnce(new Error('concurrent transition'))
      .mockResolvedValueOnce(
        profile(2, {
          user_id: 'disabled-2',
          lifecycle_status: 'suspended',
          is_shared: false,
          next_review_at: null,
          reviewed_by: 'system:agent-governance',
          updated_at: '2026-08-12T08:00:02.000Z',
        }),
      );
    const worker = await startAgentGovernanceWorker({
      db: state.db,
      pageSize: 2,
      skipBootPass: true,
      intervalMs: 60_000,
    });

    await worker.runOnce();
    worker.stop();

    expect(state.botsService.listActiveWithOwners.mock.calls).toEqual([
      [2, ''],
      [2, botId(2)],
    ]);
    expect(state.botsService.transitionLifecycle).toHaveBeenCalledTimes(2);
    expect(state.botsService.transitionLifecycle).toHaveBeenLastCalledWith(
      botId(2),
      expect.objectContaining({ status: 'suspended', actor_user_id: 'system:agent-governance' }),
    );
    expect(state.notifications.createWithStatus).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'super-1', kind: 'agent_suspended', agent_id: `bot:${botId(2)}` }),
    );
    expect(state.notifications.createWithStatus).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'backup-3', kind: 'agent_review_due', agent_id: `bot:${botId(3)}` }),
    );
    expect(state.botsService.transitionLifecycle).not.toHaveBeenCalledWith(botId(3), expect.anything());
  });

  it('recovers notifications after a transition-to-notification crash with one stable dedupe key', async () => {
    const suspended = profile(9, {
      lifecycle_status: 'suspended',
      lifecycle_note: 'Automatic suspension: review deadline elapsed at 2026-08-01T00:00:00.000Z.',
      reviewed_by: 'system:agent-governance',
      is_shared: false,
      next_review_at: null,
      updated_at: '2026-08-12T08:00:09.000Z',
    });
    const state = fakeDb({
      users: [user('owner-9'), user('super-1', { role: 'super' })],
      ownership: async () => [candidate(suspended, 'active')],
    });
    const worker = await startAgentGovernanceWorker({
      db: state.db,
      skipBootPass: true,
      intervalMs: 60_000,
    });

    await worker.runOnce();
    await worker.runOnce();
    worker.stop();

    expect(state.botsService.transitionLifecycle).not.toHaveBeenCalled();
    expect(state.notifications.createWithStatus).toHaveBeenCalledTimes(4);
    const keys = new Set(
      state.notifications.createWithStatus.mock.calls.map(([entry]) => `${entry.user_id}:${entry.dedupe_key}`),
    );
    expect(keys).toEqual(
      new Set([
        `owner-9:agent-governance:review_due:${botId(9)}:v3:2026-08-12T08:00:09.000Z`,
        `super-1:agent-governance:review_due:${botId(9)}:v3:2026-08-12T08:00:09.000Z`,
      ]),
    );
  });

  it('prevents overlapping passes and stops future manual work', async () => {
    let resolveUsers!: (value: UserRow[]) => void;
    const state = fakeDb({});
    state.users.list.mockReturnValueOnce(new Promise<UserRow[]>((resolve) => (resolveUsers = resolve)));
    const worker = await startAgentGovernanceWorker({
      db: state.db,
      skipBootPass: true,
      intervalMs: 60_000,
    });

    const first = worker.runOnce();
    await worker.runOnce();
    expect(state.users.list).toHaveBeenCalledOnce();
    resolveUsers([]);
    await first;

    worker.stop();
    await worker.runOnce();
    expect(state.users.list).toHaveBeenCalledOnce();
  });
});
