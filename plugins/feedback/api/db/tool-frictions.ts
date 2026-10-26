import { feedback } from '../schema.js';
/**
 * Tool friction service — the agent's stumbles, aggregated for human review.
 *
 * One row per fingerprint: recording the same friction again bumps the count
 * and refreshes last_seen_at instead of adding a row, so the count is the
 * priority signal a reviewer sorts by. Nothing here is injected into a prompt.
 *
 * Frictions are `feedback` rows of kind 'friction'; this facade keeps their own
 * shape (summary / detail / resolution_note / kind …) at the boundary.
 */

import { eq, and, asc, desc, sql, inArray, gt, gte, lt, type SQL } from 'drizzle-orm';
import { nowIso } from '@greenhouse/api/extension-kit';

import type { Db } from '@greenhouse/api/extension-kit';
import { newId } from '@greenhouse/api/extension-kit';

import type { FeedbackRow, FRICTION_KINDS, FRICTION_STATUSES } from '../schema.js';

export type ToolFrictionKind = (typeof FRICTION_KINDS)[number];
export type ToolFrictionStatus = (typeof FRICTION_STATUSES)[number];

export interface ToolFrictionRow {
  id: string;
  fingerprint: string;
  tool_id: string | null;
  kind: ToolFrictionKind;
  summary: string;
  detail: string | null;
  occurrence_count: number;
  /** Newest first, at most five conversation ids. */
  sample_sessions: string[];
  status: ToolFrictionStatus;
  resolution_note: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface ToolFrictionInput {
  fingerprint: string;
  tool_id?: string | null;
  kind: ToolFrictionKind;
  summary: string;
  detail?: string | null;
  session_id?: string | null;
  /** How many occurrences this call represents (the miner batches; the tool sends 1). */
  increment?: number;
}

export interface ToolFrictionListOpts {
  status?: ToolFrictionStatus | ToolFrictionStatus[];
  tool_id?: string;
  limit?: number;
  offset?: number;
}

export interface ToolFrictionUpdateInput {
  status?: ToolFrictionStatus;
  resolution_note?: string | null;
}

/** Sample session ids kept per row — enough to trace back, not a log. */
const MAX_SAMPLE_SESSIONS = 5;

function toFriction(row: FeedbackRow): ToolFrictionRow {
  return {
    id: row.id,
    fingerprint: row.fingerprint ?? '',
    tool_id: row.tool_id,
    kind: row.friction_kind as ToolFrictionKind,
    summary: row.title,
    detail: row.body,
    occurrence_count: row.occurrence_count,
    sample_sessions: Array.isArray(row.sample_sessions) ? row.sample_sessions : [],
    status: row.status as ToolFrictionStatus,
    resolution_note: row.note,
    first_seen_at: row.first_seen_at ?? row.created_at,
    last_seen_at: row.last_seen_at ?? row.updated_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const isFriction = eq(feedback.kind, 'friction');

function filtersOf(opts: Pick<ToolFrictionListOpts, 'status' | 'tool_id'>): SQL[] {
  const filters: SQL[] = [isFriction];
  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    filters.push(inArray(feedback.status, statuses));
  }
  if (opts.tool_id) filters.push(eq(feedback.tool_id, opts.tool_id));
  return filters;
}

export function createToolFrictionService(db: Db) {
  const service = {
    /**
     * Record a friction. Same fingerprint → bump the count, refresh the sample
     * set, and reopen anything previously resolved (it is happening again).
     *
     * One statement, because the fingerprint is unique and both writers race:
     * the nightly miner sweeps in batches while `log_friction` fires from live
     * chat turns. A read-then-insert loses that race with a 23505 that both
     * callers swallow, so the occurrence would vanish — and the count is the
     * whole priority signal (see packages/db/src/AGENTS.md).
     *
     * The sample merge assumes `sample_sessions` holds a jsonb array: the column
     * is NOT NULL DEFAULT '[]' and this method is its only writer.
     */
    async record(input: ToolFrictionInput): Promise<ToolFrictionRow> {
      const now = nowIso();
      const increment = input.increment ?? 1;
      const sessionId = input.session_id ?? null;

      // Prepend the new session id unless it is already sampled, then keep the
      // newest MAX_SAMPLE_SESSIONS. Done in SQL so it reads the row it updates.
      const mergedSamples = sessionId
        ? sql`case
              when jsonb_exists(${feedback.sample_sessions}, ${sessionId}) then ${feedback.sample_sessions}
              else (
                select jsonb_agg(v order by n)
                from (
                  select v, n
                  from (
                    select to_jsonb(${sessionId}::text) as v, 0 as n
                    union all
                    select e.value, e.ordinality::int
                    from jsonb_array_elements(${feedback.sample_sessions})
                      with ordinality as e(value, ordinality)
                  ) merged
                  order by n
                  limit ${MAX_SAMPLE_SESSIONS}
                ) capped
              )
            end`
        : sql`${feedback.sample_sessions}`;

      const rows = await db
        .insert(feedback)
        .values({
          id: newId('feedback'),
          kind: 'friction',
          fingerprint: input.fingerprint,
          tool_id: input.tool_id ?? null,
          friction_kind: input.kind,
          title: input.summary,
          body: input.detail ?? null,
          occurrence_count: increment,
          sample_sessions: sessionId ? [sessionId] : [],
          status: 'new',
          first_seen_at: now,
          last_seen_at: now,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: feedback.fingerprint,
          targetWhere: sql`${feedback.fingerprint} IS NOT NULL`,
          set: {
            occurrence_count: sql`${feedback.occurrence_count} + ${increment}`,
            sample_sessions: mergedSamples,
            // A resolved friction that recurs is not resolved.
            status: sql`case when ${feedback.status} = 'resolved' then 'new' else ${feedback.status} end`,
            body: input.detail !== undefined && input.detail !== null ? input.detail : sql`${feedback.body}`,
            last_seen_at: now,
            updated_at: now,
          },
        })
        .returning();
      return toFriction(rows[0]!);
    },

    /** Review queue: most-frequent first, then most recent. */
    async list(opts: ToolFrictionListOpts = {}): Promise<ToolFrictionRow[]> {
      const rows = await db
        .select()
        .from(feedback)
        .where(and(...filtersOf(opts)))
        .orderBy(desc(feedback.occurrence_count), desc(feedback.last_seen_at), desc(feedback.id))
        .limit(opts.limit ?? 50)
        .offset(opts.offset ?? 0);
      return rows.map(toFriction);
    },

    async count(opts: Pick<ToolFrictionListOpts, 'status' | 'tool_id'> = {}): Promise<number> {
      const rows = await db
        .select({ count: sql<string>`count(*)` })
        .from(feedback)
        .where(and(...filtersOf(opts)));
      return Number(rows[0]?.count ?? 0);
    },

    /**
     * Frictions active during a window, in id order (callers rank them). A row keeps only
     * its first and last sighting (no per-occurrence history), so "active" is
     * the overlap `first_seen_at < to AND last_seen_at >= from`: a friction seen
     * in October and again on 1 November still counts for October. It can
     * over-include a friction seen before and after the window but not inside
     * it; `occurrence_count` is cumulative, never per window.
     *
     * Paged by keyset on the immutable `id` (`afterId` = the last id of the
     * previous page): frictions are recorded while a reader pages, and an order
     * on `occurrence_count` / `last_seen_at` with OFFSET would then skip or
     * repeat rows. Ids are opaque text; their text order is only a stable
     * paging order, not creation order.
     */
    async listActiveBetween(input: {
      from: string;
      to: string;
      limit?: number;
      afterId?: string;
    }): Promise<ToolFrictionRow[]> {
      const rows = await db
        .select()
        .from(feedback)
        .where(
          and(
            isFriction,
            lt(feedback.first_seen_at, input.to),
            gte(feedback.last_seen_at, input.from),
            ...(input.afterId !== undefined ? [gt(feedback.id, input.afterId)] : []),
          ),
        )
        .orderBy(asc(feedback.id))
        .limit(input.limit ?? 10);
      return rows.map(toFriction);
    },

    /** How many frictions were active in a window (see listActiveBetween) and how many first appeared in it. */
    async countBetween(input: { from: string; to: string }): Promise<{ active: number; new: number }> {
      const rows = await db
        .select({
          active: sql<string>`count(*) FILTER (WHERE ${feedback.first_seen_at} < ${input.to}::timestamptz AND ${feedback.last_seen_at} >= ${input.from}::timestamptz)`,
          fresh: sql<string>`count(*) FILTER (WHERE ${feedback.first_seen_at} >= ${input.from}::timestamptz AND ${feedback.first_seen_at} < ${input.to}::timestamptz)`,
        })
        .from(feedback)
        .where(isFriction);
      return { active: Number(rows[0]?.active ?? 0), new: Number(rows[0]?.fresh ?? 0) };
    },

    async getById(id: string): Promise<ToolFrictionRow | undefined> {
      const rows = await db
        .select()
        .from(feedback)
        .where(and(isFriction, eq(feedback.id, id)));
      return rows[0] ? toFriction(rows[0]) : undefined;
    },

    async update(id: string, updates: ToolFrictionUpdateInput): Promise<ToolFrictionRow | undefined> {
      const set: Partial<typeof feedback.$inferInsert> = { updated_at: nowIso() };
      if (updates.status !== undefined) set.status = updates.status;
      if (updates.resolution_note !== undefined) set.note = updates.resolution_note;

      const rows = await db
        .update(feedback)
        .set(set)
        .where(and(isFriction, eq(feedback.id, id)))
        .returning();
      return rows[0] ? toFriction(rows[0]) : undefined;
    },

    async delete(id: string): Promise<boolean> {
      const rows = await db
        .delete(feedback)
        .where(and(isFriction, eq(feedback.id, id)))
        .returning({ id: feedback.id });
      return rows.length > 0;
    },
  };
  return service;
}

export type ToolFrictionService = ReturnType<typeof createToolFrictionService>;
