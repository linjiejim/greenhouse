/**
 * Record comments and the merged activity feed (comments + history events).
 *
 * Every method that touches a record takes the caller's row scope and refuses
 * (undefined = "not found") a record outside it, so a handler cannot forget
 * the check. Who may edit or delete which comment (author, Base builder+) is
 * the API's decision; this module only stores, validates and reads.
 *
 * Activity is newest first with an opaque cursor over `(created_at, source, id)`
 * — `source` breaks timestamp ties between the two tables. History events show
 * only the field changes the reader may see today: an update whose changes all
 * fall away is dropped; created / deleted / restored stay (who and when are
 * system facts every reader of the record already sees).
 */

import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { TableAccessScope } from '@greenhouse/types/table-access';
import {
  TABLE_ACTIVITY_MAX_PAGE_SIZE,
  TABLE_ACTIVITY_PAGE_SIZE,
  TABLE_COMMENT_MAX_LENGTH,
  type TableRecordActivityItem,
  type TableRecordActivityPage,
  type TableRecordCommentView,
  type TableRecordEventView,
} from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import { tableFields, tableRecordComments, tableRecordEvents } from '../../schema/index.js';
import type { TableRecordCommentRow, TableRecordEventRow, TableRecordRow } from '../../schema/tables.js';
import { assertScopeForTable } from './query.js';
import { assertScope, TablesValidationError } from './shared.js';

export type TableActivitySource = 'comment' | 'event';

/** Where a page stopped: the last item it scanned (kept or dropped). */
export interface TableActivityPosition {
  /** Fixed-width UTC timestamp with microseconds — sorts as text, parses back as timestamptz. */
  at: string;
  source: TableActivitySource;
  id: number;
}

export interface CreateTableCommentInput {
  tableId: number;
  recordId: number;
  authorId: string;
  body: string;
  /** Mentioned user ids, already resolved by the caller (active internal users). */
  mentions: string[];
}

export interface UpdateTableCommentInput {
  body: string;
  mentions: string[];
}

export interface ListTableActivityOptions {
  cursor?: string | null;
  limit?: number;
  /** False drops comments from the feed (the reader may see the record but not its comments). */
  includeComments?: boolean;
}

const MAX_MENTIONS = 50;
/** Activity pages refill past dropped events, but never scan without end. */
const MAX_SCANS = 10;
const POSITION_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

// ─── Pure helpers ─────────────────────────────────────────

/** A comment body as stored: NUL stripped, trimmed, 1…TABLE_COMMENT_MAX_LENGTH characters. */
export function normalizeCommentBody(body: unknown): string {
  if (typeof body !== 'string') throw new TablesValidationError('Comment body is required');
  const clean = body.replaceAll('\u0000', '').trim();
  if (!clean) throw new TablesValidationError('Comment body is required');
  if (clean.length > TABLE_COMMENT_MAX_LENGTH) {
    throw new TablesValidationError(`Comment body is limited to ${TABLE_COMMENT_MAX_LENGTH} characters`);
  }
  return clean;
}

function normalizeMentions(mentions: readonly string[]): string[] {
  return [...new Set(mentions.filter((id) => typeof id === 'string' && id.length > 0))].slice(0, MAX_MENTIONS);
}

export function encodeActivityCursor(position: TableActivityPosition): string {
  return Buffer.from(JSON.stringify([position.at, position.source, position.id]), 'utf8').toString('base64url');
}

/** The cursor a client sent back, or a validation error — never a half-parsed position. */
export function decodeActivityCursor(cursor: string): TableActivityPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new TablesValidationError('Activity cursor is invalid');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== 'string' ||
    !POSITION_AT.test(parsed[0]) ||
    (parsed[1] !== 'comment' && parsed[1] !== 'event') ||
    !Number.isInteger(parsed[2]) ||
    parsed[2] <= 0
  ) {
    throw new TablesValidationError('Activity cursor is invalid');
  }
  return { at: parsed[0], source: parsed[1], id: parsed[2] };
}

/** Newest first: `(at, source, id)` descending — the same order the per-source queries use. */
export function compareActivityPositions(left: TableActivityPosition, right: TableActivityPosition): number {
  if (left.at !== right.at) return left.at < right.at ? 1 : -1;
  if (left.source !== right.source) return left.source < right.source ? 1 : -1;
  return right.id - left.id;
}

