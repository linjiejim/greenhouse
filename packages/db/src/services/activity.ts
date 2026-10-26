/**
 * Activity service — the two durable change records the Activity log reads,
 * paged on one shared order.
 *
 *   • audit_events — successful writes by people (and admin setting changes),
 *     as recorded by the platform kernel and the drive routes;
 *   • runs — writes made by members' agents (`agent_write`) and automation
 *     runs.
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
import type { RuntimeJson } from '../schema/index.js';

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
  summary: Record<string, unknown>;
}

export interface ActivityRunRow {
  key: string;
  at: string;
  id: string;
  kind: string;
  owner_user_id: string;
  source_kind: string;
  status: string;
  input: RuntimeJson;
  output: RuntimeJson | null;
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

/**
 * One page of a "recent changes" source: rows strictly older than `cursor` in
 * the source's (at, key) order, inside [since, now). Each source's `key` is
 * the feed item id it becomes, so the API can merge sources and resume.
 */
export interface RecentWindow {
  since: string;
  cursor?: ActivityCursor | null;
  limit: number;
}

export interface RecentKnowledgeEditRow {
  key: string;
  version_id: string;
  doc_pk: string;
  slug: string;
  title: string;
  version: number;
  changed_by: string;
  visibility: 'team' | 'private';
  owner_user_id: string | null;
  at: string;
}

export interface RecentTableChangeRow {
  key: string;
  table_id: string;
  updated_by: string;
  records: number;
  at: string;
}

export interface RecentKbFileRow {
  key: string;
  id: string;
  name: string;
  folder_id: string | null;
  visibility: 'team' | 'private';
  uploaded_by: string;
  at: string;
}

export interface AgentWriteWindowRow {
  owner_user_id: string;
  tool_id: string | null;
  client_name: string | null;
  from: string;
  to: string;
}

