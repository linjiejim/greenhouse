/**
 * Scheduled task service — automation definitions (`automations`) and their
 * terminal-outcome ledger (`automation_occurrences`).
 *
 * Where a finished run is reported lives in one `notify` object
 * (`AutomationNotify`); updates merge into it key by key.
 */

import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import {
  automationOccurrences as scheduledTaskRuntimeOccurrences,
  automations as scheduledTasks,
  runs as runtimeRuns,
} from '../schema/index.js';
import type { AutomationNotify, RuntimeRunRow, RuntimeStepRow, ScheduledTaskRow } from '../schema/index.js';
import { createRuntimeService, type RuntimeRunCreateInput, type RuntimeStepCreateInput } from './runtime.js';

export interface ScheduledTaskInput {
  user_id: string;
  name: string;
  profile_id?: string;
  task_prompt: string;
  schedule: string;
  timezone?: string;
  max_steps?: number;
  enabled?: boolean;
  notify?: Partial<AutomationNotify>;
  quiet_when_empty?: boolean;
  /** Tool ids granted to unattended runs (a filter, never a grant; see automation-tools). */
  unattended_tools?: string[];
}

export interface ScheduledTaskUpdateInput {
  name?: string;
  profile_id?: string;
  task_prompt?: string;
  schedule?: string;
  timezone?: string;
  max_steps?: number;
  enabled?: boolean;
  /** Merged into the stored object: only the keys given change. */
  notify?: Partial<AutomationNotify>;
  quiet_when_empty?: boolean;
  unattended_tools?: string[];
}

export class ScheduledTaskActiveRunError extends Error {
  constructor() {
    super('Cannot delete an Automation while one of its runs is active; cancel it first');
    this.name = 'ScheduledTaskActiveRunError';
  }
}

export class ScheduledTaskAdmissionError extends Error {
  constructor() {
    super('Scheduled task was deleted or changed before the Automation occurrence was admitted');
    this.name = 'ScheduledTaskAdmissionError';
  }
}

export interface ScheduledTaskRuntimeAdmissionInput {
  task_id: string;
  expected_user_id: string;
  expected_profile_id: string;
  expected_definition: Pick<
    ScheduledTaskRow,
    | 'name'
    | 'task_prompt'
    | 'schedule'
    | 'timezone'
    | 'enabled'
    | 'max_steps'
    | 'notify'
    | 'quiet_when_empty'
    | 'unattended_tools'
  >;
  run: RuntimeRunCreateInput;
  step: Omit<RuntimeStepCreateInput, 'run_id'>;
}

export interface ScheduledTaskRuntimeAdmissionResult {
  task: ScheduledTaskRow;
  run: RuntimeRunRow;
  step: RuntimeStepRow;
}

export interface ProjectScheduledTaskRuntimeOutcomeInput {
  runtime_run_id: string;
  runtime_version: number;
  task_id: string;
  owner_user_id: string;
  source_kind: string;
  status: 'succeeded' | 'failed' | 'canceled' | 'interrupted';
  scheduled_for: string;
  run_created_at: string;
}

/** A complete notify object: missing keys take their defaults, a blank webhook is none. */
export function normalizeNotify(value: Partial<AutomationNotify> | null | undefined): AutomationNotify {
  const webhook = typeof value?.webhook === 'string' && value.webhook.trim() ? value.webhook.trim() : null;
  return {
    webhook,
    email: value?.email === true,
    wecom: value?.wecom === true,
    feishu: value?.feishu === true,
  };
}

function sameNotify(left: AutomationNotify, right: AutomationNotify): boolean {
  const a = normalizeNotify(left);
  const b = normalizeNotify(right);
  return a.webhook === b.webhook && a.email === b.email && a.wecom === b.wecom && a.feishu === b.feishu;
}

