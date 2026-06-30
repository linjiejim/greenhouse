/**
 * Scheduled task service — automated Agent task definitions CRUD (PostgreSQL).
 */

import { eq, desc } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { scheduledTasks } from '../schema/index.js';
import type { ScheduledTaskRow } from '../schema/scheduled-task.js';

export interface ScheduledTaskInput {
  user_id: string;
  name: string;
  profile_id?: string;
  task_prompt: string;
  schedule: string;
  timezone?: string;
  max_steps?: number;
  enabled?: boolean;
}

export interface ScheduledTaskUpdateInput {
  name?: string;
  profile_id?: string;
  task_prompt?: string;
  schedule?: string;
  timezone?: string;
  max_steps?: number;
  enabled?: boolean;
}

export function createScheduledTaskService(db: Db) {
  const service = {
    async create(input: ScheduledTaskInput): Promise<ScheduledTaskRow> {
      const now = nowIso();
      const [inserted] = await db
        .insert(scheduledTasks)
        .values({
          user_id: input.user_id,
          name: input.name,
          profile_id: input.profile_id ?? 'default',
          task_prompt: input.task_prompt,
          schedule: input.schedule,
          timezone: input.timezone ?? 'UTC',
          max_steps: input.max_steps ?? 15,
          enabled: input.enabled ?? true,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return inserted!;
    },

    async getById(id: number): Promise<ScheduledTaskRow | undefined> {
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

    async update(id: number, updates: ScheduledTaskUpdateInput): Promise<ScheduledTaskRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.name !== undefined) set.name = updates.name;
      if (updates.profile_id !== undefined) set.profile_id = updates.profile_id;
      if (updates.task_prompt !== undefined) set.task_prompt = updates.task_prompt;
      if (updates.schedule !== undefined) set.schedule = updates.schedule;
      if (updates.timezone !== undefined) set.timezone = updates.timezone;
      if (updates.max_steps !== undefined) set.max_steps = updates.max_steps;
      if (updates.enabled !== undefined) set.enabled = updates.enabled;

      const [updated] = await db.update(scheduledTasks).set(set).where(eq(scheduledTasks.id, id)).returning();
      return updated;
    },

    async updateRunStatus(id: number, status: string, nextRunAt?: string | null): Promise<void> {
      const set: Record<string, unknown> = {
        last_status: status,
        updated_at: nowIso(),
      };
      if (status === 'completed' || status === 'failed') {
        set.last_run_at = nowIso();
      }
      if (status === 'completed') {
        set.run_count = scheduledTasks.run_count;
      }
      if (nextRunAt !== undefined) {
        set.next_run_at = nextRunAt;
      }

      // For run_count increment, use raw SQL
      if (status === 'completed') {
        const { sql } = await import('drizzle-orm');
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

    async delete(id: number): Promise<boolean> {
      const result = await db.delete(scheduledTasks).where(eq(scheduledTasks.id, id)).returning();
      return result.length > 0;
    },

    async countByUser(userId: string): Promise<number> {
      const { sql } = await import('drizzle-orm');
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
