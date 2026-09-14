import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTaskRow } from '@greenhouse/db';

const mocks = vi.hoisted(() => ({
  db: {
    users: { getById: vi.fn() },
    scheduledTasks: {
      listEnabled: vi.fn(),
      list: vi.fn(),
      getById: vi.fn(),
      update: vi.fn(),
      updateRunStatus: vi.fn(),
      updateNextRunAt: vi.fn(),
    },
    sessions: {
      create: vi.fn(),
      addMessage: vi.fn(),
      addMessageOnce: vi.fn(),
      touch: vi.fn(),
    },
    notifications: {
      createWithStatus: vi.fn(),
      createDelivery: vi.fn(),
      countUnread: vi.fn(),
    },
  },
  enqueueAutomationRun: vi.fn(),
  cancelAutomationRunsForUser: vi.fn(),
  startFrictionMiningJob: vi.fn(),
  startMemoryConsolidationJob: vi.fn(),
  stopUpkeepJobs: vi.fn(),
}));

vi.mock('@greenhouse/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/db')>()),
  getDb: () => mocks.db,
}));

vi.mock('../runtime-driver.js', () => ({
  enqueueAutomationRun: mocks.enqueueAutomationRun,
  cancelAutomationRunsForUser: mocks.cancelAutomationRunsForUser,
}));

vi.mock('../upkeep-jobs.js', () => ({
  startFrictionMiningJob: mocks.startFrictionMiningJob,
  startMemoryConsolidationJob: mocks.startMemoryConsolidationJob,
  stopUpkeepJobs: mocks.stopUpkeepJobs,
  startExtensionJobs: vi.fn(),
}));

import { TaskScheduler } from '../index.js';

