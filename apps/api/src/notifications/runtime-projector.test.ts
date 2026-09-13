import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider, RuntimeRunRow } from '@greenhouse/db';

const ws = vi.hoisted(() => ({ sendToUser: vi.fn() }));
vi.mock('../ws/connection-manager.js', () => ({ connectionManager: ws }));

import { createRuntimeNotificationProjector } from './runtime-projector.js';

function succeededRun(): RuntimeRunRow {
  return {
    id: 'rtm_mission_1',
    kind: 'mission',
    owner_user_id: 'owner-1',
    initiated_by_user_id: 'owner-1',
    session_id: null,
    parent_run_id: null,
    root_run_id: 'rtm_mission_1',
    source_kind: 'agent_run',
    source_id: 'mission-1',
    idempotency_key: null,
    status: 'succeeded',
    desired_state: 'run',
    wait_reason: null,
    priority: 0,
    not_before: null,
    deadline_at: null,
    lease_owner: null,
    lease_expires_at: null,
    heartbeat_at: null,
    attempt: 1,
    max_attempts: 3,
    input: '{}',
    output: '{}',
    error_code: null,
    error_message: null,
    started_at: '2026-08-12 00:00:00+00',
    ended_at: '2026-08-12 00:01:00+00',
    settled_at: null,
    created_at: '2026-08-12 00:00:00+00',
    updated_at: '2026-08-12 00:01:00+00',
    version: 3,
  };
}

describe('Runtime notification projector', () => {
  beforeEach(() => vi.clearAllMocks());

  it('projects adapter domain-command terminal events and only pushes newly-created facts', async () => {
    const createWithStatus = vi
      .fn()
      .mockResolvedValueOnce({
        created: true,
        notification: { id: 'ntf-1', user_id: 'owner-1', kind: 'runtime_completed', run_id: 'rtm_mission_1' },
      })
      .mockResolvedValueOnce({
        created: false,
        notification: { id: 'ntf-1', user_id: 'owner-1', kind: 'runtime_completed', run_id: 'rtm_mission_1' },
      });
    const db = {
      runtime: { getRun: vi.fn().mockResolvedValue(succeededRun()) },
      notifications: { createWithStatus, countUnread: vi.fn().mockResolvedValue(1) },
    } as unknown as DatabaseProvider;
    const projector = createRuntimeNotificationProjector(db);
    const event = {
      event_id: 'rte-1',
      run_id: 'rtm_mission_1',
      step_id: null,
      seq: 4,
      type: 'run.domain_commanded',
      payload: { result: { status: 'succeeded', version: 3 } },
      actor_user_id: 'owner-1',
      created_at: '2026-08-12T00:01:00.000Z',
    } as const;

    await projector(event);
    await projector(event);

    expect(createWithStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'owner-1',
        kind: 'runtime_completed',
        run_id: 'rtm_mission_1',
        dedupe_key: 'runtime-terminal:rtm_mission_1:succeeded:3',
      }),
    );
    expect(ws.sendToUser).toHaveBeenCalledTimes(1);
  });

  it('ignores non-terminal historical transitions even when the current run is already terminal', async () => {
    const createWithStatus = vi.fn();
    const db = {
      runtime: { getRun: vi.fn().mockResolvedValue(succeededRun()) },
      notifications: { createWithStatus, countUnread: vi.fn() },
    } as unknown as DatabaseProvider;

    await createRuntimeNotificationProjector(db)({
      event_id: 'rte-running',
      run_id: 'rtm_mission_1',
      step_id: null,
      seq: 2,
      type: 'run.status_changed',
      payload: { result: { status: 'running', version: 2 } },
      actor_user_id: 'owner-1',
      created_at: '2026-08-12T00:00:30.000Z',
    });

    expect(createWithStatus).not.toHaveBeenCalled();
  });

  it('honors the immutable suppression policy on a historical terminal transition', async () => {
    const getRun = vi.fn();
    const createWithStatus = vi.fn();
    const db = {
      runtime: { getRun },
      notifications: { createWithStatus, countUnread: vi.fn() },
    } as unknown as DatabaseProvider;

    await createRuntimeNotificationProjector(db)({
      event_id: 'rte-backfill-terminal',
      run_id: 'rtm_mission_1',
      step_id: null,
      seq: 3,
      type: 'run.status_changed',
      payload: {
        notification_policy: 'suppress',
        result: { status: 'succeeded', version: 3 },
      },
      actor_user_id: 'owner-1',
      created_at: '2026-08-12T00:01:00.000Z',
    });

    expect(getRun).not.toHaveBeenCalled();
    expect(createWithStatus).not.toHaveBeenCalled();
    expect(ws.sendToUser).not.toHaveBeenCalled();
  });

  it('does not turn every ordinary Chat reply into an inbox notification', async () => {
    const chatRun = { ...succeededRun(), id: 'rtr-chat-1', kind: 'chat' as const, source_kind: 'chat_turn' };
    const createWithStatus = vi.fn();
    const db = {
      runtime: { getRun: vi.fn().mockResolvedValue(chatRun) },
      notifications: { createWithStatus, countUnread: vi.fn() },
    } as unknown as DatabaseProvider;

    await createRuntimeNotificationProjector(db)({
      event_id: 'rte-chat-terminal',
      run_id: chatRun.id,
      step_id: null,
      seq: 3,
      type: 'run.status_changed',
      payload: { result: { status: 'succeeded', version: 3 } },
      actor_user_id: 'owner-1',
      created_at: '2026-08-12T00:01:00.000Z',
    });

    expect(createWithStatus).not.toHaveBeenCalled();
    expect(ws.sendToUser).not.toHaveBeenCalled();
  });

  it('leaves Automation terminal facts to the richer durable task projector', async () => {
    const automationRun = {
      ...succeededRun(),
      id: 'rtr-automation-1',
      kind: 'automation' as const,
      source_kind: 'scheduled_task:42',
    };
    const createWithStatus = vi.fn();
    const db = {
      runtime: { getRun: vi.fn().mockResolvedValue(automationRun) },
      notifications: { createWithStatus, countUnread: vi.fn() },
    } as unknown as DatabaseProvider;

    await createRuntimeNotificationProjector(db)({
      event_id: 'rte-automation-terminal',
      run_id: automationRun.id,
      step_id: null,
      seq: 3,
      type: 'run.status_changed',
      payload: { result: { status: 'succeeded', version: 3 } },
      actor_user_id: 'owner-1',
      created_at: '2026-08-12T00:01:00.000Z',
    });

    expect(createWithStatus).not.toHaveBeenCalled();
    expect(ws.sendToUser).not.toHaveBeenCalled();
  });
});
