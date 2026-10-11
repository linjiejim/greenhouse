/**
 * Storage the app gateway needs beyond the record services
 * (docs/specs/20261011-tables-apps.md §3 — the API side is
 * `apps/api/src/platform/tables/app-*.ts`):
 *
 * - **Which of these records match**: a page of rows against a scope and an
 *   optional builder-written condition (an action's `when`), compiled by THE
 *   compiler as a row predicate — fail closed, never limited to readable
 *   fields, `$me` = the scope's user. One query per action for a whole page.
 * - **Records by id** inside a scope (relation labels: only rows the role reads).
 * - **Drive file metadata by id** (attachment labels in app rows).
 * - **App uploads**: `pending` tables-scope drive rows staged by one person
 *   through one app (`appUploadKeySegment`), claimed (pending → active) right
 *   before the write that attaches them and released if it fails; the hourly
 *   sweep expires the ones nobody attached.
 * - **The action ledger** (`table_app_action_requests`): claim a `requestId`
 *   before writing, keep the result, replay it for a repeat.
 * - **Usage**: distinct people and last use from the app-scoped audit (one
 *   indexed read on `idx_platform_audit_resource_created`), runs per action id
 *   from the ledger.
 */

import { and, eq, gte, inArray, isNull, lt, notExists, sql, type SQL } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { TableAccessScope } from '@greenhouse/types/table-access';
import type { TableFilterGroup } from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import {
  driveFiles,
  platformAuditEvents,
  tableAppActionRequests,
  tableRecordAttachments,
  tableRecords,
} from '../../schema/index.js';
import type { TableAppActionRequestRow } from '../../schema/table-apps.js';
import type { TableRecordRow } from '../../schema/tables.js';
import { compileRowScope, loadCompileContext, scopeRowPredicate, type TableQueryEvaluation } from './query.js';
import { assertScope, isPositiveInteger } from './shared.js';

/** The key segment that marks a pending tables-scope drive row as "staged through app N" (the API writes exactly this). */
export function appUploadKeySegment(baseId: number, appId: number): string {
  return `tables/${baseId}/apps/${appId}/`;
}

/** A running claim older than this is taken over (its process died between claim and result). */
const STALE_CLAIM_MS = 2 * 60 * 1000;
const MAX_IDS = 500;

export interface AppDriveFileMeta {
  id: number;
  name: string;
  size: number;
  content_type: string | null;
  status: 'pending' | 'active' | 'deleted';
  base_id: number | null;
  uploaded_by: string | null;
}

export type ClaimAppActionRequestResult =
  | { claimed: true; id: number }
  | { claimed: false; existing: TableAppActionRequestRow };

export interface AppUsageCounts {
  users7d: number;
  users30d: number;
  lastUsedAt: string | null;
  actions30d: Record<string, number>;
}

