/**
 * Schedules belong to an Agent and act with its owner's rights. Each firing starts a background
 * run with the schedule's brief; the run reports into the Agent's own thread. Firing claims a
 * due schedule with FOR UPDATE SKIP LOCKED, moves its next time and queues the run in one
 * transaction, so two processes never fire it twice and a crash never loses a firing: whichever
 * process is up takes the queued run. Firings missed while no process ran collapse into one.
 */

import { Cron } from 'croner';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { Schedule, UpdateScheduleInput, createScheduleInputSchema } from '@greenhouse/contract';
import { getDb, members, newId, schedules, transaction, type Run, type ScheduleRow } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import type { z } from 'zod';
import type { Background } from '../../engine/background.js';
import { conflict, invalidInput, notFound } from '../../http/errors.js';
import type { AgentsService } from '../agents/service.js';

type CreateInput = z.input<typeof createScheduleInputSchema>;

/** At most this many schedules per member, and never more often than every 15 minutes. */
export const MAX_SCHEDULES = 50;
export const MIN_INTERVAL_MS = 15 * 60_000;
const TICK_MS = 30_000;

const toSchedule = (row: ScheduleRow): Schedule => ({
  id: row.id,
  agent_id: row.agentId,
  name: row.name,
  brief: row.brief,
  quiet: row.quiet,
  computer: row.computer,
  domains: row.domains,
  continue_after: row.continueAfter,
  cron: row.cron,
  timezone: row.timezone,
  status: row.status,
  next_run_at: row.nextRunAt,
  last_run_at: row.lastRunAt,
  last_run_id: row.lastRunId,
  last_status: row.lastStatus,
  run_count: row.runCount,
  created_at: row.createdAt,
});

/** The next firing after `from`; throws invalid_input for a pattern or zone that does not work. */
export function nextFiring(cron: string, timezone: string, from = new Date()): Date {
  if (cron.trim().split(/\s+/).length !== 5) {
    throw invalidInput('Use five fields: minute hour day month weekday.');
  }
  let pattern: Cron;
  try {
    pattern = new Cron(cron, { timezone, paused: true });
    const [first, second] = pattern.nextRuns(2, from);
    if (!first) throw new Error('It never fires.');
    if (second && second.getTime() - first.getTime() < MIN_INTERVAL_MS) {
      throw invalidInput('A schedule can fire at most every 15 minutes.');
    }
    return first;
  } catch (error) {
    if ((error as { code?: string }).code === 'invalid_input') throw error;
    throw invalidInput(`This schedule does not work: ${toErrorMessage(error)}`);
  }
}

