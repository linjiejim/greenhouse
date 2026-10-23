/**
 * Activity service — the two durable change records the Activity log reads,
 * paged on one shared order.
 *
 *   • platform_audit_events — successful writes by people (and admin setting
 *     changes), as recorded by the platform kernel and the drive routes;
 *   • runtime_runs — writes made by members' agents (`agent_write`) and
 *     automation runs.
 *
 * Both readers page newest-first on (created_at, sort key) where the sort key
 * is `<prefix>:<id>` compared byte-wise (`COLLATE "C"`), so the API can merge
 * several sources into one stream and hand back a single cursor. Every query
 * is bounded: a mandatory time window (the caller supplies it) and a LIMIT.
 * Timestamps leave as fixed-width UTC ISO text with microseconds, so a cursor
 * round-trips exactly and the merge can compare strings.
 *
 * Pure data: who may see which rows is decided by the caller.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client.js';

export interface ActivityCursor {
  /** Fixed-width UTC ISO timestamp with microseconds (as returned in `at`). */
  at: string;
  /** `<prefix>:<id>` of the last row already shown. */
  key: string;
}

export interface ActivityWindow {
  /** Inclusive lower bound (ISO). Required: it is what bounds the index scan. */
  from: string;
  /** Exclusive upper bound (ISO). */
  to: string;
  cursor?: ActivityCursor | null;
  limit: number;
}

export interface ActivityAuditRow {
  key: string;
  at: string;
  id: string;
  actor_id: string;
  actor_type: string;
  on_behalf_of_user_id: string | null;
  client_id: string | null;
  app_id: string;
  module_id: string | null;
  entity_id: string | null;
  record_id: string | null;
  action_id: string;
  summary: string;
}

export interface ActivityRunRow {
  key: string;
  at: string;
  id: string;
  kind: string;
  owner_user_id: string;
  source_kind: string;
  status: string;
  input: string;
  output: string | null;
  error_code: string | null;
  error_message: string | null;
  settled_at: string | null;
  created_at: string;
}

const ISO = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function bound(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit) || 1, 1), 201);
}

function cursorClause(createdAt: SQL, key: SQL, cursor: ActivityCursor | null | undefined): SQL {
  if (!cursor) return sql`TRUE`;
  return sql`(${createdAt} < ${cursor.at}::timestamptz OR (${createdAt} = ${cursor.at}::timestamptz AND ${key} COLLATE "C" < ${cursor.key} COLLATE "C"))`;
}

function inList(column: SQL, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

export function createActivityService(db: Db) {
  return {
    /**
     * Successful audit events of the given actions. `actions` pairs an app with
     * the action ids that count as changes there (reads are audited too and must
     * not show up as activity). Optional narrowing by actor type and by the
     * person (the actor itself, or the member an agent acted for).
     */
    async listAuditChanges(
      input: ActivityWindow & {
        orgId: string;
        actions: ReadonlyArray<{ appId: string; actionIds: readonly string[]; moduleId?: string | null }>;
        actorType?: 'human' | 'agent';
        userId?: string | null;
      },
    ): Promise<ActivityAuditRow[]> {
      const actions = input.actions.filter((entry) => entry.actionIds.length > 0);
      if (actions.length === 0) return [];
      const key = sql`('a:' || e.id)`;
      const created = sql`e.created_at`;
      const actionMatch = sql.join(
        actions.map((entry) => {
          const parts = [sql`e.app_id = ${entry.appId}`, inList(sql`e.action_id`, entry.actionIds)];
          if (entry.moduleId) parts.push(sql`e.module_id = ${entry.moduleId}`);
          return sql`(${sql.join(parts, sql` AND `)})`;
        }),
        sql` OR `,
      );
      // A human row's person is its actor, which (actor_id, created_at) indexes;
      // only agent rows need the unindexed on-behalf-of column.
      const person = !input.userId
        ? sql`TRUE`
        : input.actorType === 'human'
          ? sql`e.actor_id = ${input.userId}`
          : sql`(e.actor_id = ${input.userId} OR e.on_behalf_of_user_id = ${input.userId})`;
      const rows = await db.execute(sql`
        SELECT ${key} AS key, ${ISO(created)} AS at, e.id, e.actor_id, e.actor_type, e.on_behalf_of_user_id,
               e.client_id, e.app_id, e.module_id, e.entity_id, e.record_id, e.action_id, e.summary
        FROM platform_audit_events e
        WHERE e.org_id = ${input.orgId}
          AND e.result = 'success'
          AND ${created} >= ${input.from}::timestamptz
          AND ${created} < ${input.to}::timestamptz
          AND (${actionMatch})
          AND ${input.actorType ? sql`e.actor_type = ${input.actorType}` : sql`TRUE`}
          AND ${person}
          AND ${cursorClause(created, key, input.cursor)}
        ORDER BY ${created} DESC, ${key} COLLATE "C" DESC
        LIMIT ${bound(input.limit)}
      `);
      return rows as unknown as ActivityAuditRow[];
    },

    /**
     * Runtime runs of the given kinds, optionally narrowed to one owner and, for
     * agent writes, to the tools that were called.
     */
    async listRuns(
      input: ActivityWindow & {
        kinds: readonly string[];
        ownerUserId?: string | null;
        /** Only agent writes whose `input.tool_id` is one of these. */
        toolIds?: readonly string[] | null;
      },
    ): Promise<ActivityRunRow[]> {
      if (input.kinds.length === 0) return [];
      if (input.toolIds && input.toolIds.length === 0) return [];
      const key = sql`('r:' || r.id)`;
      const created = sql`r.created_at`;
      const rows = await db.execute(sql`
        SELECT ${key} AS key, ${ISO(created)} AS at, r.id, r.kind, r.owner_user_id, r.source_kind, r.status,
               r.input, r.output, r.error_code, r.error_message,
               ${ISO(sql`r.settled_at`)} AS settled_at, ${ISO(created)} AS created_at
        FROM runtime_runs r
        WHERE ${inList(sql`r.kind`, input.kinds)}
          AND ${created} >= ${input.from}::timestamptz
          AND ${created} < ${input.to}::timestamptz
          AND ${input.ownerUserId ? sql`r.owner_user_id = ${input.ownerUserId}` : sql`TRUE`}
          AND ${input.toolIds ? inList(sql`(r.input::jsonb ->> 'tool_id')`, input.toolIds) : sql`TRUE`}
          AND ${cursorClause(created, key, input.cursor)}
        ORDER BY ${created} DESC, ${key} COLLATE "C" DESC
        LIMIT ${bound(input.limit)}
      `);
      return rows as unknown as ActivityRunRow[];
    },
  };
}

export type ActivityService = ReturnType<typeof createActivityService>;
