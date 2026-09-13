/**
 * Tool friction service — the agent's stumbles, aggregated for human review.
 *
 * One row per fingerprint: recording the same friction again bumps the count
 * and refreshes last_seen_at instead of adding a row, so the count is the
 * priority signal a reviewer sorts by. Nothing here is injected into a prompt.
 */

import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { toolFrictions } from '../schema/index.js';
import type { ToolFrictionRow, ToolFrictionKind, ToolFrictionStatus } from '../schema/tool-friction.js';

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
     * The sample merge assumes `sample_sessions` holds a JSON array: the column
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
              when jsonb_exists(${toolFrictions.sample_sessions}::jsonb, ${sessionId}) then ${toolFrictions.sample_sessions}
              else (
                select jsonb_agg(v order by n)::text
                from (
                  select v, n
                  from (
                    select to_jsonb(${sessionId}::text) as v, 0 as n
                    union all
                    select e.value, e.ordinality::int
                    from jsonb_array_elements(${toolFrictions.sample_sessions}::jsonb)
                      with ordinality as e(value, ordinality)
                  ) merged
                  order by n
                  limit ${MAX_SAMPLE_SESSIONS}
                ) capped
              )
            end`
        : sql`${toolFrictions.sample_sessions}`;

      const rows = await db
        .insert(toolFrictions)
        .values({
          fingerprint: input.fingerprint,
          tool_id: input.tool_id ?? null,
          kind: input.kind,
          summary: input.summary,
          detail: input.detail ?? null,
          occurrence_count: increment,
          sample_sessions: JSON.stringify(sessionId ? [sessionId] : []),
          status: 'new',
          first_seen_at: now,
          last_seen_at: now,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: toolFrictions.fingerprint,
          set: {
            occurrence_count: sql`${toolFrictions.occurrence_count} + ${increment}`,
            sample_sessions: mergedSamples,
            // A resolved friction that recurs is not resolved.
            status: sql`case when ${toolFrictions.status} = 'resolved' then 'new' else ${toolFrictions.status} end`,
            detail: input.detail !== undefined && input.detail !== null ? input.detail : sql`${toolFrictions.detail}`,
            last_seen_at: now,
            updated_at: now,
          },
        })
        .returning();
      return rows[0]!;
    },

    /** Review queue: most-frequent first, then most recent. */
    async list(opts: ToolFrictionListOpts = {}): Promise<ToolFrictionRow[]> {
      const filters = [];
      if (opts.status) {
        const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
        filters.push(inArray(toolFrictions.status, statuses));
      }
      if (opts.tool_id) filters.push(eq(toolFrictions.tool_id, opts.tool_id));

      return await db
        .select()
        .from(toolFrictions)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(toolFrictions.occurrence_count), desc(toolFrictions.last_seen_at))
        .limit(opts.limit ?? 50)
        .offset(opts.offset ?? 0);
    },

    async count(opts: Pick<ToolFrictionListOpts, 'status' | 'tool_id'> = {}): Promise<number> {
      const filters = [];
      if (opts.status) {
        const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
        filters.push(inArray(toolFrictions.status, statuses));
      }
      if (opts.tool_id) filters.push(eq(toolFrictions.tool_id, opts.tool_id));

      const rows = await db
        .select({ count: sql<string>`count(*)` })
        .from(toolFrictions)
        .where(filters.length > 0 ? and(...filters) : undefined);
      return Number(rows[0]?.count ?? 0);
    },

    async getById(id: number): Promise<ToolFrictionRow | undefined> {
      const rows = await db.select().from(toolFrictions).where(eq(toolFrictions.id, id));
      return rows[0];
    },

    async update(id: number, updates: ToolFrictionUpdateInput): Promise<ToolFrictionRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.status !== undefined) set.status = updates.status;
      if (updates.resolution_note !== undefined) set.resolution_note = updates.resolution_note;

      const rows = await db.update(toolFrictions).set(set).where(eq(toolFrictions.id, id)).returning();
      return rows[0];
    },

    async delete(id: number): Promise<boolean> {
      const rows = await db.delete(toolFrictions).where(eq(toolFrictions.id, id)).returning();
      return rows.length > 0;
    },
  };
  return service;
}

export type ToolFrictionService = ReturnType<typeof createToolFrictionService>;