export function tableCommentView(row: TableRecordCommentRow): TableRecordCommentView {
  return {
    kind: 'comment',
    id: row.id,
    recordId: row.record_id,
    authorId: row.author_id,
    body: row.body,
    mentions: row.mentions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: row.updated_at !== row.created_at,
  };
}

/**
 * A history event as one reader may see it, or null when nothing of it is left
 * for them (an update that only touched fields they cannot read).
 */
export function tableEventView(row: TableRecordEventRow, readable: ReadonlySet<number>): TableRecordEventView | null {
  const changes = row.changes.filter((change) => readable.has(change.fieldId));
  if (row.type === 'updated' && changes.length === 0) return null;
  return {
    kind: 'event',
    id: row.id,
    recordId: row.record_id,
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    type: row.type,
    changes,
    meta: row.meta,
    createdAt: row.created_at,
  };
}

// ─── Service ──────────────────────────────────────────────

export interface TablesCommentsDeps {
  /** The scoped record read (`records.ts`): the one row-visibility check. */
  getRecord: (tableId: number, recordId: number, scope: TableAccessScope) => Promise<TableRecordRow | undefined>;
}

const positionAt = (column: typeof tableRecordComments.created_at | typeof tableRecordEvents.created_at) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * "After the cursor" for one source, in `(at, source, id)` descending order:
 * a source that sorts after the cursor's source may share its timestamp, the
 * same source continues below its id, an earlier one needs an older timestamp.
 */
function afterCursor(
  table: typeof tableRecordComments | typeof tableRecordEvents,
  source: TableActivitySource,
  cursor: TableActivityPosition | null,
): SQL | undefined {
  if (!cursor) return undefined;
  const at = sql`${cursor.at}::timestamptz`;
  if (source < cursor.source) return sql`${table.created_at} <= ${at}`;
  if (source > cursor.source) return lt(table.created_at, at);
  return or(lt(table.created_at, at), and(eq(table.created_at, at), lt(table.id, cursor.id)));
}

type Scanned =
  | { position: TableActivityPosition; source: 'comment'; row: TableRecordCommentRow }
  | { position: TableActivityPosition; source: 'event'; row: TableRecordEventRow };