function task(overrides: Partial<ScheduledTaskRow> = {}): ScheduledTaskRow {
  return {
    id: 1,
    user_id: 'owner-1',
    name: 'Hourly check',
    profile_id: 'team',
    task_prompt: 'Review the latest internal updates',
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

describe('TaskScheduler owner authorization', () => {
  const schedulers: TaskScheduler[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.scheduledTasks.listEnabled.mockResolvedValue([]);
    mocks.db.scheduledTasks.updateRunStatus.mockResolvedValue(undefined);
    mocks.db.scheduledTasks.updateNextRunAt.mockResolvedValue(undefined);
    mocks.db.scheduledTasks.update.mockResolvedValue(undefined);
    mocks.db.scheduledTasks.list.mockResolvedValue([]);
    mocks.db.sessions.create.mockResolvedValue({ id: 'failure-session-1' });
    mocks.db.sessions.addMessage.mockResolvedValue(undefined);
    mocks.db.sessions.addMessageOnce.mockResolvedValue(undefined);
    mocks.db.sessions.touch.mockResolvedValue(undefined);
    mocks.db.notifications.createWithStatus.mockResolvedValue({
      created: true,
      notification: { id: 'notification-1', kind: 'runtime_failed', title: 'Hourly check needs review' },
    });
    mocks.db.notifications.createDelivery.mockResolvedValue(undefined);
    mocks.db.notifications.countUnread.mockResolvedValue(1);
    mocks.enqueueAutomationRun.mockResolvedValue({
      run: { id: 'runtime-1', status: 'queued' },
      session_id: 'session-1',
    });
    mocks.cancelAutomationRunsForUser.mockResolvedValue(0);
  });

  afterEach(() => {
    for (const scheduler of schedulers.splice(0)) scheduler.stop();
    vi.useRealTimers();
  });

  function createScheduler() {
    const scheduler = new TaskScheduler({});
    schedulers.push(scheduler);
    return scheduler;
  }

  it('only registers enabled tasks whose current owner is active team/super at startup', async () => {
    const allowed = task({ id: 1, user_id: 'active-team' });
    const disabled = task({ id: 2, user_id: 'disabled-team' });
    const external = task({ id: 3, user_id: 'legacy-external' });
    mocks.db.scheduledTasks.listEnabled.mockResolvedValue([allowed, disabled, external]);
    mocks.db.users.getById.mockImplementation(async (id: string) => {
      if (id === 'active-team') return { id, status: 'active', role: 'team' };
      if (id === 'disabled-team') return { id, status: 'disabled', role: 'team' };
      return { id, status: 'active', role: 'external' };
    });

    const scheduler = createScheduler();
    await scheduler.start();

    expect(scheduler.getStatus().activeJobs).toBe(1);
    expect(mocks.db.scheduledTasks.updateNextRunAt).toHaveBeenCalledTimes(1);
    expect(mocks.db.scheduledTasks.updateNextRunAt).toHaveBeenCalledWith(allowed.id, expect.any(String));
    expect(mocks.db.scheduledTasks.update).toHaveBeenCalledWith(disabled.id, { enabled: false });
    expect(mocks.db.scheduledTasks.update).toHaveBeenCalledWith(external.id, { enabled: false });
  });

  it('catches up only the latest planned occurrence inside the 24-hour window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T12:15:00.000Z'));
    const scheduled = task({ next_run_at: '2026-08-12T09:00:00.000Z' });
    mocks.db.scheduledTasks.listEnabled.mockResolvedValue([scheduled]);
    mocks.db.scheduledTasks.getById.mockResolvedValue(scheduled);
    mocks.db.users.getById.mockResolvedValue({ id: scheduled.user_id, status: 'active', role: 'team' });

    const scheduler = createScheduler();
    await scheduler.start();

    expect(mocks.enqueueAutomationRun).toHaveBeenCalledOnce();
    expect(mocks.enqueueAutomationRun).toHaveBeenCalledWith(
      expect.objectContaining({ task: scheduled, trigger: 'catchup' }),
    );
    const scheduledFor = mocks.enqueueAutomationRun.mock.calls[0]?.[0].scheduledFor as Date;
    expect(scheduledFor.toISOString()).toBe('2026-08-12T12:00:00.000Z');
  });

  it('marks an older latest occurrence missed without admitting execution', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T12:15:00.000Z'));
    const scheduled = task({ schedule: '0 0 * * 0', next_run_at: '2026-08-09T00:00:00.000Z' });
    mocks.db.scheduledTasks.listEnabled.mockResolvedValue([scheduled]);
    mocks.db.users.getById.mockResolvedValue({ id: scheduled.user_id, status: 'active', role: 'team' });

    const scheduler = createScheduler();
    await scheduler.start();

    expect(mocks.enqueueAutomationRun).not.toHaveBeenCalled();
    expect(mocks.db.scheduledTasks.updateRunStatus).toHaveBeenCalledWith(
      scheduled.id,
      'missed',
      '2026-08-16T00:00:00.000Z',
    );
  });

  it('pauses reset-required owners without disabling their automation configuration', async () => {
    const paused = task({ id: 4, user_id: 'resetting-team' });
    mocks.db.scheduledTasks.listEnabled.mockResolvedValue([paused]);
    mocks.db.users.getById.mockResolvedValue({ id: paused.user_id, status: 'reset_required', role: 'team' });

    const scheduler = createScheduler();
    await scheduler.start();

    expect(scheduler.getStatus().activeJobs).toBe(0);
    expect(mocks.db.scheduledTasks.update).not.toHaveBeenCalledWith(paused.id, { enabled: false });
  });

  it('removes and restores enabled jobs for an account-security pause', async () => {
    const scheduled = task();
    mocks.db.scheduledTasks.getById.mockResolvedValue(scheduled);
    mocks.db.scheduledTasks.list.mockResolvedValue([scheduled]);
    mocks.db.users.getById.mockResolvedValue({ id: scheduled.user_id, status: 'active', role: 'team' });
    const scheduler = createScheduler();
    await scheduler.reloadTask(scheduled.id);

    await scheduler.pauseUser(scheduled.user_id);
    expect(scheduler.getStatus().activeJobs).toBe(0);
    expect(mocks.db.scheduledTasks.update).not.toHaveBeenCalledWith(scheduled.id, { enabled: false });
    expect(mocks.cancelAutomationRunsForUser).toHaveBeenCalledWith(mocks.db, scheduled.user_id);

    await scheduler.resumeUser(scheduled.user_id);
    expect(scheduler.getStatus().activeJobs).toBe(1);
  });

  it('removes an existing cron registration when reload sees a disabled owner', async () => {
    const scheduled = task();
    mocks.db.scheduledTasks.getById.mockResolvedValue(scheduled);
    mocks.db.users.getById.mockResolvedValue({ id: scheduled.user_id, status: 'active', role: 'team' });

    const scheduler = createScheduler();
    await scheduler.reloadTask(scheduled.id);
    expect(scheduler.getStatus().activeJobs).toBe(1);

    mocks.db.users.getById.mockResolvedValue({ id: scheduled.user_id, status: 'disabled', role: 'team' });
    await scheduler.reloadTask(scheduled.id);

    expect(scheduler.getStatus().activeJobs).toBe(0);
  });

  it('re-checks the owner on every automatic run and never reaches the executor after revocation', async () => {
    const scheduled = task();
    mocks.db.scheduledTasks.getById.mockResolvedValue(scheduled);
    mocks.db.users.getById.mockResolvedValue({ id: scheduled.user_id, status: 'active', role: 'team' });

    const scheduler = createScheduler();
    await scheduler.reloadTask(scheduled.id);
    mocks.db.users.getById.mockResolvedValue({ id: scheduled.user_id, status: 'disabled', role: 'team' });

    await expect(scheduler.runTask(scheduled.id)).resolves.toBeNull();
    expect(mocks.enqueueAutomationRun).not.toHaveBeenCalled();
    expect(scheduler.getStatus().activeJobs).toBe(0);
    expect(mocks.db.scheduledTasks.update).toHaveBeenCalledWith(scheduled.id, { enabled: false });
  });

  it('does not execute a disabled task from an already queued cron callback', async () => {
    const scheduler = createScheduler();
    mocks.db.scheduledTasks.getById.mockResolvedValue(task({ enabled: false }));

    await expect(scheduler.runTask(1)).resolves.toBeNull();
    expect(mocks.db.users.getById).not.toHaveBeenCalled();
    expect(mocks.enqueueAutomationRun).not.toHaveBeenCalled();
  });

  it('delegates overlap prevention to durable Runtime admission', async () => {
    const scheduled = task();
    mocks.db.scheduledTasks.getById.mockResolvedValue(scheduled);
    mocks.db.users.getById.mockResolvedValue({ id: scheduled.user_id, status: 'active', role: 'team' });

    const scheduler = createScheduler();
    await expect(scheduler.runTask(scheduled.id)).resolves.toBe('session-1');
    expect(mocks.enqueueAutomationRun).toHaveBeenCalledWith(
      expect.objectContaining({ task: scheduled, trigger: 'cron' }),
    );
  });

  it('advances only the cron cursor when the exact occurrence is already terminal', async () => {
    const scheduled = task({ last_status: 'completed', run_count: 4 });
    mocks.db.scheduledTasks.getById.mockResolvedValue(scheduled);
    mocks.db.users.getById.mockResolvedValue({ id: scheduled.user_id, status: 'active', role: 'team' });
    mocks.enqueueAutomationRun.mockResolvedValueOnce({
      run: { id: 'runtime-complete', status: 'succeeded' },
      session_id: 'session-complete',
    });

    const scheduler = createScheduler();
    await expect(scheduler.runTask(scheduled.id, 'catchup', '2026-08-12T03:00:00.000Z')).resolves.toBe(
      'session-complete',
    );

    expect(mocks.db.scheduledTasks.updateNextRunAt).toHaveBeenCalledWith(scheduled.id, expect.any(String));
    expect(mocks.db.scheduledTasks.updateRunStatus).not.toHaveBeenCalled();
  });

  it('surfaces an enqueue failure on the task row, in a session, and through delivery', async () => {
    const scheduled = task({ profile_id: 'admin' });
    mocks.db.scheduledTasks.getById.mockResolvedValue(scheduled);
    mocks.db.users.getById.mockResolvedValue({ id: scheduled.user_id, status: 'active', role: 'team' });
    mocks.enqueueAutomationRun.mockRejectedValueOnce(new Error('Profile not found: "admin"'));

    const scheduler = createScheduler();
    await expect(scheduler.runTask(scheduled.id)).resolves.toBeNull();

    // A session records the failure so it shows up in run history…
    expect(mocks.db.sessions.create).toHaveBeenCalled();
    expect(mocks.db.sessions.addMessageOnce).toHaveBeenCalledWith(
      'automation-failed:failure-session-1',
      expect.objectContaining({ role: 'assistant', content: expect.stringContaining('Profile not found') }),
    );
    // …the task row leaves its stale last-run state…
    expect(mocks.db.scheduledTasks.updateRunStatus).toHaveBeenCalledWith(scheduled.id, 'failed', expect.any(String));
    // …and the owner's configured deliveries fire like any execution failure.
    expect(mocks.db.notifications.createWithStatus).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: scheduled.user_id, kind: 'runtime_failed' }),
    );
  });

  it('re-checks the owner for a pre-created manual-run session', async () => {
    const scheduled = task();
    mocks.db.scheduledTasks.getById.mockResolvedValue(scheduled);
    mocks.db.users.getById.mockResolvedValue({ id: scheduled.user_id, status: 'active', role: 'external' });

    const scheduler = createScheduler();
    await scheduler.runTaskManually(scheduled.id);

    expect(mocks.enqueueAutomationRun).not.toHaveBeenCalled();
    expect(mocks.db.scheduledTasks.update).toHaveBeenCalledWith(scheduled.id, { enabled: false });
  });

  it('persists a manual Runtime run before returning its session', async () => {
    const scheduled = task();
    mocks.db.scheduledTasks.getById.mockResolvedValue(scheduled);
    mocks.db.users.getById.mockResolvedValue({ id: scheduled.user_id, status: 'active', role: 'team' });

    const scheduler = createScheduler();
    await expect(scheduler.runTaskManually(scheduled.id, 'operator-1')).resolves.toBe('session-1');
    expect(mocks.enqueueAutomationRun).toHaveBeenCalledWith(
      expect.objectContaining({ task: scheduled, trigger: 'manual', initiatedByUserId: 'operator-1' }),
    );
  });
});
