/**
 * Blast-radius tests for the Automation tools (automation_query /
 * automation_mutation) and the task-center rules they share with /api/tasks.
 *
 * These tools hand an LLM the ability to schedule unattended agent runs on the
 * user's behalf, so the boundaries that matter are: only your OWN automations
 * (a hallucinated id must not reach someone else's), the quota and the 1-hour
 * floor hold on this path too (they are the cost ceiling), and switching an
 * existing automation onto a hidden profile is refused exactly like creating on
 * one — otherwise create-then-switch walks around the gate.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';

const scheduler = {
  reloadTask: vi.fn(async () => {}),
  removeJob: vi.fn(() => {}),
  runTaskManually: vi.fn(async () => 'session-new'),
};
let schedulerAvailable = true;

vi.mock('../../scheduler/index.js', () => ({
  getScheduler: () => (schedulerAvailable ? scheduler : null),
}));

vi.mock('../../profiles/profile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../profiles/profile.js')>();
  const profile = (id: string, level: 'internal' | 'hidden') => ({
    id,
    name: id,
    access: { level, rich_output: false },
    model: { id: 'flash', provider: 'test', model: 'test' },
    tools: [],
    system_prompt: '',
  });
  return {
    ...actual,
    resolveProfileAsync: async (id?: string | null) => {
      if (id === 'hidden-only') return profile(id, 'hidden');
      return profile(actual.normalizeProfileId(id) ?? actual.DEFAULT_PROFILE_ID, 'internal');
    },
  };
});

const { createAutomationQueryTool } = await import('../automation-query.js');
const { createAutomationMutationTool } = await import('../automation-mutation.js');

interface Row {
  id: number;
  user_id: string;
  name: string;
  profile_id: string;
  task_prompt: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  max_steps: number;
  last_run_at: string | null;
  last_status: string | null;
  next_run_at: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    user_id: 'owner-1',
    name: 'Daily digest',
    profile_id: 'team',
    task_prompt: 'Summarize yesterday of the CRM follow-ups.',
    schedule: '0 9 * * *',
    timezone: 'Asia/Hong_Kong',
    enabled: true,
    max_steps: 15,
    last_run_at: null,
    last_status: null,
    next_run_at: null,
    run_count: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeDb(rows: Row[] = [], sessions: Record<number, unknown[]> = {}) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  let seq = Math.max(0, ...store.keys());
  const db = {
    scheduledTasks: {
      async getById(id: number) {
        return store.get(id);
      },
      async list(userId?: string) {
        return [...store.values()].filter((r) => !userId || r.user_id === userId);
      },
      async countByUser(userId: string) {
        return [...store.values()].filter((r) => r.user_id === userId).length;
      },
      async create(input: Record<string, unknown>) {
        const created = row({ ...(input as Partial<Row>), id: ++seq });
        store.set(created.id, created);
        return created;
      },
      async update(id: number, updates: Record<string, unknown>) {
        const existing = store.get(id);
        if (!existing) return undefined;
        Object.assign(existing, updates);
        return existing;
      },
      async delete(id: number) {
        store.delete(id);
      },
    },
    sessions: {
      async list({ taskId }: { taskId?: number }) {
        return sessions[taskId ?? -1] ?? [];
      },
    },
  } as unknown as DatabaseProvider;
  return { db, store };
}

type ToolLike = { execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> };
const asTool = (t: unknown) => t as unknown as ToolLike;

const OWNER = { userId: 'owner-1', userRole: 'team' };

beforeEach(() => {
  schedulerAvailable = true;
  scheduler.reloadTask.mockClear();
  scheduler.removeJob.mockClear();
  scheduler.runTaskManually.mockClear();
});

describe('automation_query', () => {
  it('lists only the caller’s own automations', async () => {
    const { db } = fakeDb([row({ id: 1 }), row({ id: 2, user_id: 'someone-else', name: 'Theirs' })]);
    const result = await asTool(createAutomationQueryTool(db, OWNER)).execute({ action: 'list' });

    expect(result.count).toBe(1);
    expect((result.automations as Row[])[0]!.id).toBe(1);
  });

  it('does not widen for a super — the tool surface is owner-only', async () => {
    const { db } = fakeDb([row({ id: 1 }), row({ id: 2, user_id: 'someone-else' })]);
    const tool = asTool(createAutomationQueryTool(db, { userId: 'owner-1', userRole: 'super' }));

    expect((await tool.execute({ action: 'list' })).count).toBe(1);
    expect(await tool.execute({ action: 'get', id: 2 })).toMatchObject({ error: 'Not authorized' });
  });

  it('returns recent runs so the model can tell whether it actually fired', async () => {
    const { db } = fakeDb([row({ id: 7 })], {
      7: [{ id: 'sess-a', title: 'Daily digest', status: 'active', created_at: '2026-08-02T01:00:00.000Z' }],
    });
    const result = await asTool(createAutomationQueryTool(db, OWNER)).execute({ action: 'get', id: 7 });

    expect(result.recent_runs).toEqual([
      { session_id: 'sess-a', title: 'Daily digest', status: 'active', created_at: '2026-08-02T01:00:00.000Z' },
    ]);
    expect((result.automation as { schedule_desc: string }).schedule_desc).toMatch(/^Next: /);
  });

  it('reports a missing automation instead of inventing one', async () => {
    const { db } = fakeDb([]);
    expect(await asTool(createAutomationQueryTool(db, OWNER)).execute({ action: 'get', id: 99 })).toMatchObject({
      error: 'Task not found',
    });
  });
});

describe('automation_mutation — create', () => {
  it('creates and registers the cron job', async () => {
    const { db, store } = fakeDb([]);
    const result = await asTool(createAutomationMutationTool(db, OWNER)).execute({
      action: 'create',
      name: 'Weekday digest',
      task_prompt: 'Summarize yesterday of the CRM follow-ups.',
      schedule: '0 9 * * 1-5',
    });

    expect(result.status).toBe('created');
    expect(store.size).toBe(1);
    expect(scheduler.reloadTask).toHaveBeenCalledTimes(1);
  });

  it('enforces the 1-hour floor (the cost ceiling for unattended runs)', async () => {
    const { db, store } = fakeDb([]);
    const result = await asTool(createAutomationMutationTool(db, OWNER)).execute({
      action: 'create',
      name: 'Too eager',
      task_prompt: 'Check everything again and again.',
      schedule: '*/5 * * * *',
    });

    expect(result).toMatchObject({ error: 'Minimum interval is 1 hour' });
    expect(store.size).toBe(0);
  });

  it('enforces the per-user quota', async () => {
    const { db } = fakeDb(Array.from({ length: 10 }, (_, i) => row({ id: i + 1 })));
    const result = await asTool(createAutomationMutationTool(db, OWNER)).execute({
      action: 'create',
      name: 'One too many',
      task_prompt: 'Summarize yesterday of the CRM follow-ups.',
      schedule: '0 9 * * *',
    });

    expect(result).toMatchObject({ error: 'Maximum 10 tasks per user' });
    expect(scheduler.reloadTask).not.toHaveBeenCalled();
  });

  it('refuses hidden integration profiles', async () => {
    const { db } = fakeDb([]);
    const result = await asTool(createAutomationMutationTool(db, OWNER)).execute({
      action: 'create',
      name: 'Sneaky',
      task_prompt: 'Summarize yesterday of the CRM follow-ups.',
      schedule: '0 9 * * *',
      profile_id: 'hidden-only',
    });

    expect(result.error).toMatch(/not available/);
  });

  it('rejects a too-short prompt rather than scheduling a vague run', async () => {
    const { db } = fakeDb([]);
    const result = await asTool(createAutomationMutationTool(db, OWNER)).execute({
      action: 'create',
      name: 'Vague',
      task_prompt: 'hi',
      schedule: '0 9 * * *',
    });

    expect(result.error).toMatch(/10-4000 characters/);
  });
});

