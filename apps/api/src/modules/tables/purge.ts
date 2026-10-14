/**
 * Deleting for good. Records leave with their links, files rows, history and comments in the
 * caller's transaction, with an audit entry; a record that linked to one of them gets a history
 * entry and a new revision, since its links changed. File bytes go only after the commit, through
 * a `base_discard` job, so a transaction that rolls back never leaves a record pointing at bytes
 * that are gone. Once a day (`base_purge`) the recycle bin lets go of records it has held for
 * TRASH_DAYS, expired imports go, and attachment files no record holds any more are discarded.
 */

import { and, asc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { TRASH_DAYS } from '@greenhouse/contract';
import {
  baseRecordEvents,
  baseRecordFiles,
  baseRecords,
  baseTables,
  comments,
  files,
  getDb,
  newId,
  transaction,
  type BaseRecordChange,
} from '@greenhouse/db';
import { audit } from '../../audit.js';
import { enqueueJob, type JobOutcome } from '../../jobs.js';
import type { FilesService } from '../files/service.js';
import { idList, inIds } from './query.js';

/** Who deletes for good: a member, or the daily purge (null). */
export interface PurgeBy {
  memberId: string | null;
  baseId: string;
}

/** A record whose links changed because what it linked to was deleted for good. */
export interface TouchedRecord {
  id: string;
  tableId: string;
  revision: number;
}

export interface Purged {
  /** How many records went. */
  count: number;
  /** Records that stay and lost links (their revision moved; tell the base's people). */
  touched: TouchedRecord[];
}

/** Records the daily purge takes at a time. */
const EXPIRED_BATCH = 500;
/** Unattached record files are kept this long (an upload waiting for its record to be saved). */
const DETACHED_AFTER = '1 day';

/** Discards these files' bytes once the transaction that let go of them has committed. */
export async function discardLater(fileIds: readonly string[]): Promise<void> {
  if (!fileIds.length) return;
  await enqueueJob({
    kind: 'base_discard',
    dedupeKey: `base_discard:${newId('job')}`,
    payload: { file_ids: [...fileIds] },
  });
}

/**
 * Deletes records for good, inside the caller's transaction: only records in the recycle bin,
 * unless `anyState` (a data table deleted for good takes all of its records).
 */
export async function purgeRecords(
  recordIds: readonly string[],
  by: PurgeBy,
  options: { anyState?: boolean; audit?: boolean } = {},
): Promise<Purged> {
  if (!recordIds.length) return { count: 0, touched: [] };
  const ids = [...new Set(recordIds)];
  const [held, links] = await Promise.all([
    getDb()
      .select({ record: baseRecordFiles.recordId, file: baseRecordFiles.fileId })
      .from(baseRecordFiles)
      .where(inIds(baseRecordFiles.recordId, ids)),
    // Links from records that stay to records that go, each source's whole list in order.
    getDb().execute<{ field_id: string; source_record_id: string; target_record_id: string }>(sql`
      SELECT l.field_id, l.source_record_id, l.target_record_id FROM base_record_links l
      WHERE (l.field_id, l.source_record_id) IN (
        SELECT o.field_id, o.source_record_id FROM base_record_links o
        WHERE o.target_record_id = ANY(${idList(ids)}) AND NOT (o.source_record_id = ANY(${idList(ids)})))
      ORDER BY l.source_record_id, l.field_id, l.position, l.target_record_id`),
  ]);
  const gone = await getDb()
    .delete(baseRecords)
    .where(and(inIds(baseRecords.id, ids), options.anyState ? undefined : isNotNull(baseRecords.deletedAt)))
    .returning({ id: baseRecords.id });
  if (!gone.length) return { count: 0, touched: [] };
  const goneIds = new Set(gone.map((row) => row.id));
  await getDb()
    .delete(comments)
    .where(and(eq(comments.targetType, 'record'), inIds(comments.targetId, [...goneIds])));
  // What each staying record linked to before and after, field by field.
  const lists = new Map<string, { source: string; field: string; before: string[] }>();
  for (const link of links) {
    const key = `${link.source_record_id}:${link.field_id}`;
    const entry = lists.get(key) ?? { source: link.source_record_id, field: link.field_id, before: [] };
    entry.before.push(link.target_record_id);
    lists.set(key, entry);
  }
  const changes = new Map<string, BaseRecordChange[]>();
  for (const entry of lists.values()) {
    const after = entry.before.filter((id) => !goneIds.has(id));
    if (after.length === entry.before.length) continue;
    const list = changes.get(entry.source) ?? [];
    list.push({ field: entry.field, before: entry.before, after: after.length ? after : null });
    changes.set(entry.source, list);
  }
  let touched: TouchedRecord[] = [];
  if (changes.size) {
    touched = (
      await getDb()
        .update(baseRecords)
        .set({ revision: sql`${baseRecords.revision} + 1`, updatedAt: sql`now()` })
        .where(inIds(baseRecords.id, [...changes.keys()]))
        .returning({ id: baseRecords.id, tableId: baseRecords.tableId, revision: baseRecords.revision })
    ).map((row) => ({ id: row.id, tableId: row.tableId, revision: row.revision }));
    await getDb()
      .insert(baseRecordEvents)
      .values(
        touched.map((row) => ({
          recordId: row.id,
          tableId: row.tableId,
          actorType: by.memberId ? ('member' as const) : ('system' as const),
          actorId: by.memberId,
          type: 'updated' as const,
          changes: changes.get(row.id) ?? [],
          meta: { purged: true },
        })),
      );
  }
  if (options.audit !== false) {
    await audit({
      actorType: by.memberId ? 'member' : 'system',
      actorId: by.memberId ?? 'tables',
      action: 'base_record.purge',
      resourceType: 'base',
      resourceId: by.baseId,
      scopeType: 'base',
      scopeId: by.baseId,
      summary: `${gone.length} records${by.memberId ? '' : `, after ${TRASH_DAYS} days in the recycle bin`}`,
    });
  }
  await discardLater(held.filter((row) => goneIds.has(row.record)).map((row) => row.file));
  return { count: gone.length, touched };
}

/** The bytes of files let go of: discarded after the commit that let go of them. */
export async function discardJob(
  filesService: Pick<FilesService, 'discard'>,
  payload: Record<string, unknown>,
): Promise<JobOutcome> {
  const ids = Array.isArray(payload.file_ids) ? payload.file_ids.filter((id) => typeof id === 'string') : [];
  for (const id of ids) {
    // A file a record holds again (it never left) stays.
    const [held] = await getDb()
      .select({ id: baseRecordFiles.fileId })
      .from(baseRecordFiles)
      .where(eq(baseRecordFiles.fileId, id))
      .limit(1);
    if (!held) await filesService.discard(id);
  }
  return { status: 'succeeded', result: { files: ids.length } };
}

/**
 * The daily purge: records in the recycle bin for more than TRASH_DAYS, then record files no
 * record holds (older than a day). Imports clean up after themselves (`expired`).
 */
export async function purgeJob(deps: {
  files: Pick<FilesService, 'discard'>;
  expiredImports: () => Promise<unknown>;
  /** Records that lost links: tell the base's people and recompute what reads them. */
  touched: (baseId: string, rows: TouchedRecord[]) => Promise<void>;
}): Promise<JobOutcome> {
  let records = 0;
  for (let round = 0; round < 40; round++) {
    const expired = await getDb()
      .select({ id: baseRecords.id, baseId: baseTables.baseId })
      .from(baseRecords)
      .innerJoin(baseTables, eq(baseTables.id, baseRecords.tableId))
      .where(lt(baseRecords.deletedAt, sql`now() - ${`${TRASH_DAYS} days`}::interval`))
      .orderBy(asc(baseRecords.deletedAt))
      .limit(EXPIRED_BATCH);
    if (!expired.length) break;
    const byBase = new Map<string, string[]>();
    for (const row of expired) byBase.set(row.baseId, [...(byBase.get(row.baseId) ?? []), row.id]);
    for (const [baseId, ids] of byBase) {
      const purged = await transaction(() => purgeRecords(ids, { memberId: null, baseId }));
      records += purged.count;
      if (purged.touched.length) await deps.touched(baseId, purged.touched);
    }
    if (expired.length < EXPIRED_BATCH) break;
  }
  await deps.expiredImports();
  const detached = await getDb()
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.purpose, 'record'),
        eq(files.status, 'active'),
        lt(files.createdAt, sql`now() - ${DETACHED_AFTER}::interval`),
        sql`NOT EXISTS (SELECT 1 FROM ${baseRecordFiles} WHERE ${baseRecordFiles.fileId} = ${files.id})`,
      ),
    )
    .limit(5000);
  for (const file of detached) await deps.files.discard(file.id);
  return { status: 'succeeded', result: { records, files: detached.length } };
}

/** Records of a data table, live or not (a table deleted for good takes them all). */
export async function recordIdsOf(tableId: string): Promise<string[]> {
  return (await getDb().select({ id: baseRecords.id }).from(baseRecords).where(eq(baseRecords.tableId, tableId))).map(
    (row) => row.id,
  );
}

/** Ids of files held by records of a field (a field deleted for good lets them go). */
export async function filesOfField(fieldId: string): Promise<string[]> {
  return (
    await getDb()
      .select({ id: baseRecordFiles.fileId })
      .from(baseRecordFiles)
      .where(eq(baseRecordFiles.fieldId, fieldId))
  ).map((row) => row.id);
}