function positiveIds(ids: readonly number[]): number[] {
  return [...new Set(ids.filter(isPositiveInteger))].slice(0, MAX_IDS);
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export function createTablesAppGateway(db: Db) {
  const service = {
    /**
     * The ids among `recordIds` that are live, inside `scope` (read rows, or
     * read ∧ edit rows for `purpose: 'edit'`) and, when given, satisfy
     * `condition` — compiled like a row scope: a clause that cannot compile any
     * more (an archived field) is FALSE. An empty condition is no condition.
     */
    async matchRecordIds(
      tableId: number,
      recordIds: readonly number[],
      scope: TableAccessScope,
      options: { purpose?: 'read' | 'edit'; condition?: TableFilterGroup; evaluation?: TableQueryEvaluation } = {},
    ): Promise<Set<number>> {
      const { condition, ...rest } = options;
      const [matched] = await service.matchRecordIdsEach(tableId, recordIds, scope, [condition], rest);
      return matched ?? new Set();
    },

    /**
     * `matchRecordIds` for several conditions over the same page (a card's
     * actions): one compile context and one query, each condition a boolean
     * column (NULL = no match, as in a WHERE). `result[i]` answers
     * `conditions[i]`; an absent or empty condition is the scope alone.
     */
    async matchRecordIdsEach(
      tableId: number,
      recordIds: readonly number[],
      scope: TableAccessScope,
      conditions: ReadonlyArray<TableFilterGroup | undefined>,
      options: { purpose?: 'read' | 'edit'; evaluation?: TableQueryEvaluation } = {},
    ): Promise<Array<Set<number>>> {
      assertScope(scope);
      const ids = positiveIds(recordIds);
      if (ids.length === 0 || conditions.length === 0) return conditions.map(() => new Set<number>());
      const ctx = await loadCompileContext(db, tableId, scope, options.evaluation);
      const predicate = scopeRowPredicate(scope, ctx, options.purpose ?? 'read');
      const columns: Record<string, SQL<boolean>> = {};
      conditions.forEach((condition, index) => {
        const compiled =
          condition && Array.isArray(condition.clauses) && condition.clauses.length > 0
            ? compileRowScope({ type: 'where', where: condition }, ctx)
            : sql`true`;
        columns[`c${index}`] = sql<boolean>`coalesce((${compiled}), false)`;
      });
      const rows = await db
        .select({ id: tableRecords.id, ...columns })
        .from(tableRecords)
        .where(
          and(
            eq(tableRecords.table_id, tableId),
            inArray(tableRecords.id, ids),
            isNull(tableRecords.deleted_at),
            predicate,
          ),
        );
      return conditions.map((_, index) => {
        const key = `c${index}`;
        return new Set(rows.filter((row) => (row as Record<string, unknown>)[key] === true).map((row) => row.id));
      });
    },

    /** Live records by id that `scope` reads (full rows — project them for the reader). */
    async listRecordsByIds(
      tableId: number,
      recordIds: readonly number[],
      scope: TableAccessScope,
    ): Promise<TableRecordRow[]> {
      assertScope(scope);
      const ids = positiveIds(recordIds);
      if (ids.length === 0) return [];
      const ctx = await loadCompileContext(db, tableId, scope);
      return db
        .select()
        .from(tableRecords)
        .where(
          and(
            eq(tableRecords.table_id, tableId),
            inArray(tableRecords.id, ids),
            isNull(tableRecords.deleted_at),
            scopeRowPredicate(scope, ctx, 'read'),
          ),
        );
    },

    /** Drive file rows by id, any status (the caller decides what to show). */
    async listDriveFileMeta(fileIds: readonly number[]): Promise<AppDriveFileMeta[]> {
      const ids = positiveIds(fileIds);
      if (ids.length === 0) return [];
      return db
        .select({
          id: driveFiles.id,
          name: driveFiles.name,
          size: driveFiles.size,
          content_type: driveFiles.content_type,
          status: driveFiles.status,
          base_id: driveFiles.base_id,
          uploaded_by: driveFiles.uploaded_by,
        })
        .from(driveFiles)
        .where(inArray(driveFiles.id, ids));
    },

    // ─── App uploads ──────────────────────────────────────

    /** Files one person has staged through one app and not attached yet (the upload route caps them). */
    async countPendingAppUploads(appId: number, baseId: number, userId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(driveFiles)
        .where(
          and(
            eq(driveFiles.scope, 'tables'),
            eq(driveFiles.base_id, baseId),
            eq(driveFiles.status, 'pending'),
            eq(driveFiles.uploaded_by, userId),
            sql`${driveFiles.cos_key} LIKE ${`%${appUploadKeySegment(baseId, appId)}%`}`,
          ),
        );
      return row?.count ?? 0;
    },

    /**
     * Claim this person's staged uploads for this app (pending → active) so the
     * record write that attaches them accepts them. Returns the ids it flipped;
     * ids that are not theirs, not this app's, or not pending are left alone
     * (`appUploadsAttachable` decides whether the write may go on).
     */
    async claimAppUploads(input: { appId: number; baseId: number; userId: string; fileIds: readonly number[] }) {
      const ids = positiveIds(input.fileIds);
      if (ids.length === 0) return [];
      const rows = await db
        .update(driveFiles)
        .set({ status: 'active', updated_at: nowIso() })
        .where(
          and(
            inArray(driveFiles.id, ids),
            eq(driveFiles.scope, 'tables'),
            eq(driveFiles.base_id, input.baseId),
            eq(driveFiles.status, 'pending'),
            eq(driveFiles.uploaded_by, input.userId),
            sql`${driveFiles.cos_key} LIKE ${`%${appUploadKeySegment(input.baseId, input.appId)}%`}`,
          ),
        )
        .returning({ id: driveFiles.id });
      return rows.map((row) => row.id);
    },

    /**
     * Whether every id is an active file this person uploaded through this app
     * and no record other than `recordId` holds — what an app write may attach.
     */
    async appUploadsAttachable(input: {
      appId: number;
      baseId: number;
      userId: string;
      fileIds: readonly number[];
      recordId: number | null;
    }): Promise<boolean> {
      const ids = positiveIds(input.fileIds);
      if (ids.length === 0) return true;
      const usable = await db
        .select({ id: driveFiles.id })
        .from(driveFiles)
        .where(
          and(
            inArray(driveFiles.id, ids),
            eq(driveFiles.scope, 'tables'),
            eq(driveFiles.base_id, input.baseId),
            eq(driveFiles.status, 'active'),
            eq(driveFiles.uploaded_by, input.userId),
            sql`${driveFiles.cos_key} LIKE ${`%${appUploadKeySegment(input.baseId, input.appId)}%`}`,
            notExists(
              db
                .select({ id: tableRecordAttachments.id })
                .from(tableRecordAttachments)
                .where(
                  and(
                    eq(tableRecordAttachments.drive_file_id, driveFiles.id),
                    input.recordId === null ? undefined : sql`${tableRecordAttachments.record_id} <> ${input.recordId}`,
                  ),
                ),
            ),
          ),
        );
      return usable.length === ids.length;
    },

    /** Put claimed uploads back to pending when the write that was to attach them failed (attached ones stay). */
    async releaseAppUploads(fileIds: readonly number[]): Promise<void> {
      const ids = positiveIds(fileIds);
      if (ids.length === 0) return;
      await db
        .update(driveFiles)
        .set({ status: 'pending', updated_at: nowIso() })
        .where(
          and(
            inArray(driveFiles.id, ids),
            eq(driveFiles.status, 'active'),
            notExists(
              db
                .select({ id: tableRecordAttachments.id })
                .from(tableRecordAttachments)
                .where(eq(tableRecordAttachments.drive_file_id, driveFiles.id)),
            ),
          ),
        );
    },

    /** Upkeep: expire app uploads nobody attached (pending, under an app segment, created before `before`). */
    async expireStaleAppUploads(before: string, limit = 200): Promise<Array<{ id: number; cos_key: string }>> {
      const stale = db
        .select({ id: driveFiles.id })
        .from(driveFiles)
        .where(
          and(
            eq(driveFiles.scope, 'tables'),
            eq(driveFiles.status, 'pending'),
            lt(driveFiles.created_at, before),
            sql`${driveFiles.cos_key} LIKE '%tables/' || ${driveFiles.base_id} || '/apps/%'`,
          ),
        )
        .limit(limit);
      return db
        .update(driveFiles)
        .set({ status: 'deleted', updated_at: nowIso() })
        .where(and(inArray(driveFiles.id, stale), eq(driveFiles.status, 'pending')))
        .returning({ id: driveFiles.id, cos_key: driveFiles.cos_key });
    },

    // ─── Action ledger ────────────────────────────────────

    /**
     * Claim `requestId` for one person's write in one app. `claimed: false`
     * hands back the existing row: `done` → replay its result; `running` → the
     * same request is in flight (a claim older than two minutes is taken over).
     */
    async claimAppActionRequest(input: {
      appId: number;
      userId: string;
      requestId: string;
      actionId: string;
      pageId: string;
      cardId: string;
      recordId?: number | null;
    }): Promise<ClaimAppActionRequestResult> {
      const now = nowIso();
      const [created] = await db
        .insert(tableAppActionRequests)
        .values({
          app_id: input.appId,
          user_id: input.userId,
          request_id: input.requestId,
          action_id: input.actionId,
          page_id: input.pageId,
          card_id: input.cardId,
          record_id: input.recordId ?? null,
          status: 'running',
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing()
        .returning({ id: tableAppActionRequests.id });
      if (created) return { claimed: true, id: created.id };
      const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
      const [takenOver] = await db
        .update(tableAppActionRequests)
        .set({ updated_at: now })
        .where(
          and(
            eq(tableAppActionRequests.app_id, input.appId),
            eq(tableAppActionRequests.user_id, input.userId),
            eq(tableAppActionRequests.request_id, input.requestId),
            eq(tableAppActionRequests.status, 'running'),
            lt(tableAppActionRequests.updated_at, staleBefore),
          ),
        )
        .returning({ id: tableAppActionRequests.id });
      if (takenOver) return { claimed: true, id: takenOver.id };
      const existing = await service.getAppActionRequest(input.appId, input.userId, input.requestId);
      // Gone between the insert and the read (its run failed and released it): try once more.
      if (!existing) return service.claimAppActionRequest(input);
      return { claimed: false, existing };
    },

    async getAppActionRequest(
      appId: number,
      userId: string,
      requestId: string,
    ): Promise<TableAppActionRequestRow | undefined> {
      const [row] = await db
        .select()
        .from(tableAppActionRequests)
        .where(
          and(
            eq(tableAppActionRequests.app_id, appId),
            eq(tableAppActionRequests.user_id, userId),
            eq(tableAppActionRequests.request_id, requestId),
          ),
        )
        .limit(1);
      return row;
    },

    /** Keep the result of a claimed request (replayed for repeats; counted in usage). */
    async completeAppActionRequest(id: number, input: { recordId: number | null; result: Record<string, unknown> }) {
      await db
        .update(tableAppActionRequests)
        .set({ status: 'done', record_id: input.recordId, result: input.result, updated_at: nowIso() })
        .where(eq(tableAppActionRequests.id, id));
    },

    /** Forget a claim whose write was refused or failed, so the same request may run again. */
    async releaseAppActionRequest(id: number): Promise<void> {
      await db
        .delete(tableAppActionRequests)
        .where(and(eq(tableAppActionRequests.id, id), eq(tableAppActionRequests.status, 'running')));
    },

    // ─── Usage ────────────────────────────────────────────

    /**
     * Who used an app and how: distinct people over 7 / 30 days and the last
     * use, from its audit events (`entity_id = 'app'`, `record_id` = the app,
     * successful `useActionIds` only); runs per action id over 30 days from the
     * ledger.
     */
    async appUsageSummary(
      appId: number,
      input: { orgId: string; appKey: string; useActionIds: readonly string[]; now?: Date },
    ): Promise<AppUsageCounts> {
      const now = input.now ?? new Date();
      const since7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      if (input.useActionIds.length === 0) return { users7d: 0, users30d: 0, lastUsedAt: null, actions30d: {} };
      const person = sql`coalesce(${platformAuditEvents.on_behalf_of_user_id}, ${platformAuditEvents.actor_id})`;
      const used = and(
        eq(platformAuditEvents.org_id, input.orgId),
        eq(platformAuditEvents.app_id, input.appKey),
        eq(platformAuditEvents.entity_id, 'app'),
        eq(platformAuditEvents.record_id, String(appId)),
        eq(platformAuditEvents.result, 'success'),
        inArray(platformAuditEvents.action_id, [...input.useActionIds]),
      );
      const [[people], [last], runs] = await Promise.all([
        db
          .select({
            users7d: sql<number>`count(distinct ${person}) filter (where ${platformAuditEvents.created_at} >= ${since7})::int`,
            users30d: sql<number>`count(distinct ${person})::int`,
          })
          .from(platformAuditEvents)
          .where(and(used, gte(platformAuditEvents.created_at, since30))),
        db
          .select({ at: platformAuditEvents.created_at })
          .from(platformAuditEvents)
          .where(used)
          .orderBy(sql`${platformAuditEvents.created_at} desc`)
          .limit(1),
        db
          .select({ actionId: tableAppActionRequests.action_id, count: sql<number>`count(*)::int` })
          .from(tableAppActionRequests)
          .where(
            and(
              eq(tableAppActionRequests.app_id, appId),
              eq(tableAppActionRequests.status, 'done'),
              gte(tableAppActionRequests.created_at, since30),
            ),
          )
          .groupBy(tableAppActionRequests.action_id),
      ]);
      return {
        users7d: people?.users7d ?? 0,
        users30d: people?.users30d ?? 0,
        lastUsedAt: isoOrNull(last?.at),
        actions30d: Object.fromEntries(runs.map((row) => [row.actionId, row.count])),
      };
    },
  };
  return service;
}

export type TablesAppGateway = ReturnType<typeof createTablesAppGateway>;