export function createTablesComments(db: Db, deps: TablesCommentsDeps) {
  const visibleRecord = async (tableId: number, recordId: number, scope: TableAccessScope) => {
    assertScope(scope);
    assertScopeForTable(scope, tableId);
    return deps.getRecord(tableId, recordId, scope);
  };

  /** Active fields of the table the reader may see: the scope's readable set, or every active field for full access. */
  const readableFields = async (tableId: number, scopes: readonly TableAccessScope[]): Promise<Set<number>> => {
    const active = await db
      .select({ id: tableFields.id })
      .from(tableFields)
      .where(and(eq(tableFields.table_id, tableId), isNull(tableFields.archived_at)));
    let readable = new Set(active.map((field) => field.id));
    for (const scope of scopes) {
      if (scope.kind === 'scoped') {
        const allowed = new Set(scope.readableFieldIds);
        readable = new Set([...readable].filter((id) => allowed.has(id)));
      }
    }
    return readable;
  };

  const scanComments = async (recordId: number, cursor: TableActivityPosition | null, limit: number) => {
    const rows = await db
      .select({ row: tableRecordComments, at: positionAt(tableRecordComments.created_at) })
      .from(tableRecordComments)
      .where(
        and(
          eq(tableRecordComments.record_id, recordId),
          isNull(tableRecordComments.deleted_at),
          afterCursor(tableRecordComments, 'comment', cursor),
        ),
      )
      .orderBy(desc(tableRecordComments.created_at), desc(tableRecordComments.id))
      .limit(limit);
    return rows.map(
      ({ row, at }): Scanned => ({ position: { at, source: 'comment', id: row.id }, source: 'comment', row }),
    );
  };

  const scanEvents = async (recordId: number, cursor: TableActivityPosition | null, limit: number) => {
    const rows = await db
      .select({ row: tableRecordEvents, at: positionAt(tableRecordEvents.created_at) })
      .from(tableRecordEvents)
      .where(and(eq(tableRecordEvents.record_id, recordId), afterCursor(tableRecordEvents, 'event', cursor)))
      .orderBy(desc(tableRecordEvents.created_at), desc(tableRecordEvents.id))
      .limit(limit);
    return rows.map(
      ({ row, at }): Scanned => ({ position: { at, source: 'event', id: row.id }, source: 'event', row }),
    );
  };

  const liveComment = async (commentId: number): Promise<TableRecordCommentRow | undefined> => {
    const [row] = await db
      .select()
      .from(tableRecordComments)
      .where(and(eq(tableRecordComments.id, commentId), isNull(tableRecordComments.deleted_at)))
      .limit(1);
    return row;
  };

  return {
    /**
     * A live comment by id, unscoped — the lookup a handler needs to find the
     * comment's record before it can check access. Never return it to a client
     * without that check.
     */
    async getComment(commentId: number): Promise<TableRecordCommentRow | undefined> {
      return liveComment(commentId);
    },

    /** Post a comment on a record the scope can read. Undefined = record not visible. */
    async createComment(
      input: CreateTableCommentInput,
      scope: TableAccessScope,
    ): Promise<TableRecordCommentRow | undefined> {
      const body = normalizeCommentBody(input.body);
      if (!(await visibleRecord(input.tableId, input.recordId, scope))) return undefined;
      const now = nowIso();
      const [row] = await db
        .insert(tableRecordComments)
        .values({
          record_id: input.recordId,
          table_id: input.tableId,
          author_id: input.authorId,
          body,
          mentions: normalizeMentions(input.mentions),
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row;
    },

    /** Replace a live comment's body and mentions. Undefined = gone, or its record left the scope. */
    async updateComment(
      commentId: number,
      input: UpdateTableCommentInput,
      scope: TableAccessScope,
    ): Promise<TableRecordCommentRow | undefined> {
      const body = normalizeCommentBody(input.body);
      const comment = await liveComment(commentId);
      if (!comment || !(await visibleRecord(comment.table_id, comment.record_id, scope))) return undefined;
      const [row] = await db
        .update(tableRecordComments)
        .set({ body, mentions: normalizeMentions(input.mentions), updated_at: nowIso() })
        .where(and(eq(tableRecordComments.id, commentId), isNull(tableRecordComments.deleted_at)))
        .returning();
      return row;
    },

    /** Soft-delete a live comment. Undefined = gone, or its record left the scope. */
    async deleteComment(commentId: number, scope: TableAccessScope): Promise<TableRecordCommentRow | undefined> {
      const comment = await liveComment(commentId);
      if (!comment || !(await visibleRecord(comment.table_id, comment.record_id, scope))) return undefined;
      const [row] = await db
        .update(tableRecordComments)
        .set({ deleted_at: nowIso() })
        .where(and(eq(tableRecordComments.id, commentId), isNull(tableRecordComments.deleted_at)))
        .returning();
      return row;
    },

    /**
     * One page of a record's activity, newest first. `scope` decides whether
     * the record is visible at all; field changes are cut to what both `scope`
     * and `readScope` may read (the API passes the kernel-capped read scope —
     * a masked `record.values` reader sees no values). Undefined = record not
     * visible.
     */
    async listRecordActivity(
      tableId: number,
      recordId: number,
      scope: TableAccessScope,
      readScope: TableAccessScope,
      options: ListTableActivityOptions = {},
    ): Promise<TableRecordActivityPage | undefined> {
      assertScope(readScope);
      assertScopeForTable(readScope, tableId);
      if (!(await visibleRecord(tableId, recordId, scope))) return undefined;
      const limit = Math.min(
        Math.max(Math.trunc(options.limit ?? TABLE_ACTIVITY_PAGE_SIZE), 1),
        TABLE_ACTIVITY_MAX_PAGE_SIZE,
      );
      const includeComments = options.includeComments !== false;
      const readable = await readableFields(tableId, [scope, readScope]);

      let cursor = options.cursor ? decodeActivityCursor(options.cursor) : null;
      const items: TableRecordActivityItem[] = [];
      let more = false;
      for (let scan = 0; scan < MAX_SCANS && items.length < limit; scan += 1) {
        const want = limit - items.length;
        const [comments, events] = await Promise.all([
          includeComments ? scanComments(recordId, cursor, want + 1) : Promise.resolve([]),
          scanEvents(recordId, cursor, want + 1),
        ]);
        const merged = [...comments, ...events].sort((left, right) =>
          compareActivityPositions(left.position, right.position),
        );
        more = merged.length > want;
        for (const entry of merged.slice(0, want)) {
          cursor = entry.position;
          if (entry.source === 'comment') {
            items.push(tableCommentView(entry.row));
          } else {
            const view = tableEventView(entry.row, readable);
            if (view) items.push(view);
          }
        }
        if (!more) break;
      }
      return { items, nextCursor: more && cursor ? encodeActivityCursor(cursor) : null };
    },
  };
}
