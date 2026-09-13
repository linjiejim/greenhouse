/**
 * Validation messages for scheduled tasks (task-center.ts).
 *
 * These strings are the model's only feedback when a create/update is refused,
 * so they are contract, not decoration: a bare "max_steps must be 1-20" named
 * neither the value that was rejected nor a way forward, and dev saw the same
 * 30 re-sent unchanged. The stubs below therefore throw on every write — a
 * refused value must never reach one.
 */

import { describe, expect, it } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { createTask, updateTask } from '../task-center.js';

const actor = { userId: 'u1', role: 'team' as const, scope: 'own' as const };

/** Rejects any DB access at all — createTask validates before it reads. */
const noDb = new Proxy(
  {},
  {
    get() {
      throw new Error('validation must reject before touching the database');
    },
  },
) as DatabaseProvider;

/**
 * updateTask has to load the task first: the ownership check must precede
 * validation, or the error message tells a stranger whether the id exists.
 * So the read is allowed here and only the write is fatal.
 */
const readOnlyDb = {
  scheduledTasks: {
    getById: async () => ({ id: 1, user_id: 'u1' }),
    update: async () => {
      throw new Error('validation must reject before writing');
    },
  },
} as unknown as DatabaseProvider;

const validInput = {
  name: 'Daily digest',
  task_prompt: 'Summarize yesterday for the team, in Chinese.',
  schedule: '0 9 * * *',
};

describe('scheduled task validation — max_steps', () => {
  it('quotes the refused value and points somewhere on create', async () => {
    const result = await createTask(noDb, actor, { ...validInput, max_steps: 30 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"30"');
      expect(result.error).toContain('1-20');
      expect(result.error).toMatch(/automation/i);
    }
  });

  it('gives the same answer on update', async () => {
    const result = await updateTask(readOnlyDb, actor, 1, { max_steps: 30 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"30"');
      expect(result.error).toMatch(/automation/i);
    }
  });

  it('tells a value under the range to go up, not down', async () => {
    // "0 is over the cap, lower it" is the kind of advice that gets followed.
    const result = await createTask(noDb, actor, { ...validInput, max_steps: 0 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"0"');
      expect(result.error).toMatch(/at least 1/i);
      expect(result.error).not.toMatch(/lower it/i);
    }
  });

  it('accepts the boundary values', async () => {
    // Both pass validation and go on to hit the DB stub, which is the proof
    // they were not rejected.
    await expect(createTask(noDb, actor, { ...validInput, max_steps: 1 })).rejects.toThrow(/database/);
    await expect(createTask(noDb, actor, { ...validInput, max_steps: 20 })).rejects.toThrow(/database/);
  });
});