export function createSchedulesService(deps: { agents: AgentsService; background: () => Background }) {
  let ticker: NodeJS.Timeout | null = null;

  async function own(memberId: string, id: string): Promise<ScheduleRow> {
    const [row] = await getDb()
      .select()
      .from(schedules)
      .where(and(eq(schedules.id, id), eq(schedules.ownerId, memberId)));
    if (!row) throw notFound('Schedule');
    return row;
  }

  /** Queues the run of one firing and records it on the schedule. Joins the open transaction. */
  async function fire(row: ScheduleRow): Promise<Run> {
    const run = await deps.background().create({
      agentId: row.agentId,
      ownerId: row.ownerId,
      requestedBy: row.ownerId,
      title: row.name,
      brief: row.brief,
      source: 'schedule',
      sourceId: row.id,
      conversationId: null,
      quiet: row.quiet,
      computer: row.computer,
      domains: row.domains,
      continue_after: row.continueAfter,
    });
    await getDb()
      .update(schedules)
      .set({
        lastRunAt: sql`now()`,
        lastRunId: run.id,
        lastStatus: 'queued',
        runCount: sql`${schedules.runCount} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(schedules.id, row.id));
    return run;
  }

  const service = {
    async list(memberId: string, agent?: string): Promise<Schedule[]> {
      const agentId = agent ? (await deps.agents.load(memberId, agent)).agent.id : undefined;
      const rows = await getDb()
        .select()
        .from(schedules)
        .where(and(eq(schedules.ownerId, memberId), agentId ? eq(schedules.agentId, agentId) : undefined))
        .orderBy(asc(schedules.createdAt));
      return rows.map(toSchedule);
    },

    async get(memberId: string, id: string): Promise<Schedule> {
      return toSchedule(await own(memberId, id));
    },

    async create(memberId: string, input: CreateInput): Promise<Schedule> {
      const { agent } = await deps.agents.load(memberId, input.agent_id);
      if (agent.archivedAt) throw conflict('agent_archived', 'This Agent is archived.');
      const [member] = await getDb()
        .select({ timezone: members.timezone })
        .from(members)
        .where(eq(members.id, memberId));
      const timezone = input.timezone ?? member?.timezone ?? 'Asia/Shanghai';
      const next = nextFiring(input.cron, timezone);
      return transaction(async (db) => {
        const [{ n }] = (await db
          .select({ n: sql<number>`count(*)::int` })
          .from(schedules)
          .where(eq(schedules.ownerId, memberId))) as [{ n: number }];
        if (n >= MAX_SCHEDULES) throw conflict('schedule_limit', `You can have up to ${MAX_SCHEDULES} schedules.`);
        const [row] = await db
          .insert(schedules)
          .values({
            id: newId('schedule'),
            agentId: agent.id,
            ownerId: memberId,
            name: input.name,
            brief: input.brief,
            quiet: input.quiet ?? false,
            computer: input.computer ?? false,
            domains: input.domains ?? [],
            continueAfter: input.continue_after ?? false,
            cron: input.cron.trim(),
            timezone,
            nextRunAt: next.toISOString(),
          })
          .returning();
        return toSchedule(row!);
      });
    },

    async update(memberId: string, id: string, input: UpdateScheduleInput): Promise<Schedule> {
      const row = await own(memberId, id);
      const cron = input.cron?.trim() ?? row.cron;
      const timezone = input.timezone ?? row.timezone;
      const next = nextFiring(cron, timezone);
      const [updated] = await getDb()
        .update(schedules)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.brief !== undefined ? { brief: input.brief } : {}),
          ...(input.quiet !== undefined ? { quiet: input.quiet } : {}),
          ...(input.computer !== undefined ? { computer: input.computer } : {}),
          ...(input.domains !== undefined ? { domains: input.domains } : {}),
          ...(input.continue_after !== undefined ? { continueAfter: input.continue_after } : {}),
          cron,
          timezone,
          nextRunAt: row.status === 'active' ? next.toISOString() : row.nextRunAt,
          updatedAt: sql`now()`,
        })
        .where(eq(schedules.id, id))
        .returning();
      return toSchedule(updated!);
    },

    async remove(memberId: string, id: string): Promise<void> {
      await own(memberId, id);
      await getDb().delete(schedules).where(eq(schedules.id, id));
    },

    async pause(memberId: string, id: string): Promise<Schedule> {
      await own(memberId, id);
      const [row] = await getDb()
        .update(schedules)
        .set({ status: 'paused', nextRunAt: null, updatedAt: sql`now()` })
        .where(eq(schedules.id, id))
        .returning();
      return toSchedule(row!);
    },

    async resume(memberId: string, id: string): Promise<Schedule> {
      const current = await own(memberId, id);
      const [row] = await getDb()
        .update(schedules)
        .set({
          status: 'active',
          nextRunAt: nextFiring(current.cron, current.timezone).toISOString(),
          updatedAt: sql`now()`,
        })
        .where(eq(schedules.id, id))
        .returning();
      return toSchedule(row!);
    },

    /** Fires once now, without moving the regular time. */
    async runNow(memberId: string, id: string): Promise<Schedule> {
      const row = await own(memberId, id);
      deps.background().kick(await transaction(() => fire(row)));
      return toSchedule(await own(memberId, id));
    },

    /**
     * Fires every schedule that is due. Safe with several processes: each firing is claimed, moved
     * to its next time after now (so firings missed while nothing ran collapse into one) and its
     * run queued in one transaction, and the run is taken once that commits.
     */
    async tick(now = new Date()): Promise<number> {
      let fired = 0;
      for (;;) {
        const claimed = await transaction(async (db) => {
          const [due] = await db
            .select()
            .from(schedules)
            .where(and(eq(schedules.status, 'active'), lte(schedules.nextRunAt, now.toISOString())))
            .orderBy(asc(schedules.nextRunAt))
            .limit(1)
            .for('update', { skipLocked: true });
          if (!due) return null;
          let next: string | null;
          try {
            next = nextFiring(due.cron, due.timezone, now).toISOString();
          } catch {
            next = null;
          }
          if (!next) {
            await db
              .update(schedules)
              .set({ status: 'paused', nextRunAt: null, lastStatus: 'invalid' })
              .where(eq(schedules.id, due.id));
            return { run: null };
          }
          await db.update(schedules).set({ nextRunAt: next }).where(eq(schedules.id, due.id));
          return { run: await fire(due) };
        });
        if (!claimed) return fired;
        if (!claimed.run) continue;
        deps.background().kick(claimed.run);
        fired += 1;
      }
    },

    start() {
      ticker ??= setInterval(() => {
        void service
          .tick()
          .catch((error: unknown) => logger.warn('[schedules] tick failed', { error: toErrorMessage(error) }));
      }, TICK_MS);
    },

    stop() {
      if (ticker) clearInterval(ticker);
      ticker = null;
    },
  };
  return service;
}

export type SchedulesService = ReturnType<typeof createSchedulesService>;