export function createActivityService(db: Db) {
  return {
    /**
     * Successful audit events of the given actions. `actions` pairs an app with
     * the action ids that count as changes there (reads are audited too and must
     * not show up as activity, nor does a row whose summary says
     * `"activity":false`). Optional narrowing by actor type and by the
     * person (the actor itself, or the member an agent acted for).
     */
    async listAuditChanges(
      input: ActivityWindow & {
        actions: ReadonlyArray<{ appId: string; actionIds: readonly string[]; moduleId?: string | null }>;
        excludeCapabilities?: readonly string[];
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
        FROM audit_events e
        WHERE e.result = 'success'
          AND ${input.excludeCapabilities?.length ? sql`NOT (${inList(sql`e.capability`, input.excludeCapabilities)})` : sql`TRUE`}
          AND ${created} >= ${input.from}::timestamptz
          AND ${created} < ${input.to}::timestamptz
          AND (${actionMatch})
          -- A write audited for access but marked as no change (an editor heartbeat).
          AND NOT (e.summary @> '{"activity":false}'::jsonb)
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
        FROM runs r
        WHERE ${inList(sql`r.kind`, input.kinds)}
          AND ${created} >= ${input.from}::timestamptz
          AND ${created} < ${input.to}::timestamptz
          AND ${input.ownerUserId ? sql`r.owner_user_id = ${input.ownerUserId}` : sql`TRUE`}
          AND ${input.toolIds ? inList(sql`(r.input ->> 'tool_id')`, input.toolIds) : sql`TRUE`}
          AND ${cursorClause(created, key, input.cursor)}
        ORDER BY ${created} DESC, ${key} COLLATE "C" DESC
        LIMIT ${bound(input.limit)}
      `);
      return rows as unknown as ActivityRunRow[];
    },

    // ─── Home "recent changes" sources ─────────────────────
    // Each reads one domain's own change record, newest first, inside a time
    // window and a LIMIT; the caller authorizes every row it shows.

    /**
     * Saved knowledge edits of documents that are not archived and that the user
     * may plausibly read: team documents, their own, and shared private ones
     * (the caller confirms each with resolveKbAccess). Several saves of one
     * document by one person in the window read as one change: the latest.
     */
    async recentKnowledgeEdits(input: RecentWindow & { userId: string }): Promise<RecentKnowledgeEditRow[]> {
      const rows = await db.execute(sql`
        SELECT key, version_id, doc_pk, slug, title, version, changed_by, visibility, owner_user_id, ${ISO(sql`created`)} AS at
        FROM (
          SELECT DISTINCT ON (v.doc_id, v.changed_by)
                 ('kb:' || v.id) AS key, v.id AS version_id, kb.id AS doc_pk, kb.doc_id AS slug, kb.title, v.version,
                 v.changed_by, kb.visibility, kb.owner_user_id, v.created_at AS created
          FROM kb_versions v
          JOIN kb_documents kb ON kb.id = v.doc_id
          WHERE v.created_at >= ${input.since}::timestamptz
            AND v.changed_by IS NOT NULL
            AND kb.status <> 'archived'
            AND (kb.visibility = 'team' OR kb.owner_user_id = ${input.userId}
                 OR EXISTS (SELECT 1 FROM shares s WHERE s.resource_type = 'kb_document' AND s.resource_id = kb.id))
          ORDER BY v.doc_id, v.changed_by, v.created_at DESC, v.id DESC
        ) latest
        WHERE ${cursorClause(sql`created`, sql`key`, input.cursor)}
        ORDER BY created DESC, key COLLATE "C" DESC
        LIMIT ${bound(input.limit)}
      `);
      return rows as unknown as RecentKnowledgeEditRow[];
    },

    /**
     * Record changes in the given (already authorized) tables, one row per
     * (table, person) with how many records they touched in the whole window —
     * record values are never read. Groups are formed before paging, so a
     * group is one row ordered by its latest change and never split across
     * pages.
     */
    async recentTableChanges(input: RecentWindow & { tableIds: readonly string[] }): Promise<RecentTableChangeRow[]> {
      if (input.tableIds.length === 0) return [];
      const rows = await db.execute(sql`
        SELECT key, table_id, updated_by, records, ${ISO(sql`latest`)} AS at
        FROM (
          SELECT ('tr:' || r.table_id || ':' || r.updated_by) AS key, r.table_id, r.updated_by,
                 count(*)::int AS records, max(r.updated_at) AS latest
          FROM table_records r
          WHERE ${inList(sql`r.table_id`, input.tableIds)}
            AND r.updated_at >= ${input.since}::timestamptz
            AND r.deleted_at IS NULL
          GROUP BY r.table_id, r.updated_by
        ) g
        WHERE ${cursorClause(sql`latest`, sql`key`, input.cursor)}
        ORDER BY latest DESC, key COLLATE "C" DESC
        LIMIT ${bound(input.limit)}
      `);
      return (rows as unknown as RecentTableChangeRow[]).map((row) => ({ ...row, records: Number(row.records) }));
    },

    /** New active knowledge-cabinet files one user may read (team files + their own personal ones). */
    async recentKbFiles(input: RecentWindow & { userId: string }): Promise<RecentKbFileRow[]> {
      const key = sql`('df:' || f.id)`;
      const rows = await db.execute(sql`
        SELECT ${key} AS key, f.id, f.name, f.folder_id, f.visibility, f.created_by AS uploaded_by,
               ${ISO(sql`f.created_at`)} AS at
        FROM files f
        WHERE f.source = 'drive'
          AND f.scope = 'kb'
          AND f.status = 'active'
          AND f.created_by IS NOT NULL
          AND (f.visibility = 'team' OR f.owner_user_id = ${input.userId})
          AND f.created_at >= ${input.since}::timestamptz
          AND ${cursorClause(sql`f.created_at`, key, input.cursor)}
        ORDER BY f.created_at DESC, ${key} COLLATE "C" DESC
        LIMIT ${bound(input.limit)}
      `);
      return rows as unknown as RecentKbFileRow[];
    },

    /**
     * Members' agent writes in a window, counted per client and outcome — no
     * member, tool input or output (the monthly retro). `interrupted` is the
     * recorded "outcome unknown".
     */
    async agentWriteTotals(input: {
      from: string;
      to: string;
    }): Promise<Array<{ client_name: string | null; status: string; writes: number; members: number }>> {
      const rows = await db.execute(sql`
        SELECT (r.input ->> 'client_name') AS client_name, r.status,
               count(*)::int AS writes, count(DISTINCT r.owner_user_id)::int AS members
        FROM runs r
        WHERE r.kind = 'agent_write'
          AND r.created_at >= ${input.from}::timestamptz
          AND r.created_at < ${input.to}::timestamptz
        GROUP BY 1, 2
        ORDER BY 3 DESC
      `);
      return (
        rows as unknown as Array<{ client_name: string | null; status: string; writes: number; members: number }>
      ).map((row) => ({ ...row, writes: Number(row.writes), members: Number(row.members) }));
    },

    /** Distinct members whose agents wrote in a window. */
    async agentWriteMembers(input: { from: string; to: string }): Promise<number> {
      const rows = await db.execute(sql`
        SELECT count(DISTINCT r.owner_user_id)::int AS members
        FROM runs r
        WHERE r.kind = 'agent_write'
          AND r.created_at >= ${input.from}::timestamptz
          AND r.created_at < ${input.to}::timestamptz
      `);
      return Number((rows as unknown as Array<{ members: number }>)[0]?.members ?? 0);
    },

    /** Settled agent writes of these members in a window, to say which agent made a change. */
    async agentWritesOf(input: {
      ownerIds: readonly string[];
      from: string;
      to: string;
      limit: number;
    }): Promise<AgentWriteWindowRow[]> {
      if (input.ownerIds.length === 0) return [];
      const rows = await db.execute(sql`
        SELECT r.owner_user_id, (r.input ->> 'tool_id') AS tool_id,
               (r.input ->> 'client_name') AS client_name,
               ${ISO(sql`r.created_at`)} AS "from", ${ISO(sql`coalesce(r.settled_at, r.updated_at)`)} AS "to"
        FROM runs r
        WHERE r.kind = 'agent_write'
          AND r.status = 'succeeded'
          AND ${inList(sql`r.owner_user_id`, input.ownerIds)}
          AND r.created_at >= ${input.from}::timestamptz
          AND r.created_at < ${input.to}::timestamptz
        ORDER BY r.created_at DESC
        LIMIT ${bound(input.limit)}
      `);
      return rows as unknown as AgentWriteWindowRow[];
    },
  };
}

export type ActivityService = ReturnType<typeof createActivityService>;

export const activitySql = { ISO, bound, cursorClause, inList };