describe('automation_mutation — update / delete / run_now', () => {
  it('pauses via enabled:false without deleting the definition', async () => {
    const { db, store } = fakeDb([row({ id: 3 })]);
    const result = await asTool(createAutomationMutationTool(db, OWNER)).execute({
      action: 'update',
      id: 3,
      enabled: false,
    });

    expect(result.status).toBe('updated');
    expect(store.get(3)!.enabled).toBe(false);
    expect(store.size).toBe(1);
    expect(scheduler.reloadTask).toHaveBeenCalledWith(3);
  });

  it('refuses switching an existing automation onto a hidden profile', async () => {
    const { db, store } = fakeDb([row({ id: 3 })]);
    const result = await asTool(createAutomationMutationTool(db, OWNER)).execute({
      action: 'update',
      id: 3,
      profile_id: 'hidden-only',
    });

    expect(result.error).toMatch(/not available/);
    expect(store.get(3)!.profile_id).toBe('team');
  });

  it('cannot touch another user’s automation', async () => {
    const { db, store } = fakeDb([row({ id: 4, user_id: 'someone-else' })]);
    const tool = asTool(createAutomationMutationTool(db, OWNER));

    expect(await tool.execute({ action: 'update', id: 4, enabled: false })).toMatchObject({ error: 'Not authorized' });
    expect(await tool.execute({ action: 'delete', id: 4 })).toMatchObject({ error: 'Not authorized' });
    expect(await tool.execute({ action: 'run_now', id: 4 })).toMatchObject({ error: 'Not authorized' });
    expect(store.get(4)!.enabled).toBe(true);
    expect(scheduler.runTaskManually).not.toHaveBeenCalled();
  });

  it('deletes the row and removes the cron job', async () => {
    const { db, store } = fakeDb([row({ id: 5, name: 'Obsolete' })]);
    const result = await asTool(createAutomationMutationTool(db, OWNER)).execute({ action: 'delete', id: 5 });

    expect(result).toMatchObject({ status: 'deleted', name: 'Obsolete' });
    expect(store.size).toBe(0);
    expect(scheduler.removeJob).toHaveBeenCalledWith(5);
  });

  it('run_now returns the session id so the user can open the result', async () => {
    const { db } = fakeDb([row({ id: 6 })]);
    const result = await asTool(createAutomationMutationTool(db, OWNER)).execute({ action: 'run_now', id: 6 });

    expect(result).toMatchObject({ status: 'started', session_id: 'session-new' });
  });

  it('reports a concurrent run instead of creating an orphan session', async () => {
    scheduler.runTaskManually.mockResolvedValueOnce(null as unknown as string);
    const { db } = fakeDb([row({ id: 6 })]);
    const result = await asTool(createAutomationMutationTool(db, OWNER)).execute({ action: 'run_now', id: 6 });

    expect(result.error).toMatch(/already running/);
  });

  it('says so when the scheduler is not running rather than silently no-op', async () => {
    schedulerAvailable = false;
    const { db } = fakeDb([row({ id: 6 })]);
    const result = await asTool(createAutomationMutationTool(db, OWNER)).execute({ action: 'run_now', id: 6 });

    expect(result).toMatchObject({ error: 'Scheduler not initialized' });
  });

  it('requires an id for the actions that need one', async () => {
    const { db } = fakeDb([row({ id: 6 })]);
    const tool = asTool(createAutomationMutationTool(db, OWNER));

    expect(await tool.execute({ action: 'update', enabled: false })).toMatchObject({
      error: 'id is required for update',
    });
    expect(await tool.execute({ action: 'delete' })).toMatchObject({ error: 'id is required for delete' });
  });
});

describe('task-limits stays a leaf module', () => {
  /**
   * The tool description interpolates these limits, so they are read while the
   * tool module body runs — and the tool catalog sits on an import cycle
   * (registry → agent → scheduler → task-center → back here). When the limits
   * lived in task-center.ts they were still in the temporal dead zone at that
   * point and the API died at boot with "Cannot access 'MIN_PROMPT_LENGTH'
   * before initialization". No unit test saw it: tests enter the graph from the
   * tool file, the server enters from the app entry. Keeping task-limits.ts
   * import-free is what makes the cycle harmless.
   */
  it('has no imports, so it can never be caught in the cycle’s dead zone', () => {
    const source = readFileSync(new URL('../../scheduler/task-limits.ts', import.meta.url), 'utf8');
    const imports = source.match(/^\s*import\s/gm) ?? [];
    expect(imports, 'task-limits.ts must import nothing — see the header comment').toEqual([]);
  });

  it('is where the tools read their limits from (not task-center)', () => {
    const source = readFileSync(new URL('../automation-mutation.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/MAX_TASKS_PER_USER[\s\S]*?from '\.\.\/scheduler\/task-limits\.js'/);
  });
});