function sameToolList(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function createScheduledTaskService(db: Db) {
  const service = {
    async create(input: ScheduledTaskInput): Promise<ScheduledTaskRow> {
      const now = nowIso();
      const [inserted] = await db
        .insert(scheduledTasks)
        .values({
          id: newId('automation'),
          user_id: input.user_id,
          name: input.name,
          profile_id: input.profile_id ?? 'team',
          task_prompt: input.task_prompt,
          schedule: input.schedule,
          timezone: input.timezone ?? 'UTC',
          max_steps: input.max_steps ?? 15,
          enabled: input.enabled ?? true,
          notify: normalizeNotify(input.notify),
          quiet_when_empty: input.quiet_when_empty ?? false,
          unattended_tools: input.unattended_tools ?? [],
          created_at: now,
          updated_at: now,
        })
        .returning();
      return inserted!;
    },

    async getById(id: string): Promise<ScheduledTaskRow | undefined> {
      const rows = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id));
      return rows[0];
    },

    async list(userId?: string): Promise<ScheduledTaskRow[]> {
      if (userId) {
        return await db
          .select()
          .from(scheduledTasks)
          .where(eq(scheduledTasks.user_id, userId))
          .orderBy(desc(scheduledTasks.created_at));
      }
      return await db.select().from(scheduledTasks).orderBy(desc(scheduledTasks.created_at));
    },

    async listEnabled(): Promise<ScheduledTaskRow[]> {
      return await db
        .select()
        .from(scheduledTasks)
        .where(eq(scheduledTasks.enabled, true))
        .orderBy(desc(scheduledTasks.created_at));
    },

    async update(id: string, updates: ScheduledTaskUpdateInput): Promise<ScheduledTaskRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.name !== undefined) set.name = updates.name;
      if (updates.profile_id !== undefined) set.profile_id = updates.profile_id;
      if (updates.task_prompt !== undefined) set.task_prompt = updates.task_prompt;
      if (updates.schedule !== undefined) set.schedule = updates.schedule;
      if (updates.timezone !== undefined) set.timezone = updates.timezone;
      if (updates.max_steps !== undefined) set.max_steps = updates.max_steps;
      if (updates.enabled !== undefined) set.enabled = updates.enabled;
      if (updates.notify !== undefined) {
        const [current] = await db
          .select({ notify: scheduledTasks.notify })
          .from(scheduledTasks)
          .where(eq(scheduledTasks.id, id))
          .limit(1);
        if (!current) return undefined;
        set.notify = normalizeNotify({ ...current.notify, ...updates.notify });
      }
      if (updates.quiet_when_empty !== undefined) set.quiet_when_empty = updates.quiet_when_empty;
      if (updates.unattended_tools !== undefined) set.unattended_tools = updates.unattended_tools;
      if (updates.enabled === false) set.next_run_at = null;

      const [updated] = await db.update(scheduledTasks).set(set).where(eq(scheduledTasks.id, id)).returning();
      return updated;
    },

    async updateRunStatus(id: string, status: string, nextRunAt?: string | null): Promise<void> {
      const set: Record<string, unknown> = {
        last_status: status,
        updated_at: nowIso(),
      };
      if (status === 'completed' || status === 'failed') {
        set.last_run_at = nowIso();
      }
      if (nextRunAt !== undefined) {
        set.next_run_at = nextRunAt;
      }

      // For run_count increment, use raw SQL
      if (status === 'completed') {
        await db
          .update(scheduledTasks)
          .set({
            ...set,
            run_count: sql`${scheduledTasks.run_count} + 1`,
          })
          .where(eq(scheduledTasks.id, id));
      } else {
        await db.update(scheduledTasks).set(set).where(eq(scheduledTasks.id, id));
      }
    },

    /** Advance only the cron cursor without rewriting or recounting a terminal run. */
    async updateNextRunAt(id: string, nextRunAt: string | null): Promise<void> {
      await db
        .update(scheduledTasks)
        .set({ next_run_at: nextRunAt, updated_at: nowIso() })
        .where(eq(scheduledTasks.id, id));
    },

    /**
     * Exactly-once terminal Runtime → mutable task-summary projection.
     *
     * The occurrence insert and run_count increment share one transaction.
     * A delayed older outbox event still records its permanent occurrence but
     * cannot overwrite the status of a newer admitted Runtime Run.
     */
    async projectRuntimeOutcome(
      input: ProjectScheduledTaskRuntimeOutcomeInput,
    ): Promise<{ created: boolean; task_updated: boolean }> {
      return db.transaction(async (tx) => {
        const [created] = await tx
          .insert(scheduledTaskRuntimeOccurrences)
          .values({
            runtime_run_id: input.runtime_run_id,
            task_id: input.task_id,
            owner_user_id: input.owner_user_id,
            status: input.status,
            runtime_version: input.runtime_version,
            scheduled_for: new Date(input.scheduled_for).toISOString(),
            run_created_at: new Date(input.run_created_at).toISOString(),
            projected_at: nowIso(),
          })
          .onConflictDoNothing({ target: scheduledTaskRuntimeOccurrences.runtime_run_id })
          .returning();
        if (!created) {
          const [existing] = await tx
            .select()
            .from(scheduledTaskRuntimeOccurrences)
            .where(eq(scheduledTaskRuntimeOccurrences.runtime_run_id, input.runtime_run_id))
            .limit(1);
          if (
            !existing ||
            existing.task_id !== input.task_id ||
            existing.owner_user_id !== input.owner_user_id ||
            existing.status !== input.status ||
            existing.runtime_version !== input.runtime_version ||
            Date.parse(existing.scheduled_for) !== Date.parse(input.scheduled_for) ||
            Date.parse(existing.run_created_at) !== Date.parse(input.run_created_at)
          ) {
            throw new ScheduledTaskAdmissionError();
          }
          return { created: false, task_updated: false };
        }

        const [newerRun] = await tx
          .select({ id: runtimeRuns.id })
          .from(runtimeRuns)
          .where(
            and(
              eq(runtimeRuns.kind, 'automation'),
              eq(runtimeRuns.source_kind, input.source_kind),
              or(
                gt(runtimeRuns.created_at, new Date(input.run_created_at).toISOString()),
                and(
                  eq(runtimeRuns.created_at, new Date(input.run_created_at).toISOString()),
                  gt(runtimeRuns.id, input.runtime_run_id),
                ),
              ),
            ),
          )
          .limit(1);

        const taskStatus = input.status === 'succeeded' ? 'completed' : input.status;
        const [updated] = await tx
          .update(scheduledTasks)
          .set({
            ...(newerRun ? {} : { last_status: taskStatus, last_run_at: new Date(input.scheduled_for).toISOString() }),
            ...(input.status === 'succeeded' ? { run_count: sql`${scheduledTasks.run_count} + 1` } : {}),
            updated_at: nowIso(),
          })
          .where(and(eq(scheduledTasks.id, input.task_id), eq(scheduledTasks.user_id, input.owner_user_id)))
          .returning({ id: scheduledTasks.id });
        return { created: true, task_updated: Boolean(updated) };
      });
    },

    /**
     * Serialize Automation admission against deletion of its mutable task row.
     * The same row lock is acquired by `delete`, so either the Runtime Run is
     * visible and deletion returns a conflict, or deletion wins and no new Run
     * can be created from a stale scheduler snapshot.
     */
    async admitRuntimeOccurrence(
      input: ScheduledTaskRuntimeAdmissionInput,
    ): Promise<ScheduledTaskRuntimeAdmissionResult> {
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [task] = await tx
          .select()
          .from(scheduledTasks)
          .where(eq(scheduledTasks.id, input.task_id))
          .for('update')
          .limit(1);
        if (
          !task ||
          task.user_id !== input.expected_user_id ||
          task.profile_id !== input.expected_profile_id ||
          task.name !== input.expected_definition.name ||
          task.task_prompt !== input.expected_definition.task_prompt ||
          task.schedule !== input.expected_definition.schedule ||
          task.timezone !== input.expected_definition.timezone ||
          task.enabled !== input.expected_definition.enabled ||
          task.max_steps !== input.expected_definition.max_steps ||
          !sameNotify(task.notify, input.expected_definition.notify) ||
          task.quiet_when_empty !== input.expected_definition.quiet_when_empty ||
          // The granted tool set is part of the definition being executed: an
          // occurrence admitted against an older grant must not run with a
          // newer one (in either direction).
          !sameToolList(task.unattended_tools, input.expected_definition.unattended_tools) ||
          input.run.kind !== 'automation' ||
          input.run.owner_user_id !== input.expected_user_id ||
          input.run.source_kind !== `scheduled_task:${input.task_id}`
        ) {
          throw new ScheduledTaskAdmissionError();
        }

        const runtime = createRuntimeService(tx);
        const run = await runtime.createRun(input.run);
        const step = await runtime.createStep({ ...input.step, run_id: run.id });
        return { task, run, step };
      });
    },

    async delete(id: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [task] = await tx
          .select({ id: scheduledTasks.id })
          .from(scheduledTasks)
          .where(eq(scheduledTasks.id, id))
          .for('update')
          .limit(1);
        if (!task) return false;
        const [active] = await tx
          .select({ id: runtimeRuns.id })
          .from(runtimeRuns)
          .where(
            and(
              eq(runtimeRuns.kind, 'automation'),
              eq(runtimeRuns.source_kind, `scheduled_task:${id}`),
              inArray(runtimeRuns.status, ['queued', 'claimed', 'running', 'waiting', 'paused']),
            ),
          )
          .limit(1)
          .for('update');
        if (active) throw new ScheduledTaskActiveRunError();
        const result = await tx.delete(scheduledTasks).where(eq(scheduledTasks.id, id)).returning();
        return result.length > 0;
      });
    },

    async countByUser(userId: string): Promise<number> {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(scheduledTasks)
        .where(eq(scheduledTasks.user_id, userId));
      return rows[0]?.count ?? 0;
    },
  };
  return service;
}

export type ScheduledTaskService = ReturnType<typeof createScheduledTaskService>;
