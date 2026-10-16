import type { AutomationHooks } from './automations.js';
/**
 * Records (TBL-07 to TBL-10): query a view, read one, create, change with a revision check,
 * paste many, delete to the recycle bin, restore, delete for good; comments and history. Every
 * write runs in one transaction with its links, files, computed values and history event, and
 * tells the people of the base once it has committed. A custom role reads and writes only the
 * fields and records it sees (scope.ts), on every path here.
 */

import { and, asc, desc, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  isComputedType,
  isEmptyValue,
  isLinkType,
  roleAtLeast,
  type BulkRecordsInput,
  type BulkResult,
  type KnowledgeComment,
  type RecordActivity,
  type RecordActivityItem,
  type RecordDetail,
  type RecordPage,
  type RecordValues,
  type RecordsQuery,
  type TableRecord,
} from '@greenhouse/contract';
import {
  baseRecordEvents,
  baseRecordFiles,
  baseRecordLinks,
  baseRecords,
  baseTables,
  bases,
  comments,
  files,
  getDb,
  members,
  newId,
  searchQuery,
  transaction,
  type BaseFieldRow,
  type BaseRecordChange,
  type BaseRecordRow,
  type BaseRow,
  type CommentRow,
  type RecordEventType,
} from '@greenhouse/db';
import { isUniqueViolation, toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { ApiError, conflict, forbidden, invalidInput, notFound } from '../../http/errors.js';
import { containing } from '../../http/like.js';
import type { FilesService } from '../files/service.js';
import { markdownText, mentionIds } from '../knowledge/markdown.js';
import { agentNames, memberNames, refOf } from '../knowledge/views.js';
import type { NotificationsService } from '../notifications/service.js';
import { customBasesOf, loadReader, needsRole, readableBases, type TablesReader } from './access.js';
import type { ComputedPart } from './computed.js';
import { fieldsOf, fill, recordAt, tableAt, titlesOf, toRecord, viewerOf, type TableAt } from './load.js';
import { purgeRecords, type TouchedRecord } from './purge.js';
import {
  compileFilter,
  compileOrder,
  compileSearch,
  decodeOffset,
  encodeOffset,
  fingerprint,
  idList,
  inIds,
  recordsWhere,
  type QueryContext,
} from './query.js';
import { hiddenFields, rowsOf, scopeOf, type TableScope } from './scope.js';
import { changesBetween, emptyRefs, keptApart, normalizeValue, searchOf, titleOf, type ValueRefs } from './values.js';
import { han } from '@greenhouse/utils/i18n';

/** Who a record's history names for a write: a form, import or app (the member is kept apart). */
export interface RecordActor {
  type: 'form' | 'import' | 'app';
  id: string;
}

/** A record as realtime events name it. */
export interface ChangedRecord {
  id: string;
  revision: number;
  computed_revision?: number;
}

/** Most people told about one comment. */
const MAX_TOLD = 50;
/** Bases searched through a custom role at a time (⌘K). */
const MAX_CUSTOM_SEARCH_BASES = 20;

export interface RecordsDeps {
  automations(): AutomationHooks | null;
  files: FilesService;
  notifications: NotificationsService;
  computed: ComputedPart;
  /** Background work was queued: run a pass soon. */
  kick(): void;
  /** Tell the base's people which records changed (after the commit). */
  changed(base: Pick<BaseRow, 'id' | 'ownerId'>, tableId: string, records: ChangedRecord[]): void;
  /** Tell the base's people a record's comments changed. */
  commented(base: Pick<BaseRow, 'id' | 'ownerId'>, recordId: string, commentId: string): void;
  /** The base was written to: its updated time moves. */
  touch(baseId: string): Promise<void>;
}

/** Everything a write to one table checks values against. */
interface Writing extends TableAt {
  reader: TablesReader;
  /** Every live field: a write keeps what the writer does not see. */
  fields: BaseFieldRow[];
  byId: Map<string, BaseFieldRow>;
  /** What the writer sees: fields, records, whether they may edit. */
  scope: TableScope;
}

const stale = (record: TableRecord) =>
  new ApiError(409, 'stale_revision', 'Someone changed this record. Reload it before saving again.', { record });

const asChanged = (row: Pick<BaseRecordRow, 'id' | 'revision' | 'computedRevision'>): ChangedRecord => ({
  id: row.id,
  revision: row.revision,
  computed_revision: row.computedRevision,
});

export function createRecords(deps: RecordsDeps) {
  async function writing(reader: TablesReader, at: TableAt): Promise<Writing> {
    const [fields, scope] = await Promise.all([fieldsOf(at.table.id), scopeOf(reader, at)]);
    return { ...at, reader, fields, byId: new Map(fields.map((field) => [field.id, field])), scope };
  }

  /** Link and attachment values filled in, as the record is now (live targets only). */
  async function valuesNow(ctx: Writing, row: BaseRecordRow) {
    return (
      await fill([row], ctx.fields, { files: deps.files, memberId: ctx.reader.memberId, baseId: ctx.base.id })
    ).values.get(row.id)!;
  }

  /** Whether the writer's role sees this record (always, for the four roles). */
  async function seen(ctx: Pick<Writing, 'scope'>, recordId: string): Promise<boolean> {
    if (!ctx.scope.rows) return true;
    const [found] = await getDb()
      .select({ id: baseRecords.id })
      .from(baseRecords)
      .where(and(eq(baseRecords.id, recordId), ctx.scope.rows));
    return !!found;
  }

  /** Checks what new values point at: active members, live records of the right table, files of this base. */
  async function checkRefs(
    ctx: Writing,
    refs: ValueRefs,
    recordId: string | null,
    before: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) {
    const added = (field: BaseFieldRow) => {
      if (!(field.id in patch)) return [];
      const old = new Set((before[field.id] as string[] | undefined) ?? []);
      return ((patch[field.id] as string[] | null) ?? []).filter((id) => !old.has(id));
    };
    const newMembers = [...new Set(ctx.fields.filter((field) => field.type === 'member').flatMap(added))];
    if (newMembers.length) {
      const found = await getDb()
        .select({ id: members.id })
        .from(members)
        .where(and(inIds(members.id, newMembers), eq(members.status, 'active')));
      if (found.length !== newMembers.length) throw invalidInput('Some members cannot be chosen.');
    }
    for (const [tableId, ids] of refs.records) {
      if (recordId && ids.has(recordId)) throw invalidInput('A record cannot link to itself.');
      const found = await getDb()
        .select({ id: baseRecords.id })
        .from(baseRecords)
        .innerJoin(baseTables, and(eq(baseTables.id, baseRecords.tableId), isNull(baseTables.archivedAt)))
        .where(and(inIds(baseRecords.id, [...ids]), eq(baseRecords.tableId, tableId), isNull(baseRecords.deletedAt)));
      if (found.length !== ids.size) throw invalidInput('Some linked records are not there.');
    }
    // Parents and dependencies never lead back to the record itself.
    if (recordId) {
      for (const field of ctx.fields) {
        if ((field.type !== 'parent' && field.type !== 'dependency') || !(field.id in patch)) continue;
        const targets = (patch[field.id] as string[] | null) ?? [];
        if (targets.length && (await reaches(field.id, targets, recordId))) {
          throw conflict(
            'link_cycle',
            field.type === 'parent'
              ? 'A record cannot be inside its own children.'
              : 'These dependencies would go round in a circle.',
          );
        }
      }
    }
    const newFiles = [...new Set(ctx.fields.filter((field) => field.type === 'attachment').flatMap(added))];
    if (newFiles.length) {
      const [own, elsewhere] = await Promise.all([
        getDb()
          .select({ id: files.id })
          .from(files)
          .where(
            and(
              inIds(files.id, newFiles),
              eq(files.purpose, 'record'),
              eq(files.baseId, ctx.base.id),
              eq(files.status, 'active'),
              eq(files.ownerId, ctx.reader.memberId),
            ),
          ),
        getDb()
          .select({ id: baseRecordFiles.fileId })
          .from(baseRecordFiles)
          .where(
            and(inIds(baseRecordFiles.fileId, newFiles), recordId ? ne(baseRecordFiles.recordId, recordId) : undefined),
          )
          .limit(1),
      ]);
      if (own.length !== newFiles.length || elsewhere.length) {
        throw invalidInput('Attach files you uploaded to this base.');
      }
    }
  }

  /**
   * Whether following the field's links from these records reaches `recordId`. One such check
   * per field at a time (held until the write commits), so two writes cannot close a loop
   * together; the walk visits each record once.
   */
  async function reaches(fieldId: string, from: readonly string[], recordId: string): Promise<boolean> {
    await getDb().execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`base_links:${fieldId}`}))`);
    const rows = await getDb().execute<{ found: number }>(sql`
      WITH RECURSIVE walk(id) AS (
        SELECT unnest(${idList(from)})
        UNION
        SELECT l.target_record_id FROM base_record_links l JOIN walk w ON l.source_record_id = w.id
        WHERE l.field_id = ${fieldId}
      )
      SELECT 1 AS found FROM walk WHERE id = ${recordId} LIMIT 1`);
    return [...rows].length > 0;
  }

  /**
   * Writes one record: new (`row` null) or a change to `row`. A change that changes nothing
   * writes nothing. Runs inside the caller's transaction. `actor` is who the history names: the
   * member, or the form or import they used.
   */
  async function write(ctx: Writing, row: BaseRecordRow | null, input: RecordValues, actor?: RecordActor) {
    const captured = await deps.automations()?.before(ctx.table.id, row?.id ?? null);
    const keys = Object.keys(input);
    if (keys.length > 300) throw invalidInput('Too many fields in one change.');
    const refs = emptyRefs();
    const patch: Record<string, unknown> = {};
    for (const key of keys) {
      const field = ctx.byId.get(key);
      if (!field || ctx.scope.hidden.has(key)) throw invalidInput('Some fields are not in this table.', { field: key });
      if (isComputedType(field.type)) {
        throw invalidInput(`「${field.name}」 is worked out from other fields and cannot be set.`, { field: key });
      }
      patch[key] = normalizeValue(field, input[key], refs);
    }
    const before = row ? await valuesNow(ctx, row) : {};
    const after: Record<string, unknown> = { ...before, ...patch };
    const changes = changesBetween(
      row ? Object.keys(patch) : ctx.fields.map((field) => field.id),
      before,
      after,
    ).filter((change) => row || !isEmptyValue(change.after) || change.after === true);
    if (row && !changes.length) return { row, changed: false };
    // A field change (a type change converting values) holds this row for update until it commits.
    await getDb().select({ id: baseTables.id }).from(baseTables).where(eq(baseTables.id, ctx.table.id)).for('share');
    await checkRefs(ctx, refs, row?.id ?? null, before, patch);
    for (const field of ctx.fields) {
      if (
        field.required &&
        isEmptyValue(after[field.id]) &&
        (!row || field.id in patch) &&
        !ctx.scope.hidden.has(field.id)
      ) {
        throw invalidInput(`「${field.name}」 is required.`, { field: field.id });
      }
    }
    const stored: Record<string, unknown> = {};
    // Values of archived fields stay in the record until the field is deleted for good.
    for (const [key, value] of Object.entries(row?.values ?? {})) if (!ctx.byId.has(key)) stored[key] = value;
    for (const field of ctx.fields) {
      const value = after[field.id];
      if (!keptApart(field) && !isComputedType(field.type) && value !== null && value !== undefined) {
        stored[field.id] = value;
      }
    }
    const search = searchOf(ctx.fields, after);
    const memberId = ctx.reader.memberId;
    const [saved] = row
      ? await getDb()
          .update(baseRecords)
          .set({
            values: stored,
            revision: sql`${baseRecords.revision} + 1`,
            ...search,
            updatedBy: memberId,
            updatedAt: sql`now()`,
          })
          .where(eq(baseRecords.id, row.id))
          .returning()
      : await getDb()
          .insert(baseRecords)
          .values({
            id: newId('record'),
            tableId: ctx.table.id,
            values: stored,
            ...search,
            createdBy: memberId,
            updatedBy: memberId,
          })
          .returning();
    const id = saved!.id;
    for (const field of ctx.fields) {
      if (!(field.id in patch)) continue;
      const ids = (patch[field.id] as string[] | null) ?? [];
      if (isLinkType(field.type)) {
        // Links to records in the recycle bin stay, so restoring one brings them back.
        await getDb().execute(sql`
          DELETE FROM base_record_links l USING base_records t
          WHERE l.field_id = ${field.id} AND l.source_record_id = ${id}
            AND t.id = l.target_record_id AND t.deleted_at IS NULL`);
        if (ids.length) {
          await getDb()
            .insert(baseRecordLinks)
            .values(
              ids.map((target, position) => ({
                fieldId: field.id,
                sourceRecordId: id,
                targetRecordId: target,
                position,
              })),
            )
            .onConflictDoUpdate({
              target: [baseRecordLinks.fieldId, baseRecordLinks.sourceRecordId, baseRecordLinks.targetRecordId],
              set: { position: sql`excluded.position` },
            });
        }
      } else if (field.type === 'attachment') {
        await getDb()
          .delete(baseRecordFiles)
          .where(and(eq(baseRecordFiles.recordId, id), eq(baseRecordFiles.fieldId, field.id)));
        if (ids.length) {
          await getDb()
            .insert(baseRecordFiles)
            .values(ids.map((fileId, position) => ({ recordId: id, fieldId: field.id, fileId, position })));
        }
      }
    }
    const computed = await deps.computed.afterWrite(saved!, row ? Object.keys(patch) : null);
    // A custom role writes only inside the records it sees.
    if (!(await seen(ctx, id))) {
      throw forbidden('Your role cannot put a record outside the records it sees.');
    }
    await event(computed, row ? 'updated' : 'created', memberId, changes, actor);
    if (captured) await deps.automations()?.after(captured, computed.id, computed.revision, Object.keys(patch), !row);
    return { row: computed, changed: true };
  }

  async function event(
    row: BaseRecordRow,
    type: RecordEventType,
    memberId: string,
    changes: BaseRecordChange[] = [],
    actor?: RecordActor,
  ) {
    await getDb()
      .insert(baseRecordEvents)
      .values({
        recordId: row.id,
        tableId: row.tableId,
        actorType: actor?.type ?? 'member',
        actorId: memberId,
        type,
        changes,
        meta: actor ? { [`${actor.type}_id`]: actor.id } : {},
      });
  }

  async function detail(ctx: Writing, row: BaseRecordRow): Promise<RecordDetail> {
    const shown = ctx.scope.fields;
    const filled = await fill([row], shown, {
      files: deps.files,
      memberId: ctx.reader.memberId,
      baseId: ctx.base.id,
      viewer: viewerOf(ctx.reader, ctx),
    });
    const parent = shown.find((field) => field.type === 'parent');
    const children = parent
      ? await getDb()
          .select({ id: baseRecords.id, values: baseRecords.values })
          .from(baseRecordLinks)
          .innerJoin(
            baseRecords,
            and(eq(baseRecords.id, baseRecordLinks.sourceRecordId), isNull(baseRecords.deletedAt)),
          )
          .where(
            and(eq(baseRecordLinks.fieldId, parent.id), eq(baseRecordLinks.targetRecordId, row.id), ctx.scope.rows),
          )
          .orderBy(asc(baseRecords.seq))
          .limit(200)
      : [];
    const primary = ctx.fields.find((field) => field.isPrimary);
    return {
      record: toRecord(row, filled.values.get(row.id)!, shown),
      base_id: ctx.base.id,
      table_id: ctx.table.id,
      linked: filled.linked,
      files: filled.files,
      children: children.map((child) => ({ id: child.id, title: titleOf(primary, child.values) })),
    };
  }

  const lockRow = async (id: string) => {
    const [row] = await getDb().select().from(baseRecords).where(eq(baseRecords.id, id)).for('update');
    return row;
  };

  async function tellChanged(at: Pick<TableAt, 'base' | 'table'>, rows: ReadonlyArray<ChangedRecord>) {
    deps.kick();
    if (!rows.length) return;
    await deps.touch(at.base.id);
    deps.changed(at.base, at.table.id, rows.length > 100 ? [] : rows.map((row) => ({ ...row })));
  }

  /** Records that lost links when others were deleted for good: their people are told. */
  async function tellTouched(base: Pick<BaseRow, 'id' | 'ownerId'>, touched: readonly TouchedRecord[]) {
    const byTable = new Map<string, ChangedRecord[]>();
    for (const row of touched) {
      byTable.set(row.tableId, [...(byTable.get(row.tableId) ?? []), { id: row.id, revision: row.revision }]);
    }
    for (const [tableId, rows] of byTable) deps.changed(base, tableId, rows.length > 100 ? [] : rows);
  }

  async function removeIn(at: TableAt, scope: TableScope, memberId: string, ids: readonly string[]) {
    const removed = await transaction(async () => {
      const rows = await getDb()
        .update(baseRecords)
        .set({ deletedAt: sql`now()`, deletedBy: memberId, revision: sql`${baseRecords.revision} + 1` })
        .where(
          and(
            inIds(baseRecords.id, ids),
            eq(baseRecords.tableId, at.table.id),
            isNull(baseRecords.deletedAt),
            scope.rows,
          ),
        )
        .returning();
      for (const row of rows) await event(row, 'deleted', memberId);
      // Links to them no longer show: what reads those links follows.
      await deps.computed.linksChanged(rows.map((row) => row.id));
      return rows;
    });
    await tellChanged(at, removed.map(asChanged));
    return removed.length;
  }

  /** Whether a member sees this record now (for notifications). */
  async function canSee(memberId: string, recordId: string): Promise<boolean> {
    try {
      await recordAt(await loadReader(memberId), recordId, 'viewer');
      return true;
    } catch {
      return false;
    }
  }

  // ── Comments ─────────────────────────────────────────

  async function commentViews(memberId: string, rows: CommentRow[]) {
    const [people, writers] = await Promise.all([
      memberNames(rows.map((row) => row.createdBy)),
      agentNames(rows.map((row) => row.agentId)),
    ]);
    return (row: CommentRow): KnowledgeComment => ({
      id: row.id,
      target_type: row.targetType,
      target_id: row.targetId,
      body: row.body,
      mentions: row.mentions,
      created_by: refOf(people, row.createdBy),
      agent: row.agentId ? { id: row.agentId, name: writers.get(row.agentId) ?? '' } : null,
      mine: row.createdBy === memberId,
      edited: Date.parse(row.updatedAt) > Date.parse(row.createdAt),
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    });
  }

  /** Newly mentioned members, and the record's creator on a new comment, are told when they can read it. */
  async function tellComment(
    at: TableAt & { record: BaseRecordRow },
    actor: TablesReader,
    comment: CommentRow,
    previous: readonly string[] | null,
  ) {
    const fields = await fieldsOf(at.table.id);
    const title =
      titleOf(
        fields.find((field) => field.isPrimary),
        at.record.values,
      ) || at.table.name;
    const body = markdownText(comment.body).replace(/\s+/g, ' ').slice(0, 140);
    const earlier = new Set(previous ?? []);
    const mentioned = comment.mentions.filter((id) => !earlier.has(id) && id !== actor.memberId).slice(0, MAX_TOLD);
    const payload = {
      base_id: at.base.id,
      table_id: at.table.id,
      comment_id: comment.id,
      from_member_id: actor.memberId,
    };
    const tell = async (memberId: string, kind: 'mention' | 'comment', dedupeKey: string) => {
      // Only someone who sees this record (a custom role may not) hears about its comments.
      if (!(await canSee(memberId, at.record.id))) return;
      const reader = await loadReader(memberId);
      const zh = reader.locale === 'zh';
      await deps.notifications.publish({
        memberId,
        kind,
        title:
          kind === 'mention'
            ? zh
              ? han`${actor.name} 在「${title}」的评论里提到了你`
              : `${actor.name} mentioned you in a comment on "${title}"`
            : zh
              ? han`${actor.name} 评论了「${title}」`
              : `${actor.name} commented on "${title}"`,
        body,
        targetType: 'record',
        targetId: at.record.id,
        payload: { category: kind, ...payload },
        dedupeKey,
      });
    };
    for (const memberId of mentioned)
      await tell(memberId, 'mention', `record-comment:${comment.id}:mention:${memberId}`);
    const creator = at.record.createdBy;
    if (previous === null && creator && creator !== actor.memberId && !mentioned.includes(creator)) {
      await tell(creator, 'comment', `record-comment:${comment.id}`);
    }
  }

  async function ownComment(reader: TablesReader, at: TableAt, recordId: string, commentId: string, removing: boolean) {
    const [row] = await getDb()
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.id, commentId),
          eq(comments.targetType, 'record'),
          eq(comments.targetId, recordId),
          isNull(comments.deletedAt),
        ),
      );
    if (!row) throw notFound('Comment');
    // An owner of the base may remove any comment; only its writer changes one.
    if (row.createdBy !== reader.memberId && !(removing && at.role === 'owner')) {
      throw forbidden('Only who wrote a comment can change it.');
    }
    return row;
  }

  /** A deleted record for the recycle bin's people: editors and up with one of the four roles. */
  async function inBin(reader: TablesReader, recordId: string) {
    const [found] = await getDb().select().from(baseRecords).where(eq(baseRecords.id, recordId));
    if (!found) throw notFound('Record');
    const at = await tableAt(reader, found.tableId, 'viewer', { archived: true, kind: 'Record' });
    // To anyone else a deleted record is not there, and a live one is not in the bin.
    if (!found.deletedAt || at.access || !roleAtLeast(at.role, 'editor')) throw notFound('Record');
    return { at, found };
  }

  /** ⌘K in bases seen through a custom role: only the fields and records the role sees. */
  async function searchCustom(reader: TablesReader, q: string, limit: number) {
    const custom = await customBasesOf(reader);
    if (!custom.size) return { ids: [] as string[], items: [] as SearchHit[] };
    const ids = [...custom.keys()];
    const hits: SearchHit[] = [];
    const baseRows = await getDb()
      .select({ id: bases.id, name: bases.name })
      .from(bases)
      .where(inIds(bases.id, ids.slice(0, MAX_CUSTOM_SEARCH_BASES)));
    for (const base of baseRows) {
      const access = custom.get(base.id)!;
      const tables = await getDb()
        .select()
        .from(baseTables)
        .where(
          and(
            eq(baseTables.baseId, base.id),
            isNull(baseTables.archivedAt),
            inIds(baseTables.id, [...access.tables.keys()]),
          ),
        )
        .orderBy(asc(baseTables.position));
      for (const table of tables) {
        if (hits.length >= limit) break;
        const hidden = await hiddenFields(access, table.id);
        const fields = (await fieldsOf(table.id)).filter((field) => !hidden.has(field.id));
        const ctx: QueryContext = {
          fields: new Map(fields.map((field) => [field.id, field])),
          memberId: reader.memberId,
          timeZone: reader.timeZone,
        };
        const rows = await rowsOf(reader, { table, custom: access.tables.get(table.id)! });
        const primary = fields.find((field) => field.isPrimary);
        const found = await getDb()
          .select({ id: baseRecords.id, values: baseRecords.values })
          .from(baseRecords)
          .where(recordsWhere(table.id, rows, compileSearch(q, ctx)))
          .orderBy(desc(baseRecords.seq))
          .limit(limit - hits.length);
        for (const row of found) {
          hits.push({
            id: row.id,
            title: titleOf(primary, row.values),
            base_id: base.id,
            table_id: table.id,
            where: `${base.name} / ${table.name}`,
          });
        }
      }
    }
    return { ids, items: hits };
  }

  return {
    /**
     * A record made through a form or an import, as `writer` (the member who submitted or
     * imported), checked like any write. Runs inside the caller's transaction; call `announce`
     * after it commits.
     */
    async insertFrom(
      at: TableAt,
      writer: TablesReader,
      values: RecordValues,
      actor: RecordActor,
    ): Promise<BaseRecordRow> {
      const ctx = await writing(writer, at);
      const { row } = await write(ctx, null, values, actor);
      return row;
    },

    /** An app write inside its publication lock; the caller announces only after the outer commit. */
    async changeFrom(
      memberId: string,
      tableId: string,
      values: RecordValues,
      actor: RecordActor,
      target?: { id: string; revision: number },
    ) {
      const reader = await loadReader(memberId);
      const at = target ? await recordAt(reader, target.id, 'editor') : await tableAt(reader, tableId, 'editor');
      if (at.table.id !== tableId) throw notFound('Record');
      const ctx = await writing(reader, at);
      const old = target ? await lockRow(target.id) : null;
      if (target && (!old || old.deletedAt)) throw notFound('Record');
      if (target && old!.revision !== target.revision) throw stale((await detail(ctx, old!)).record);
      const { row } = await write(ctx, old, values, actor);
      await deps.touch(ctx.base.id);
      return { at, row, detail: await detail(ctx, row) };
    },

    /** Tells the base's people about records written by `insertFrom` (after the commit). */
    async announce(at: Pick<TableAt, 'base' | 'table'>, rows: readonly BaseRecordRow[]) {
      await tellChanged(at, rows.map(asChanged));
    },

    /** Records deleted for good elsewhere (a table, the daily purge) that others linked to. */
    tellTouched,

    /** A page of a table's records that match, in order, with linked titles and files. */
    async query(memberId: string, tableId: string, input: RecordsQuery): Promise<RecordPage> {
      const reader = await loadReader(memberId);
      const at = await tableAt(reader, tableId, 'viewer');
      const scope = await scopeOf(reader, at);
      const ctx: QueryContext = {
        fields: new Map(scope.fields.map((field) => [field.id, field])),
        memberId,
        timeZone: reader.timeZone,
      };
      const limit = input.limit ?? 200;
      const where = recordsWhere(
        tableId,
        scope.rows,
        compileFilter(input.filter, ctx),
        compileSearch(input.search, ctx),
      );
      const order = compileOrder(input.sorts, input.group, ctx);
      const print = fingerprint(tableId, [
        input.filter ?? null,
        input.sorts ?? [],
        input.group ?? null,
        input.search ?? '',
      ]);
      const offset = decodeOffset(input.cursor, print);
      const rows = await getDb()
        .select()
        .from(baseRecords)
        .where(where)
        .orderBy(...order)
        .limit(limit + 1)
        .offset(offset);
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const [filled, total] = await Promise.all([
        fill(page, scope.fields, { files: deps.files, memberId, baseId: at.base.id, viewer: viewerOf(reader, at) }),
        input.count
          ? getDb()
              .select({ n: sql<number>`count(*)::int` })
              .from(baseRecords)
              .where(where)
              .then(([row]) => row?.n ?? 0)
          : Promise.resolve(undefined),
      ]);
      return {
        items: page.map((row) => toRecord(row, filled.values.get(row.id)!, scope.fields)),
        next_cursor: more ? encodeOffset(offset + limit, print) : null,
        ...(total !== undefined ? { total } : {}),
        linked: filled.linked,
        files: filled.files,
      };
    },

    async get(memberId: string, recordId: string): Promise<RecordDetail> {
      const reader = await loadReader(memberId);
      const at = await recordAt(reader, recordId, 'viewer');
      return detail(await writing(reader, at), at.record);
    },

    async create(memberId: string, tableId: string, values: RecordValues): Promise<RecordDetail> {
      const reader = await loadReader(memberId);
      const ctx = await writing(reader, await tableAt(reader, tableId, 'editor'));
      const { row } = await transaction(() => write(ctx, null, values));
      await tellChanged(ctx, [asChanged(row)]);
      return detail(ctx, row);
    },

    /** A change based on `revision`; a newer record answers 409 `stale_revision` with the record now. */
    async update(memberId: string, recordId: string, revision: number, values: RecordValues): Promise<RecordDetail> {
      const reader = await loadReader(memberId);
      const ctx = await writing(reader, await recordAt(reader, recordId, 'editor'));
      const result = await transaction(async () => {
        const row = await lockRow(recordId);
        if (!row || row.deletedAt) throw notFound('Record');
        if (row.revision !== revision) return { stale: row };
        return write(ctx, row, values);
      });
      if ('stale' in result) throw stale((await detail(ctx, result.stale)).record);
      if (result.changed) await tellChanged(ctx, [asChanged(result.row)]);
      return detail(ctx, result.row);
    },

    /**
     * Many changes and new records at once (a paste); each succeeds or fails on its own, and a
     * failure is that item's answer, whatever it was.
     */
    async bulk(memberId: string, tableId: string, input: BulkRecordsInput): Promise<BulkResult> {
      const reader = await loadReader(memberId);
      const ctx = await writing(reader, await tableAt(reader, tableId, 'editor'));
      const outcomes: Array<{ row: BaseRecordRow } | { code: string; message: string }> = [];
      const changed: BaseRecordRow[] = [];
      for (const item of input.items) {
        try {
          const result = await transaction(async () => {
            if (!item.id) return write(ctx, null, item.values);
            const row = await lockRow(item.id);
            if (!row || row.deletedAt || row.tableId !== tableId || !(await seen(ctx, row.id))) {
              throw notFound('Record');
            }
            if (item.revision !== undefined && row.revision !== item.revision) {
              throw new ApiError(409, 'stale_revision', 'Someone changed this record.');
            }
            return write(ctx, row, item.values);
          });
          if (result.changed) changed.push(result.row);
          outcomes.push({ row: result.row });
        } catch (error) {
          if (error instanceof ApiError) outcomes.push({ code: error.code, message: error.message });
          else {
            logger.warn('[tables] a record of a paste could not be saved', {
              table: tableId,
              error: toErrorMessage(error),
            });
            outcomes.push({
              code: isUniqueViolation(error) ? 'conflict' : 'failed',
              message: 'This record could not be saved.',
            });
          }
        }
      }
      const rows = outcomes.flatMap((outcome) => ('row' in outcome ? [outcome.row] : []));
      const filled = await fill(rows, ctx.scope.fields, {
        files: deps.files,
        memberId,
        baseId: ctx.base.id,
        viewer: viewerOf(reader, ctx),
      });
      await tellChanged(ctx, changed.map(asChanged));
      return {
        items: outcomes.map((outcome) =>
          'row' in outcome
            ? { ok: true, record: toRecord(outcome.row, filled.values.get(outcome.row.id)!, ctx.scope.fields) }
            : { ok: false, code: outcome.code, message: outcome.message },
        ),
        linked: filled.linked,
        files: filled.files,
      };
    },

    /** To the recycle bin: gone from every view, back with restore for TRASH_DAYS. */
    async remove(memberId: string, recordId: string): Promise<void> {
      const reader = await loadReader(memberId);
      const at = await recordAt(reader, recordId, 'editor');
      await removeIn(at, await scopeOf(reader, at), memberId, [recordId]);
    },

    async removeMany(memberId: string, tableId: string, ids: readonly string[]): Promise<number> {
      const reader = await loadReader(memberId);
      const at = await tableAt(reader, tableId, 'editor');
      return removeIn(at, await scopeOf(reader, at), memberId, ids);
    },

    async restore(memberId: string, recordId: string): Promise<TableRecord> {
      const reader = await loadReader(memberId);
      const { at } = await inBin(reader, recordId);
      if (at.table.archivedAt) throw conflict('table_archived', 'Restore its data table first.');
      const ctx = await writing(reader, at);
      const row = await transaction(async () => {
        const [restored] = await getDb()
          .update(baseRecords)
          .set({ deletedAt: null, deletedBy: null, revision: sql`${baseRecords.revision} + 1` })
          .where(and(eq(baseRecords.id, recordId), sql`${baseRecords.deletedAt} IS NOT NULL`))
          .returning();
        if (!restored) throw notFound('Record');
        await event(restored, 'restored', memberId);
        // Its own computed values were not kept up while it was away; links to it show again.
        const fresh = await deps.computed.afterWrite(restored, []);
        await deps.computed.linksChanged([restored.id]);
        return fresh;
      });
      await tellChanged(ctx, [asChanged(row)]);
      return toRecord(row, await valuesNow(ctx, row), ctx.scope.fields);
    },

    /** Deletes a record in the recycle bin for good, with its files (builders). */
    async purge(memberId: string, recordId: string): Promise<void> {
      const reader = await loadReader(memberId);
      const { at } = await inBin(reader, recordId);
      if (!roleAtLeast(at.role, 'builder')) throw needsRole('builder');
      const purged = await transaction(() => purgeRecords([recordId], { memberId, baseId: at.base.id }));
      if (!purged.count) throw notFound('Record');
      await tellTouched(at.base, purged.touched);
      deps.kick();
    },

    /** Comments and changes, newest first. */
    async activity(
      memberId: string,
      recordId: string,
      query: { cursor?: string | undefined; limit: number },
    ): Promise<RecordActivity> {
      const reader = await loadReader(memberId);
      const at = await recordAt(reader, recordId, 'viewer', { deleted: true });
      const fields = await fieldsOf(at.table.id, { archived: true });
      const byId = new Map(fields.map((field) => [field.id, field]));
      // A custom role sees the changes of the fields it sees; a change of only others is not shown.
      const visible = at.access ? (await scopeOf(reader, at)).fields.map((field) => field.id) : null;
      const shown = (change: BaseRecordChange) => !visible || visible.includes(change.field);
      const before = decodeActivity(query.cursor);
      // Newest first; at the same instant comments come before events, then by id, newest first.
      const older = (created: SQL, id: SQL, kind: 'c' | 'e'): SQL | undefined =>
        before
          ? or(
              sql`${created} < ${before.t}::timestamptz`,
              kind === 'e' && before.k === 'c' ? sql`${created} = ${before.t}::timestamptz` : undefined,
              before.k === kind ? sql`${created} = ${before.t}::timestamptz AND ${id} < ${before.i}` : undefined,
            )
          : undefined;
      const [events, notes] = await Promise.all([
        getDb()
          .select()
          .from(baseRecordEvents)
          .where(
            and(
              eq(baseRecordEvents.recordId, recordId),
              older(sql`${baseRecordEvents.createdAt}`, sql`lpad(${baseRecordEvents.id}::text, 20, '0')`, 'e'),
              visible
                ? sql`(${baseRecordEvents.type} <> 'updated' OR EXISTS (
                    SELECT 1 FROM jsonb_array_elements(${baseRecordEvents.changes}) c
                    WHERE c ->> 'field' = ANY(${idList(visible)})))`
                : undefined,
            ),
          )
          .orderBy(desc(baseRecordEvents.createdAt), desc(baseRecordEvents.id))
          .limit(query.limit + 1),
        getDb()
          .select()
          .from(comments)
          .where(
            and(
              eq(comments.targetType, 'record'),
              eq(comments.targetId, recordId),
              isNull(comments.deletedAt),
              older(sql`${comments.createdAt}`, sql`${comments.id}`, 'c'),
            ),
          )
          .orderBy(desc(comments.createdAt), desc(comments.id))
          .limit(query.limit + 1),
      ]);
      const [view, people] = await Promise.all([
        commentViews(memberId, notes),
        memberNames(events.map((row) => row.actorId)),
      ]);
      type Entry = { at: number; created: string; kind: 'c' | 'e'; id: string; item: RecordActivityItem };
      const entries: Entry[] = [
        ...events.map((row) => ({
          at: Date.parse(row.createdAt),
          created: row.createdAt,
          kind: 'e' as const,
          id: String(row.id).padStart(20, '0'),
          item: {
            kind: 'event' as const,
            id: String(row.id),
            type: row.type,
            actor: { type: row.actorType, id: row.actorId, name: (row.actorId && people.get(row.actorId)) || '' },
            changes: row.changes.filter(shown).map((change) => ({
              field: change.field,
              name: byId.get(change.field)?.name ?? '',
              before: change.before ?? null,
              after: change.after ?? null,
            })),
            created_at: row.createdAt,
          },
        })),
        ...notes.map((row) => ({
          at: Date.parse(row.createdAt),
          created: row.createdAt,
          kind: 'c' as const,
          id: row.id,
          item: { kind: 'comment' as const, ...view(row) },
        })),
      ].sort((a, b) => b.at - a.at || (a.kind === b.kind ? (a.id < b.id ? 1 : -1) : a.kind === 'c' ? -1 : 1));
      const page = entries.slice(0, query.limit);
      const last = page[page.length - 1];
      // Titles only for the values of link fields, and only of records in this base.
      const linkIds = new Set<string>();
      for (const entry of page) {
        if (entry.item.kind !== 'event') continue;
        for (const change of entry.item.changes) {
          const field = byId.get(change.field);
          if (!field || !isLinkType(field.type)) continue;
          for (const value of [change.before, change.after]) {
            if (!Array.isArray(value)) continue;
            for (const id of value) if (typeof id === 'string') linkIds.add(id);
          }
        }
      }
      return {
        items: page.map((entry) => entry.item),
        next_cursor:
          entries.length > query.limit && last
            ? Buffer.from(JSON.stringify({ t: last.created, k: last.kind, i: last.id })).toString('base64url')
            : null,
        linked: await titlesOf(at.base.id, [...linkIds], viewerOf(reader, at)),
      };
    },

    /** Anyone who can read a record may comment on it. */
    async addComment(memberId: string, recordId: string, body: string): Promise<KnowledgeComment> {
      const reader = await loadReader(memberId);
      const at = await recordAt(reader, recordId, 'viewer');
      const [row] = await getDb()
        .insert(comments)
        .values({
          id: newId('comment'),
          targetType: 'record',
          targetId: recordId,
          baseId: at.base.id,
          createdBy: memberId,
          body,
          mentions: mentionIds(body),
        })
        .returning();
      await tellComment(at, reader, row!, null);
      deps.commented(at.base, recordId, row!.id);
      return (await commentViews(memberId, [row!]))(row!);
    },

    async editComment(memberId: string, recordId: string, commentId: string, body: string): Promise<KnowledgeComment> {
      const reader = await loadReader(memberId);
      const at = await recordAt(reader, recordId, 'viewer');
      const own = await ownComment(reader, at, recordId, commentId, false);
      const [row] = await getDb()
        .update(comments)
        .set({ body, mentions: mentionIds(body), updatedAt: sql`now()` })
        .where(eq(comments.id, own.id))
        .returning();
      await tellComment(at, reader, row!, own.mentions);
      deps.commented(at.base, recordId, row!.id);
      return (await commentViews(memberId, [row!]))(row!);
    },

    async removeComment(memberId: string, recordId: string, commentId: string): Promise<void> {
      const reader = await loadReader(memberId);
      const at = await recordAt(reader, recordId, 'viewer');
      const own = await ownComment(reader, at, recordId, commentId, true);
      await getDb()
        .update(comments)
        .set({ deletedAt: sql`now()` })
        .where(eq(comments.id, own.id));
      deps.commented(at.base, recordId, own.id);
    },

    /** Records of a table to pick from: id and title, matching `q`, by title. */
    async titles(memberId: string, tableId: string, query: { q?: string | undefined; limit: number }) {
      const reader = await loadReader(memberId);
      const at = await tableAt(reader, tableId, 'viewer');
      const primary = (await fieldsOf(tableId)).find((field) => field.isPrimary);
      if (!primary) return { items: [] };
      const title = sql<string>`coalesce(${baseRecords.values} ->> ${primary.id}, '')`;
      const rows = await getDb()
        .select({ id: baseRecords.id, title })
        .from(baseRecords)
        .where(
          recordsWhere(
            tableId,
            await rowsOf(reader, at),
            query.q ? sql`${title} ILIKE ${containing(query.q)}` : undefined,
          ),
        )
        .orderBy(asc(title), asc(baseRecords.id))
        .limit(query.limit);
      return { items: rows.map((row) => ({ id: row.id, title: row.title })) };
    },

    /**
     * Full-text search of the records a member can read (⌘K); nothing when tables are off for
     * them. In a base they see through a custom role, only its fields and records count.
     */
    async search(memberId: string, q: string, limit: number): Promise<SearchHit[]> {
      const reader = await loadReader(memberId).catch(() => null);
      const tsquery = searchQuery(q, '&');
      if (!reader || !tsquery) return [];
      const custom = await searchCustom(reader, q, limit);
      const rows = await getDb().execute<{
        id: string;
        table_id: string;
        base_id: string;
        title: string | null;
        table_name: string;
        base_name: string;
      }>(sql`
        SELECT r.id, r.table_id, t.base_id, r.values ->> f.id AS title, t.name AS table_name, bases.name AS base_name
        FROM base_records r
        JOIN base_tables t ON t.id = r.table_id AND t.archived_at IS NULL
        JOIN bases ON bases.id = t.base_id AND bases.archived_at IS NULL
        JOIN base_fields f ON f.table_id = r.table_id AND f.is_primary
        WHERE r.deleted_at IS NULL AND r.search_tsv @@ to_tsquery('simple', ${tsquery}) AND ${readableBases(reader)}
          AND NOT (t.base_id = ANY(${idList(custom.ids)}))
        ORDER BY ts_rank(r.search_tsv, to_tsquery('simple', ${tsquery})) DESC, r.id DESC
        LIMIT ${limit}`);
      const standard = [...rows].map((row) => ({
        id: row.id,
        title: row.title ?? '',
        base_id: row.base_id,
        table_id: row.table_id,
        where: `${row.base_name} / ${row.table_name}`,
      }));
      return [...standard, ...custom.items].slice(0, limit);
    },
  };
}

export interface SearchHit {
  id: string;
  title: string;
  base_id: string;
  table_id: string;
  where: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

function decodeActivity(cursor: string | undefined): { t: string; k: 'c' | 'e'; i: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t?: unknown;
      k?: unknown;
      i?: unknown;
    };
    if (
      typeof value.t === 'string' &&
      TIMESTAMP.test(value.t) &&
      (value.k === 'c' || value.k === 'e') &&
      typeof value.i === 'string' &&
      value.i.length <= 64
    ) {
      return { t: value.t, k: value.k, i: value.i };
    }
  } catch {
    // fall through
  }
  throw invalidInput('The cursor is invalid.');
}

export type RecordsPart = ReturnType<typeof createRecords>;
