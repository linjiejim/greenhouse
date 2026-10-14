/**
 * 表格 (TBL-01 to TBL-18): bases with data tables, fields, views and records; sharing with
 * members, groups or everyone in four roles; a recycle bin; CSV export; the 「项目」 template;
 * history, comments and audit. Routes (and, later, the Agent tools) call this service, and it
 * checks access on every call (access.ts). Records live in records.ts.
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, max, ne, or, sql } from 'drizzle-orm';
import {
  BASE_ROLES,
  MAX_FIELDS,
  MAX_TABLES,
  MAX_VIEWS,
  isComputedType,
  roleAtLeast,
  type Base,
  type BaseList,
  type BaseAuditEntry,
  type BaseRole,
  type BaseShareInput,
  type BaseShares,
  type BaseSummary,
  type BaseTable,
  type CreateBaseInput,
  type CreateFieldInput,
  type CreateViewInput,
  type Field,
  type Page,
  type RecordFile,
  type RecordValues,
  type TrashItem,
  type UpdateBaseInput,
  type UpdateFieldInput,
  type UpdateTableInput,
  type UpdateViewInput,
  type View,
  type ViewConfig,
} from '@greenhouse/contract';
import {
  apps,
  auditEvents,
  baseFields,
  baseRecordEvents,
  baseRecordFiles,
  baseRecordLinks,
  baseRecords,
  baseRoles,
  baseTables,
  baseViews,
  bases,
  comments,
  getDb,
  groupMembers,
  groups,
  members,
  newId,
  pins,
  shares,
  transaction,
  type BaseFieldRow,
  type BaseRow,
  type BaseTableRow,
} from '@greenhouse/db';
import { enqueueJob } from '../../jobs.js';
import { isUniqueViolation, toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { audit } from '../../audit.js';
import { ApiError, conflict, forbidden, invalidInput } from '../../http/errors.js';
import type { Hub } from '../../realtime/hub.js';
import type { FilesService } from '../files/service.js';
import { inList } from '../knowledge/access.js';
import { memberNames, refOf, shareViews } from '../knowledge/views.js';
import type { NotificationsService } from '../notifications/service.js';
import type { ProvidersService } from '../../providers/service.js';
import {
  accessOn,
  audienceOf,
  baseAt,
  canRead,
  loadReader,
  readableBases,
  type Audience,
  type CustomAccess,
  type TablesReader,
} from './access.js';
import { createCards } from './cards.js';
import { createComputed, type ComputedRow } from './computed.js';
import { checkNoCycle, lockFieldGraph, prepareComputed, saveDeps } from './computed-fields.js';
import { exportCsv } from './export.js';
import { createForms } from './forms.js';
import { createImports } from './imports.js';
import type { TablesKit } from './kit.js';
import { createTablesWorker } from './worker.js';
import {
  canEditView,
  configOf,
  configOfField,
  fieldAt,
  fieldsOf,
  recordAt,
  tableAt,
  toField,
  toTable,
  toView,
  viewAt,
} from './load.js';
import { discardJob, discardLater, filesOfField, purgeJob, purgeRecords, recordIdsOf } from './purge.js';
import { createRecords, type ChangedRecord } from './records.js';
import { createRoles } from './roles.js';
import { inIds } from './query.js';
import { hiddenFields, scopeOf } from './scope.js';
import { projectTemplate, TEMPLATE_VERSIONS, type TemplatePlan } from './templates.js';
import { canChangeType, convertValue, normalizeConfig, normalizeValue, emptyRefs, searchOf } from './values.js';
import { cleanConfig, defaultConfig } from './views.js';

/** Who may see a base, kept for a few seconds so a burst of writes asks once. */
const AUDIENCE_TTL_MS = 5_000;

const WORDS = {
  zh: { base: '未命名表格', table: '数据表', field: '名称', grid: '表格' },
  en: { base: 'Untitled base', table: 'Table', field: 'Name', grid: 'Grid' },
} as const;

const zonedToday = (timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function createTablesService(deps: {
  files: FilesService;
  notifications: NotificationsService;
  hub: Hub;
  providers: ProvidersService;
}) {
  const audiences = new Map<string, { at: number; who: Promise<Audience> }>();
  const worker = createTablesWorker();

  /** Who sees a base now, kept a few seconds; forgotten at once when shares, groups or modules change. */
  function audienceAll(base: Pick<BaseRow, 'id' | 'ownerId'>): Promise<Audience> {
    const cached = audiences.get(base.id);
    if (cached && Date.now() - cached.at < AUDIENCE_TTL_MS) return cached.who;
    const who = audienceOf(base);
    audiences.set(base.id, { at: Date.now(), who });
    who.catch(() => audiences.delete(base.id));
    return who;
  }
  const audience = async (base: Pick<BaseRow, 'id' | 'ownerId'>) => (await audienceAll(base)).ids;

  /** The base's structure, views or shares changed: everyone who sees it refetches (only `to` for a personal view). */
  async function baseChanged(base: Pick<BaseRow, 'id' | 'ownerId'>, to?: string) {
    try {
      deps.hub.publish(to ? [to] : await audience(base), { type: 'base.updated', data: { base_id: base.id } });
    } catch (error) {
      logger.warn('[tables] could not tell about a base change', { base: base.id, error: toErrorMessage(error) });
    }
  }

  const touch = async (baseId: string) => {
    await getDb()
      .update(bases)
      .set({ updatedAt: sql`now()` })
      .where(eq(bases.id, baseId));
  };

  /** Records of a table changed: everyone who sees the base is told which (a custom role only that some did). */
  async function publishChanged(base: Pick<BaseRow, 'id' | 'ownerId'>, tableId: string, rows: ChangedRecord[]) {
    try {
      const who = await audienceAll(base);
      const full = who.ids.filter((id) => !who.limited.has(id));
      deps.hub.publish(full, { type: 'records.changed', data: { base_id: base.id, table_id: tableId, records: rows } });
      // A custom role may not see every record: it learns that the table changed, not which records.
      if (who.limited.size) {
        deps.hub.publish([...who.limited], {
          type: 'records.changed',
          data: { base_id: base.id, table_id: tableId, records: [] },
        });
      }
    } catch (error) {
      logger.warn('[tables] could not tell about changed records', { base: base.id, error: toErrorMessage(error) });
    }
  }

  async function baseOfTable(tableId: string): Promise<Pick<BaseRow, 'id' | 'ownerId'> | null> {
    const [row] = await getDb()
      .select({ id: bases.id, ownerId: bases.ownerId })
      .from(baseTables)
      .innerJoin(bases, eq(bases.id, baseTables.baseId))
      .where(eq(baseTables.id, tableId));
    return row ?? null;
  }

  const computed = createComputed({
    providers: deps.providers,
    kick: () => worker.kick(),
    async changed(tableId: string, rows: ComputedRow[]) {
      const base = await baseOfTable(tableId);
      if (base) await publishChanged(base, tableId, rows.length > 100 ? [] : rows);
    },
  });

  const records = createRecords({
    files: deps.files,
    notifications: deps.notifications,
    computed,
    kick: () => worker.kick(),
    touch,
    changed(base, tableId, rows) {
      void publishChanged(base, tableId, rows);
    },
    async commented(base, recordId, commentId) {
      const who = await audienceAll(base);
      deps.hub.publish(
        who.ids.filter((id) => !who.limited.has(id)),
        { type: 'comments.updated', data: { target_type: 'record', target_id: recordId, comment_id: commentId } },
      );
    },
  });

  const kit: TablesKit = {
    files: deps.files,
    notifications: deps.notifications,
    hub: deps.hub,
    providers: deps.providers,
    records,
    worker,
    audience,
    baseChanged,
    touch,
  };
  const forms = createForms(kit);
  const imports = createImports(kit);
  const cards = createCards(kit);
  const roles = createRoles({
    async changed(base) {
      audiences.delete(base.id);
      await baseChanged(base);
    },
  });

  // ── Background work ──────────────────────────────────

  worker.register('base_recompute', (job) => computed.recomputeJob(job));
  worker.register('base_ai_field', (job) => computed.aiJob(job));
  worker.register('base_discard', (job) => discardJob(deps.files, job.payload));
  worker.register('base_purge', () =>
    purgeJob({
      files: deps.files,
      expiredImports: () => imports.purgeExpired(),
      async touched(baseId, rows) {
        const [base] = await getDb().select().from(bases).where(eq(bases.id, baseId));
        if (base) await records.tellTouched(base, rows);
        await computed.touched(rows.map((row) => row.id));
      },
    }),
  );
  /** Once a day, the first pass of the day queues the purge (one per day for every process). */
  let purgeQueued = '';
  worker.every(async () => {
    const day = new Date().toISOString().slice(0, 10);
    if (day === purgeQueued) return;
    await enqueueJob({ kind: 'base_purge', dedupeKey: `base_purge:${day}`, payload: { day } });
    purgeQueued = day;
  });

  // ── Reading bases ────────────────────────────────────

  async function pinnedOf(memberId: string, baseIds: readonly string[]) {
    if (!baseIds.length) return new Set<string>();
    const rows = await getDb()
      .select({ id: pins.targetId })
      .from(pins)
      .where(and(eq(pins.memberId, memberId), eq(pins.targetType, 'base'), inList(pins.targetId, baseIds)));
    return new Set(rows.map((row) => row.id));
  }

  /** The views a reader sees of these tables: shared ones and their own. */
  async function viewsOf(reader: TablesReader, tableIds: readonly string[]) {
    if (!tableIds.length) return [];
    return getDb()
      .select()
      .from(baseViews)
      .where(
        and(
          inArray(baseViews.tableId, [...tableIds]),
          or(isNull(baseViews.ownerId), eq(baseViews.ownerId, reader.memberId)),
        ),
      )
      .orderBy(asc(baseViews.position), asc(baseViews.id));
  }

  async function liveTables(baseIds: readonly string[]) {
    if (!baseIds.length) return [];
    return getDb()
      .select()
      .from(baseTables)
      .where(and(inArray(baseTables.baseId, [...baseIds]), isNull(baseTables.archivedAt)))
      .orderBy(asc(baseTables.position), asc(baseTables.id));
  }

  /** The dashboards of these bases a reader sees: shared ones and their own. */
  async function dashboardsOf(reader: TablesReader, baseIds: readonly string[]) {
    if (!baseIds.length) return [];
    return getDb()
      .select()
      .from(baseViews)
      .where(
        and(
          inArray(baseViews.baseId, [...baseIds]),
          isNull(baseViews.tableId),
          or(isNull(baseViews.ownerId), eq(baseViews.ownerId, reader.memberId)),
        ),
      )
      .orderBy(asc(baseViews.position), asc(baseViews.id));
  }

  /** The fields of these tables a custom role sees (all of them for the four roles). */
  async function seenFields(custom: CustomAccess | null, tableIds: readonly string[]) {
    const fields = await fieldsOf(tableIds);
    if (!custom) return fields;
    const hidden = new Set<string>();
    for (const id of tableIds) for (const field of await hiddenFields(custom, id)) hidden.add(field);
    return fields.filter((field) => !hidden.has(field.id));
  }

  const customRoleOf = (custom: CustomAccess | null) =>
    custom?.roles.length
      ? { id: custom.roles[0]!.id, name: custom.roles.map((entry) => entry.name).join(' + ') }
      : null;

  async function detail(
    reader: TablesReader,
    base: BaseRow,
    role: BaseRole,
    custom: CustomAccess | null,
  ): Promise<Base> {
    const tables = (await liveTables([base.id])).filter((table) => !custom || custom.tables.has(table.id));
    const ids = tables.map((table) => table.id);
    const [fields, views, dashboards, pinned, owner, ai] = await Promise.all([
      seenFields(custom, ids),
      viewsOf(reader, ids),
      dashboardsOf(reader, [base.id]),
      pinnedOf(reader.memberId, [base.id]),
      memberNames([base.ownerId]),
      deps.providers.available('llm', { memberId: reader.memberId }).catch(() => false),
    ]);
    return {
      id: base.id,
      name: base.name,
      description: base.description,
      icon: base.icon,
      owner_id: base.ownerId,
      owner: refOf(owner, base.ownerId)!,
      access: role,
      pinned: pinned.has(base.id),
      template_key: base.templateKey,
      archived_at: base.archivedAt,
      created_at: base.createdAt,
      updated_at: base.updatedAt,
      tables: tables.map((table) => ({
        ...toTable(table, fields),
        ...(custom ? { access: custom.tables.get(table.id)!.access } : {}),
      })),
      views: [...views, ...dashboards].map((view) => toView(view, reader, role)),
      custom_role: customRoleOf(custom),
      ai_fields: ai,
    };
  }

  // ── Making tables, fields and views (inside a transaction) ──

  async function nextPosition(kind: 'table' | 'field' | 'view', parentId: string) {
    const [row] =
      kind === 'table'
        ? await getDb()
            .select({ top: max(baseTables.position) })
            .from(baseTables)
            .where(eq(baseTables.baseId, parentId))
        : kind === 'field'
          ? await getDb()
              .select({ top: max(baseFields.position) })
              .from(baseFields)
              .where(eq(baseFields.tableId, parentId))
          : await getDb()
              .select({ top: max(baseViews.position) })
              .from(baseViews)
              .where(eq(baseViews.tableId, parentId));
    return (row?.top ?? -1) + 1;
  }

  async function insertTable(reader: TablesReader, base: BaseRow, name: string) {
    const [table] = await getDb()
      .insert(baseTables)
      .values({
        id: newId('baseTable'),
        baseId: base.id,
        name,
        position: await nextPosition('table', base.id),
        createdBy: reader.memberId,
      })
      .returning();
    return table!;
  }

  async function insertField(
    reader: TablesReader,
    table: BaseTableRow,
    input: {
      name: string;
      type: BaseFieldRow['type'];
      config: BaseFieldRow['config'];
      required?: boolean;
      primary?: boolean;
    },
  ) {
    const [field] = await getDb()
      .insert(baseFields)
      .values({
        id: newId('baseField'),
        tableId: table.id,
        name: input.name,
        type: input.type,
        config: input.config,
        required: input.required ?? false,
        isPrimary: input.primary ?? false,
        position: await nextPosition('field', table.id),
        createdBy: reader.memberId,
      })
      .returning();
    return field!;
  }

  async function insertView(
    reader: TablesReader,
    table: BaseTableRow,
    input: { name: string; type: View['type']; config: ViewConfig; personal?: boolean },
  ) {
    const [view] = await getDb()
      .insert(baseViews)
      .values({
        id: newId('baseView'),
        baseId: table.baseId,
        tableId: table.id,
        name: input.name,
        type: input.type,
        ownerId: input.personal ? reader.memberId : null,
        config: input.config,
        position: await nextPosition('view', table.id),
        createdBy: reader.memberId,
      })
      .returning();
    return view!;
  }

  /** A new data table: its primary field and a grid. */
  async function newTable(reader: TablesReader, base: BaseRow, name: string) {
    const words = WORDS[reader.locale];
    const table = await insertTable(reader, base, name);
    await insertField(reader, table, { name: words.field, type: 'text', config: {}, primary: true });
    await insertView(reader, table, { name: words.grid, type: 'grid', config: {} });
    return table;
  }

  /** Makes a template's tables, fields, views and sample rows in a base, inside the caller's transaction. */
  async function applyTemplate(reader: TablesReader, base: BaseRow, plan: TemplatePlan) {
    const tableIds = new Map<string, BaseTableRow>();
    for (const spec of plan.tables) tableIds.set(spec.ref, await insertTable(reader, base, spec.name));
    const fieldIds = new Map<string, Map<string, BaseFieldRow>>();
    for (const spec of plan.tables) {
      const table = tableIds.get(spec.ref)!;
      const made = new Map<string, BaseFieldRow>();
      for (const field of spec.fields) {
        const config = normalizeConfig(field.type, {
          ...field.config,
          ...(field.config?.table_id ? { table_id: tableIds.get(field.config.table_id)!.id } : {}),
        });
        made.set(field.ref, await insertField(reader, table, { ...field, config }));
      }
      fieldIds.set(spec.ref, made);
      for (const view of spec.views) {
        await insertView(reader, table, {
          name: view.name,
          type: view.type,
          config: view.config((ref) => made.get(ref)!.id),
        });
      }
    }
    // Rows first, then the links between them.
    const today = zonedToday(reader.timeZone);
    const rowIds = new Map<string, string>();
    const links: Array<typeof baseRecordLinks.$inferInsert> = [];
    for (const spec of plan.tables) {
      const fields = fieldIds.get(spec.ref)!;
      const ordered = [...fields.values()];
      for (const row of spec.rows) rowIds.set(row.ref, newId('record'));
      for (const row of spec.rows) {
        const values: Record<string, unknown> = {};
        for (const [ref, raw] of Object.entries(row.values)) {
          const field = fields.get(ref)!;
          if (field.type === 'date' && typeof raw === 'number') values[field.id] = addDays(today, raw);
          else if (field.type === 'member')
            values[field.id] = (raw as string[]).map((id) => (id === '$me' ? reader.memberId : id));
          else if (field.type === 'relation' || field.type === 'parent' || field.type === 'dependency') {
            (raw as string[]).forEach((target, position) =>
              links.push({
                fieldId: field.id,
                sourceRecordId: rowIds.get(row.ref)!,
                targetRecordId: rowIds.get(target)!,
                position,
              }),
            );
          } else values[field.id] = normalizeValue(field, raw, emptyRefs());
        }
        const [saved] = await getDb()
          .insert(baseRecords)
          .values({
            id: rowIds.get(row.ref)!,
            tableId: tableIds.get(spec.ref)!.id,
            values,
            ...searchOf(ordered, values),
            createdBy: reader.memberId,
            updatedBy: reader.memberId,
          })
          .returning();
        await getDb()
          .insert(baseRecordEvents)
          .values({
            recordId: saved!.id,
            tableId: saved!.tableId,
            actorType: 'member',
            actorId: reader.memberId,
            type: 'created',
            meta: { template: base.templateKey },
          });
      }
    }
    if (links.length) await getDb().insert(baseRecordLinks).values(links);
  }

  // ── Fields ───────────────────────────────────────────

  async function checkFieldConfig(
    at: { base: BaseRow; table: BaseTableRow },
    type: Field['type'],
    config: BaseFieldRow['config'],
    self?: string,
  ) {
    if (type === 'relation') {
      const [target] = await getDb()
        .select({ id: baseTables.id })
        .from(baseTables)
        .where(
          and(eq(baseTables.id, config.table_id!), eq(baseTables.baseId, at.base.id), isNull(baseTables.archivedAt)),
        );
      if (!target) throw invalidInput('A relation links to a data table of the same base.');
    }
    if (type === 'parent' || type === 'dependency') {
      const [other] = await getDb()
        .select({ id: baseFields.id })
        .from(baseFields)
        .where(
          and(
            eq(baseFields.tableId, at.table.id),
            eq(baseFields.type, type),
            isNull(baseFields.archivedAt),
            self ? ne(baseFields.id, self) : undefined,
          ),
        );
      if (other) throw conflict('one_per_table', 'A data table has one parent field and one dependency field.');
    }
  }

  async function tableNameTaken(baseId: string, name: string, except?: string) {
    const rows = await getDb()
      .select({ id: baseTables.id })
      .from(baseTables)
      .where(
        and(
          eq(baseTables.baseId, baseId),
          eq(baseTables.name, name),
          isNull(baseTables.archivedAt),
          except ? ne(baseTables.id, except) : undefined,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async function fieldNameTaken(tableId: string, name: string, except?: string) {
    const rows = await getDb()
      .select({ id: baseFields.id })
      .from(baseFields)
      .where(
        and(
          eq(baseFields.tableId, tableId),
          eq(baseFields.name, name),
          isNull(baseFields.archivedAt),
          except ? ne(baseFields.id, except) : undefined,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Every view of a table drops what a change to its fields left behind. */
  async function cleanViews(tableId: string) {
    const fields = await fieldsOf(tableId);
    const views = await getDb().select().from(baseViews).where(eq(baseViews.tableId, tableId));
    for (const view of views) {
      const config = cleanConfig(view.type, configOf(view), fields, 'lenient');
      if (JSON.stringify(config) === JSON.stringify(configOf(view))) continue;
      await getDb()
        .update(baseViews)
        .set({ config, revision: sql`${baseViews.revision} + 1`, updatedAt: sql`now()` })
        .where(eq(baseViews.id, view.id));
    }
  }

  async function schemaChanged(base: BaseRow, tableId: string) {
    await getDb()
      .update(baseTables)
      .set({ schemaRevision: sql`${baseTables.schemaRevision} + 1`, updatedAt: sql`now()` })
      .where(eq(baseTables.id, tableId));
    await touch(base.id);
  }

  /**
   * A field's type changes: its values carry over (values.ts), each checked against the new type.
   * Values that would not fit refuse the change rather than being lost.
   */
  async function convertValues(field: BaseFieldRow, type: BaseFieldRow['type'], config: BaseFieldRow['config']) {
    const rows = await getDb()
      .select({ id: baseRecords.id, values: baseRecords.values })
      .from(baseRecords)
      .where(and(eq(baseRecords.tableId, field.tableId), sql`${baseRecords.values} ? ${field.id}`));
    const target = { ...field, type, config };
    const changed: Array<{ id: string; values: RecordValues }> = [];
    const refused: string[] = [];
    for (const row of rows) {
      const before = row.values[field.id];
      let after: unknown;
      try {
        after = normalizeValue(target, convertValue(field.type, type, before), emptyRefs());
      } catch {
        refused.push(row.id);
        continue;
      }
      if (JSON.stringify(after) !== JSON.stringify(before))
        changed.push({ id: row.id, values: { ...row.values, [field.id]: after } });
    }
    if (refused.length) {
      throw new ApiError(
        409,
        'type_change_values',
        `${refused.length} records hold values that are not valid for the new type. Change or clear them first.`,
        { count: refused.length, record_ids: refused.slice(0, 20) },
      );
    }
    for (const row of changed) {
      await getDb().update(baseRecords).set({ values: row.values }).where(eq(baseRecords.id, row.id));
    }
  }

  /** A write that may clash with another name (two at once): answered 409 `name_taken`. */
  async function uniqueName<T>(work: () => Promise<T>, message: string): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ApiError) && isUniqueViolation(error)) throw conflict('name_taken', message);
      throw error;
    }
  }

  const auditBase = (reader: TablesReader, base: BaseRow, action: string, summary = '') =>
    audit({
      actorId: reader.memberId,
      action,
      resourceType: 'base',
      resourceId: base.id,
      scopeType: 'base',
      scopeId: base.id,
      summary,
    });

  const service = {
    records,
    forms,
    imports,
    cards,
    /** The background work: started by the process (index.ts), drained by tests. */
    worker,

    // ── Bases ──────────────────────────────────────────

    /**
     * A page of my bases and those shared with me (or the archived ones I own), by name, with
     * their tables and my views.
     */
    async list(
      memberId: string,
      query: { archived: boolean; cursor?: string | undefined; limit?: number },
    ): Promise<BaseList> {
      const reader = await loadReader(memberId);
      const limit = query.limit ?? 200;
      const after = query.cursor ? decodeBases(query.cursor) : null;
      const rows = await getDb()
        .select()
        .from(bases)
        .where(
          and(
            readableBases(reader),
            query.archived ? isNotNull(bases.archivedAt) : isNull(bases.archivedAt),
            after ? sql`(${bases.name}, ${bases.id}) > (${after.name}, ${after.id})` : undefined,
          ),
        )
        .orderBy(asc(bases.name), asc(bases.id))
        .limit(limit + 1);
      const more = rows.length > limit;
      const pageRows = more ? rows.slice(0, limit) : rows;
      const access = await accessOn(reader, pageRows);
      const visible = pageRows.filter(
        (row) => access.has(row.id) && (!query.archived || access.get(row.id)!.role === 'owner'),
      );
      const ids = visible.map((row) => row.id);
      const tables = (await liveTables(ids)).filter((table) => {
        const custom = access.get(table.baseId)?.custom;
        return !custom || custom.tables.has(table.id);
      });
      const [views, dashboards, pinned] = await Promise.all([
        viewsOf(
          reader,
          tables.map((table) => table.id),
        ),
        dashboardsOf(reader, ids),
        pinnedOf(memberId, ids),
      ]);
      const items = visible
        .map(
          (row): BaseSummary => ({
            id: row.id,
            name: row.name,
            description: row.description,
            icon: row.icon,
            owner_id: row.ownerId,
            access: access.get(row.id)!.role,
            pinned: pinned.has(row.id),
            template_key: row.templateKey,
            archived_at: row.archivedAt,
            updated_at: row.updatedAt,
            tables: tables
              .filter((table) => table.baseId === row.id)
              .map((table) => ({
                id: table.id,
                name: table.name,
                views: views
                  .filter((view) => view.tableId === table.id)
                  .map((view) => ({ id: view.id, name: view.name, type: view.type, personal: !!view.ownerId })),
              })),
            dashboards: dashboards
              .filter((view) => view.baseId === row.id)
              .map((view) => ({ id: view.id, name: view.name, personal: !!view.ownerId })),
            custom_role: customRoleOf(access.get(row.id)!.custom),
          }),
        )
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) || a.id.localeCompare(b.id));
      const last = pageRows[pageRows.length - 1];
      return {
        items,
        next_cursor:
          more && last ? Buffer.from(JSON.stringify({ n: last.name, i: last.id })).toString('base64url') : null,
      };
    },

    async get(memberId: string, baseId: string): Promise<Base> {
      const reader = await loadReader(memberId);
      const { base, role, custom } = await baseAt(reader, baseId, 'viewer', { archived: true });
      return detail(reader, base, role, custom);
    },

    /** Blank (one data table with a grid) or from a template. The member owns it. */
    async create(memberId: string, input: CreateBaseInput): Promise<Base> {
      const reader = await loadReader(memberId);
      const plan = input.template === 'project' ? projectTemplate(reader.locale) : null;
      const words = WORDS[reader.locale];
      const base = await transaction(async () => {
        const [row] = await getDb()
          .insert(bases)
          .values({
            id: newId('base'),
            name: input.name ?? plan?.name ?? words.base,
            description: input.description ?? '',
            ownerId: memberId,
            templateKey: input.template ?? null,
            templateVersion: input.template ? TEMPLATE_VERSIONS[input.template] : null,
            createdBy: memberId,
          })
          .returning();
        if (plan) await applyTemplate(reader, row!, plan);
        else await newTable(reader, row!, `${words.table} 1`);
        if (input.template) await auditBase(reader, row!, 'base.create', `template ${input.template}`);
        return row!;
      });
      return detail(reader, base, 'owner', null);
    },

    async update(memberId: string, baseId: string, input: UpdateBaseInput): Promise<Base> {
      const reader = await loadReader(memberId);
      const changesBase = input.name !== undefined || input.description !== undefined || input.icon !== undefined;
      const { base, role, custom } = await baseAt(reader, baseId, changesBase ? 'builder' : 'viewer');
      if (input.pinned !== undefined) {
        if (input.pinned) {
          await getDb().insert(pins).values({ memberId, targetType: 'base', targetId: baseId }).onConflictDoNothing();
        } else {
          await getDb()
            .delete(pins)
            .where(and(eq(pins.memberId, memberId), eq(pins.targetType, 'base'), eq(pins.targetId, baseId)));
        }
      }
      let row = base;
      if (changesBase) {
        [row] = (await getDb()
          .update(bases)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.icon !== undefined ? { icon: input.icon } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(bases.id, baseId))
          .returning()) as [BaseRow];
        await baseChanged(row);
      }
      return detail(reader, row, role, custom);
    },

    async archive(memberId: string, baseId: string): Promise<Base> {
      const reader = await loadReader(memberId);
      const { base } = await baseAt(reader, baseId, 'owner');
      const row = await transaction(async () => {
        const [archived] = await getDb()
          .update(bases)
          .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(bases.id, baseId))
          .returning();
        await auditBase(reader, base, 'base.archive');
        return archived!;
      });
      await baseChanged(row);
      return detail(reader, row, 'owner', null);
    },

    async restore(memberId: string, baseId: string): Promise<Base> {
      const reader = await loadReader(memberId);
      const { base } = await baseAt(reader, baseId, 'owner', { archived: true });
      if (!base.archivedAt) return detail(reader, base, 'owner', null);
      const row = await transaction(async () => {
        const [restored] = await getDb()
          .update(bases)
          .set({ archivedAt: null, updatedAt: sql`now()` })
          .where(eq(bases.id, baseId))
          .returning();
        await auditBase(reader, base, 'base.restore');
        return restored!;
      });
      await baseChanged(row);
      return detail(reader, row, 'owner', null);
    },

    /** For good, with everything in it: the name typed again must match. */
    async remove(memberId: string, baseId: string, typed: string): Promise<void> {
      const reader = await loadReader(memberId);
      const { base } = await baseAt(reader, baseId, 'owner', { archived: true });
      if (typed.trim() !== base.name.trim())
        throw invalidInput('Type the name of the base to delete it.', { field: 'name' });
      const people = await audience(base);
      const held = await getDb()
        .select({ id: baseRecordFiles.fileId })
        .from(baseRecordFiles)
        .innerJoin(baseRecords, eq(baseRecords.id, baseRecordFiles.recordId))
        .innerJoin(baseTables, eq(baseTables.id, baseRecords.tableId))
        .where(eq(baseTables.baseId, baseId));
      await transaction(async () => {
        await forms.dropShares({ baseId });
        // Publication and app actions lock the app first; deletion takes those locks before its grants.
        const linkedApps = await getDb()
          .select({ id: apps.id })
          .from(apps)
          .where(eq(apps.baseId, baseId))
          .orderBy(asc(apps.id))
          .for('update');
        const appIds = linkedApps.map((app) => app.id);
        if (appIds.length) {
          await getDb()
            .delete(shares)
            .where(and(eq(shares.resourceType, 'app'), inArray(shares.resourceId, appIds)));
          await getDb()
            .delete(pins)
            .where(and(eq(pins.targetType, 'app'), inArray(pins.targetId, appIds)));
        }
        await getDb().delete(bases).where(eq(bases.id, baseId));
        await getDb()
          .delete(shares)
          .where(and(eq(shares.resourceType, 'base'), eq(shares.resourceId, baseId)));
        await getDb()
          .delete(pins)
          .where(and(eq(pins.targetType, 'base'), eq(pins.targetId, baseId)));
        await getDb().delete(comments).where(eq(comments.baseId, baseId));
        await auditBase(reader, base, 'base.delete', `${held.length} files`);
        // The bytes go once this has committed.
        await discardLater(held.map((file) => file.id));
      });
      worker.kick();
      audiences.delete(baseId);
      deps.hub.publish(people, { type: 'base.updated', data: { base_id: baseId } });
    },

    // ── Sharing ────────────────────────────────────────

    async shares(memberId: string, baseId: string): Promise<BaseShares> {
      const reader = await loadReader(memberId);
      const { base } = await baseAt(reader, baseId, 'viewer');
      const rows = await getDb()
        .select()
        .from(shares)
        .where(and(eq(shares.resourceType, 'base'), eq(shares.resourceId, baseId)))
        .orderBy(asc(shares.createdAt), asc(shares.id));
      const [views, owner] = await Promise.all([shareViews(rows), memberNames([base.ownerId])]);
      return {
        owner: refOf(owner, base.ownerId)!,
        items: views.map((view, index) => {
          const row = rows[index]!;
          const custom = row.role === 'custom' && row.customRoleId ? row.customRoleId : null;
          return {
            ...view,
            role: custom
              ? 'custom'
              : (BASE_ROLES as readonly string[]).includes(row.role)
                ? (row.role as BaseRole)
                : 'viewer',
            custom_role_id: custom,
          };
        }),
      };
    },

    /** Replaces the shares. Only owners share; the owner is never a share. New people are told. */
    async share(memberId: string, baseId: string, input: BaseShareInput): Promise<BaseShares> {
      const reader = await loadReader(memberId);
      const { base } = await baseAt(reader, baseId, 'owner');
      type Wanted = {
        type: 'member' | 'group' | 'workspace';
        id: string | null;
        role: BaseRole | 'custom';
        customRoleId: string | null;
      };
      const wanted = new Map<string, Wanted>();
      for (const entry of input.items) {
        if (entry.type === 'member' && entry.id === base.ownerId) continue;
        wanted.set(`${entry.type}:${entry.id ?? ''}`, {
          type: entry.type,
          id: entry.id ?? null,
          role: entry.role,
          customRoleId: entry.custom_role_id ?? null,
        });
      }
      const customIds = [
        ...new Set([...wanted.values()].flatMap((entry) => (entry.customRoleId ? [entry.customRoleId] : []))),
      ];
      if (customIds.length) {
        const known = await getDb()
          .select({ id: baseRoles.id })
          .from(baseRoles)
          .where(and(eq(baseRoles.baseId, baseId), inList(baseRoles.id, customIds)));
        if (known.length !== customIds.length) throw invalidInput('Some custom roles are not roles of this base.');
      }
      const memberIds = [...wanted.values()].filter((entry) => entry.type === 'member').map((entry) => entry.id!);
      const groupIds = [...wanted.values()].filter((entry) => entry.type === 'group').map((entry) => entry.id!);
      const [people, teams] = await Promise.all([
        getDb()
          .select({ id: members.id })
          .from(members)
          .where(and(inList(members.id, memberIds), ne(members.status, 'disabled'))),
        getDb().select({ id: groups.id }).from(groups).where(inList(groups.id, groupIds)),
      ]);
      if (people.length !== memberIds.length || teams.length !== groupIds.length) {
        throw invalidInput('Some members or groups do not exist.');
      }
      const added = await transaction(async () => {
        const existing = await getDb()
          .select()
          .from(shares)
          .where(and(eq(shares.resourceType, 'base'), eq(shares.resourceId, baseId)));
        const keyOf = (row: { principalType: string; principalId: string | null }) =>
          `${row.principalType}:${row.principalId ?? ''}`;
        const gone = existing.filter((row) => !wanted.has(keyOf(row)));
        if (gone.length)
          await getDb()
            .delete(shares)
            .where(
              inArray(
                shares.id,
                gone.map((row) => row.id),
              ),
            );
        const fresh: Array<{ id: string; type: string; principal: string | null; role: BaseRole | 'custom' }> = [];
        let changed = gone.length;
        for (const [key, entry] of wanted) {
          const before = existing.find((row) => keyOf(row) === key);
          if (before) {
            if (before.role !== entry.role || (before.customRoleId ?? null) !== entry.customRoleId) {
              changed++;
              await getDb()
                .update(shares)
                .set({ role: entry.role, customRoleId: entry.customRoleId })
                .where(eq(shares.id, before.id));
            }
            continue;
          }
          const id = newId('share');
          await getDb().insert(shares).values({
            id,
            resourceType: 'base',
            resourceId: baseId,
            principalType: entry.type,
            principalId: entry.id,
            role: entry.role,
            customRoleId: entry.customRoleId,
            createdBy: memberId,
          });
          changed++;
          fresh.push({ id, type: entry.type, principal: entry.id, role: entry.role });
        }
        if (changed) {
          const count = (type: string) => [...wanted.values()].filter((entry) => entry.type === type).length;
          await auditBase(
            reader,
            base,
            'base.share',
            `members ${count('member')}, groups ${count('group')}, workspace ${count('workspace')}`,
          );
        }
        return fresh;
      });
      const before = await audience(base);
      audiences.delete(baseId);
      const after = await audience(base);
      deps.hub.publish([...new Set([...before, ...after])], { type: 'base.updated', data: { base_id: baseId } });
      await tellShared(reader, base, added);
      return service.shares(memberId, baseId);
    },

    // ── Data tables ────────────────────────────────────

    async createTable(memberId: string, baseId: string, name: string): Promise<BaseTable> {
      const reader = await loadReader(memberId);
      const { base } = await baseAt(reader, baseId, 'builder');
      if (await tableNameTaken(baseId, name)) {
        throw conflict('name_taken', 'This base already has a data table with that name.');
      }
      const [{ n } = { n: 0 }] = await getDb()
        .select({ n: sql<number>`count(*)::int` })
        .from(baseTables)
        .where(and(eq(baseTables.baseId, baseId), isNull(baseTables.archivedAt)));
      if (n >= MAX_TABLES) throw conflict('too_many_tables', `A base holds up to ${MAX_TABLES} data tables.`);
      const table = await transaction(async () => {
        const made = await newTable(reader, base, name);
        await touch(base.id);
        return made;
      });
      await baseChanged(base);
      return toTable(table, await fieldsOf(table.id));
    },

    async updateTable(memberId: string, tableId: string, input: UpdateTableInput): Promise<BaseTable> {
      const reader = await loadReader(memberId);
      const { base, table } = await tableAt(reader, tableId, 'builder');
      if (input.name && (await tableNameTaken(base.id, input.name, tableId))) {
        throw conflict('name_taken', 'This base already has a data table with that name.');
      }
      const [row] = await uniqueName(
        () =>
          getDb()
            .update(baseTables)
            .set({
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
              ...(input.position !== undefined ? { position: input.position } : {}),
              updatedAt: sql`now()`,
            })
            .where(eq(baseTables.id, table.id))
            .returning(),
        'This base already has a data table with that name.',
      );
      await touch(base.id);
      await baseChanged(base);
      return toTable(row!, await fieldsOf(table.id));
    },

    /** To the recycle bin with its records, fields and views; restore brings it all back. */
    async archiveTable(memberId: string, tableId: string): Promise<void> {
      const reader = await loadReader(memberId);
      const { base, table } = await tableAt(reader, tableId, 'builder');
      await transaction(async () => {
        await getDb()
          .update(baseTables)
          .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(baseTables.id, table.id));
        await touch(base.id);
        // Lookups and rollups elsewhere read its records no more.
        await computed.tableChanged(table.id);
      });
      worker.kick();
      await baseChanged(base);
    },

    async restoreTable(memberId: string, tableId: string): Promise<BaseTable> {
      const reader = await loadReader(memberId);
      const { base, table } = await tableAt(reader, tableId, 'builder', { archived: true });
      if (!table.archivedAt) return toTable(table, await fieldsOf(table.id));
      if (await tableNameTaken(base.id, table.name, table.id)) {
        throw conflict('name_taken', 'Another data table has its name now. Rename that one first.');
      }
      const row = await uniqueName(
        () =>
          transaction(async () => {
            // Under the base's row lock, so two restores cannot pass the cap together.
            await getDb().select({ id: bases.id }).from(bases).where(eq(bases.id, base.id)).for('update');
            const [{ n } = { n: 0 }] = await getDb()
              .select({ n: sql<number>`count(*)::int` })
              .from(baseTables)
              .where(and(eq(baseTables.baseId, base.id), isNull(baseTables.archivedAt)));
            if (n >= MAX_TABLES) throw conflict('too_many_tables', `A base holds up to ${MAX_TABLES} data tables.`);
            const [restored] = await getDb()
              .update(baseTables)
              .set({ archivedAt: null, updatedAt: sql`now()` })
              .where(eq(baseTables.id, table.id))
              .returning();
            await touch(base.id);
            await computed.tableChanged(table.id);
            return restored!;
          }),
        'Another data table has its name now. Rename that one first.',
      );
      worker.kick();
      await baseChanged(base);
      return toTable(row, await fieldsOf(table.id));
    },

    /** Deletes a data table in the recycle bin for good, with its records and their files. */
    async purgeTable(memberId: string, tableId: string): Promise<void> {
      const reader = await loadReader(memberId);
      const { base, table } = await tableAt(reader, tableId, 'builder', { archived: true });
      if (!table.archivedAt) throw conflict('not_archived', 'Delete the data table to the recycle bin first.');
      const recordIds = await recordIdsOf(tableId);
      const purged = await transaction(async () => {
        const gone = await purgeRecords(recordIds, { memberId, baseId: base.id }, { anyState: true, audit: false });
        await forms.dropShares({ tableId });
        await getDb().delete(baseTables).where(eq(baseTables.id, tableId));
        await audit({
          actorId: memberId,
          action: 'base_table.purge',
          resourceType: 'base_table',
          resourceId: tableId,
          scopeType: 'base',
          scopeId: base.id,
          summary: `${gone.count} records`,
        });
        await computed.touched(gone.touched.map((row) => row.id));
        return gone;
      });
      await records.tellTouched(base, purged.touched);
      worker.kick();
      await baseChanged(base);
    },

    // ── Fields ─────────────────────────────────────────

    async createField(memberId: string, tableId: string, input: CreateFieldInput): Promise<Field> {
      const reader = await loadReader(memberId);
      const at = await tableAt(reader, tableId, 'builder');
      const computes = isComputedType(input.type);
      if (input.type === 'ai' && !(await deps.providers.available('llm', { memberId }).catch(() => false))) {
        throw conflict('ai_unavailable', 'AI fields need a model service. An admin can set one up.');
      }
      const prepared = computes
        ? await prepareComputed({ id: tableId, baseId: at.base.id }, input.type, input.config ?? {})
        : null;
      const config = prepared ? prepared.config : normalizeConfig(input.type, input.config);
      if (!computes) await checkFieldConfig(at, input.type, config);
      if (await fieldNameTaken(tableId, input.name)) {
        throw conflict('name_taken', 'This data table already has a field with that name.');
      }
      const live = await fieldsOf(tableId);
      if (live.length >= MAX_FIELDS)
        throw conflict('too_many_fields', `A data table holds up to ${MAX_FIELDS} fields.`);
      try {
        const field = await transaction(async () => {
          const made = await insertField(reader, at.table, {
            name: input.name,
            type: input.type,
            config,
            // A computed value is never empty for want of someone filling it in.
            required: computes ? false : (input.required ?? false),
          });
          if (prepared) {
            await lockFieldGraph(at.base.id);
            await checkNoCycle(at.base.id, made.id, prepared.deps);
            await saveDeps(made.id, prepared.deps);
            await computed.fieldsChanged([made.id]);
          }
          await schemaChanged(at.base, tableId);
          return made;
        });
        worker.kick();
        await baseChanged(at.base);
        return toField(field, await fieldsOf(tableId));
      } catch (error) {
        if (isUniqueViolation(error))
          throw conflict('name_taken', 'This data table already has a field with that name.');
        throw error;
      }
    },

    /** Rename, settings, required, place; the type changes only where values carry over (values.ts). */
    async updateField(memberId: string, fieldId: string, input: UpdateFieldInput): Promise<Field> {
      const reader = await loadReader(memberId);
      const at = await fieldAt(reader, fieldId, 'builder');
      const { field } = at;
      const type = input.type ?? field.type;
      if (type !== field.type) {
        if (field.isPrimary) throw conflict('primary_field', 'The primary field stays text.');
        if (!canChangeType(field.type, type)) {
          throw conflict('type_change_unsupported', 'This field cannot change to that type. Add a new field instead.');
        }
      }
      if (input.name && (await fieldNameTaken(field.tableId, input.name, fieldId))) {
        throw conflict('name_taken', 'This data table already has a field with that name.');
      }
      let config = field.config;
      const prepared =
        isComputedType(type) && input.config
          ? await prepareComputed({ id: field.tableId, baseId: at.base.id }, type, input.config, field)
          : null;
      if (prepared) config = prepared.config;
      else if (input.config || type !== field.type) {
        config = normalizeConfig(type, { ...configOfField(field), ...input.config });
        if (field.type === 'relation' && config.table_id !== field.config.table_id) {
          throw conflict('relation_target_fixed', 'A relation keeps the data table it links to.');
        }
        await checkFieldConfig(at, type, config, fieldId);
      }
      const values = input.config !== undefined || type !== field.type;
      const updated = await transaction(async () => {
        // Field changes go one at a time per table, each based on the schema it was made against;
        // record writes hold the same row shared, so none lands halfway through a type change.
        const [table] = await getDb()
          .select({ revision: baseTables.schemaRevision })
          .from(baseTables)
          .where(eq(baseTables.id, field.tableId))
          .for('update');
        if (table?.revision !== input.schema_revision) {
          throw new ApiError(409, 'stale_schema', 'Someone changed the fields of this data table. Reload it first.', {
            schema_revision: table?.revision ?? null,
          });
        }
        if (type !== field.type) await convertValues(field, type, config);
        const [row] = await getDb()
          .update(baseFields)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.required !== undefined ? { required: input.required } : {}),
            ...(input.position !== undefined ? { position: input.position } : {}),
            type,
            config,
            updatedAt: sql`now()`,
          })
          .where(eq(baseFields.id, fieldId))
          .returning();
        if (prepared) {
          await lockFieldGraph(at.base.id);
          await checkNoCycle(at.base.id, fieldId, prepared.deps);
          await saveDeps(fieldId, prepared.deps);
        }
        // What it holds or reads changed: it, and what reads it, are worked out again.
        if (values) await computed.fieldsChanged([fieldId]);
        await schemaChanged(at.base, field.tableId);
        await cleanViews(field.tableId);
        return row!;
      }).catch((error: unknown) => {
        if (!(error instanceof ApiError) && isUniqueViolation(error)) {
          throw conflict('name_taken', 'This data table already has a field with that name.');
        }
        throw error;
      });
      worker.kick();
      await baseChanged(at.base);
      return toField(updated, await fieldsOf(field.tableId));
    },

    /** To the recycle bin: gone from every view; its values wait in the records until it is deleted for good. */
    async archiveField(memberId: string, fieldId: string): Promise<void> {
      const reader = await loadReader(memberId);
      const at = await fieldAt(reader, fieldId, 'builder');
      if (at.field.isPrimary) throw conflict('primary_field', 'The primary field cannot be deleted.');
      await transaction(async () => {
        await getDb()
          .update(baseFields)
          .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(baseFields.id, fieldId));
        await schemaChanged(at.base, at.field.tableId);
        await cleanViews(at.field.tableId);
        // What reads it shows that it is gone.
        await computed.fieldsChanged([fieldId]);
      });
      worker.kick();
      await baseChanged(at.base);
    },

    async restoreField(memberId: string, fieldId: string): Promise<Field> {
      const reader = await loadReader(memberId);
      const at = await fieldAt(reader, fieldId, 'builder', { archived: true });
      const { field } = at;
      if (!field.archivedAt) return toField(field);
      if (await fieldNameTaken(field.tableId, field.name, fieldId)) {
        throw conflict('name_taken', 'Another field has its name now. Rename that one first.');
      }
      if (!isComputedType(field.type)) await checkFieldConfig(at, field.type, field.config, fieldId);
      const row = await uniqueName(
        () =>
          transaction(async () => {
            // Under the table's row lock, so two restores cannot pass the cap together.
            await getDb()
              .select({ id: baseTables.id })
              .from(baseTables)
              .where(eq(baseTables.id, field.tableId))
              .for('update');
            if ((await fieldsOf(field.tableId)).length >= MAX_FIELDS) {
              throw conflict('too_many_fields', `A data table holds up to ${MAX_FIELDS} fields.`);
            }
            const [restored] = await getDb()
              .update(baseFields)
              .set({ archivedAt: null, updatedAt: sql`now()` })
              .where(eq(baseFields.id, fieldId))
              .returning();
            await schemaChanged(at.base, field.tableId);
            await computed.fieldsChanged([fieldId]);
            return restored!;
          }),
        'Another field has its name now. Rename that one first.',
      );
      worker.kick();
      await baseChanged(at.base);
      return toField(row, await fieldsOf(field.tableId));
    },

    /** Deletes a field in the recycle bin for good: its values leave every record. */
    async purgeField(memberId: string, fieldId: string): Promise<void> {
      const reader = await loadReader(memberId);
      const at = await fieldAt(reader, fieldId, 'builder', { archived: true });
      if (!at.field.archivedAt) throw conflict('not_archived', 'Delete the field to the recycle bin first.');
      const held = await filesOfField(fieldId);
      await transaction(async () => {
        await getDb()
          .update(baseRecords)
          .set({
            values: sql`${baseRecords.values} - ${fieldId}::text`,
            computed: sql`${baseRecords.computed} - ${fieldId}::text`,
          })
          .where(
            and(
              eq(baseRecords.tableId, at.field.tableId),
              sql`(${baseRecords.values} ? ${fieldId} OR ${baseRecords.computed} ? ${fieldId})`,
            ),
          );
        await getDb().delete(baseFields).where(eq(baseFields.id, fieldId));
        await audit({
          actorId: memberId,
          action: 'base_field.purge',
          resourceType: 'base_field',
          resourceId: fieldId,
          scopeType: 'base',
          scopeId: at.base.id,
        });
        // The bytes go once this has committed.
        await discardLater(held);
      });
      worker.kick();
      await baseChanged(at.base);
    },

    /** AI field values written again for these records, now (editors; the model is metered to them). */
    async generate(memberId: string, fieldId: string, recordIds: readonly string[]) {
      const reader = await loadReader(memberId);
      const at = await fieldAt(reader, fieldId, 'editor');
      if (at.field.type !== 'ai') throw invalidInput('Only AI fields are written by the model.');
      if (!(await deps.providers.available('llm', { memberId }).catch(() => false))) {
        throw conflict('ai_unavailable', 'AI fields need a model service. An admin can set one up.');
      }
      const scope = await scopeOf(reader, at);
      const visible = scope.rows
        ? (
            await getDb()
              .select({ id: baseRecords.id })
              .from(baseRecords)
              .where(and(inIds(baseRecords.id, recordIds), scope.rows))
          ).map((row) => row.id)
        : [...recordIds];
      const rows = await computed.generate(at.table.id, fieldId, visible);
      worker.kick();
      if (rows.length) await publishChanged(at.base, at.table.id, rows);
      return { items: rows };
    },

    // ── Views ──────────────────────────────────────────

    /** A personal view (anyone who sees the base) or a shared one (builders). */
    async createView(memberId: string, tableId: string, input: CreateViewInput): Promise<View> {
      const reader = await loadReader(memberId);
      const at = await tableAt(reader, tableId, 'viewer');
      const personal = input.personal ?? false;
      if (!personal && !roleAtLeast(at.role, 'builder')) {
        throw forbidden('Only builders add shared views. Make it a personal view instead.');
      }
      const fields = await fieldsOf(tableId);
      const config = input.config ? cleanConfig(input.type, input.config, fields) : defaultConfig(input.type, fields);
      if (!config) {
        throw new ApiError(409, 'view_needs_field', 'This view needs a field of the right type first.', {
          type: input.type,
        });
      }
      if ((await viewsOf(reader, [tableId])).length >= MAX_VIEWS) {
        throw conflict('too_many_views', `A data table holds up to ${MAX_VIEWS} views.`);
      }
      const view = await insertView(reader, at.table, { name: input.name, type: input.type, config, personal });
      await baseChanged(at.base, personal ? memberId : undefined);
      return toView(view, reader, at.role);
    },

    /** A change based on `revision`; a newer view answers 409 `stale_revision`. */
    async updateView(memberId: string, viewId: string, input: UpdateViewInput): Promise<View> {
      const reader = await loadReader(memberId);
      const at = await viewAt(reader, viewId);
      const { view } = at;
      if (!canEditView(reader, at.role, view)) {
        throw forbidden('Only builders change shared views. Save it as a personal view instead.');
      }
      const config = input.config
        ? view.tableId
          ? cleanConfig(view.type, input.config, await fieldsOf(view.tableId))
          : await cards.cleanDashboard(at.base.id, input.config)
        : undefined;
      const [row] = await getDb()
        .update(baseViews)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(config !== undefined ? { config } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
          revision: sql`${baseViews.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(baseViews.id, viewId), eq(baseViews.revision, input.revision)))
        .returning();
      if (!row) {
        const [now] = await getDb().select().from(baseViews).where(eq(baseViews.id, viewId));
        throw new ApiError(409, 'stale_revision', 'Someone changed this view. Reload it first.', {
          view: now ? toView(now, reader, at.role) : null,
        });
      }
      await baseChanged(at.base, view.ownerId ? memberId : undefined);
      return toView(row, reader, at.role);
    },

    async removeView(memberId: string, viewId: string): Promise<void> {
      const reader = await loadReader(memberId);
      const at = await viewAt(reader, viewId);
      const { view } = at;
      if (!canEditView(reader, at.role, view)) throw forbidden('Only builders delete shared views.');
      const tableId = view.tableId;
      await transaction(async () => {
        if (tableId && !view.ownerId) {
          // Under the table's row lock, so two deletes cannot both leave it without a shared view.
          await getDb().select({ id: baseTables.id }).from(baseTables).where(eq(baseTables.id, tableId)).for('update');
          const [{ n } = { n: 0 }] = await getDb()
            .select({ n: sql<number>`count(*)::int` })
            .from(baseViews)
            .where(and(eq(baseViews.tableId, tableId), isNull(baseViews.ownerId)));
          if (n <= 1) throw conflict('last_view', 'A data table keeps at least one shared view.');
        }
        await getDb().delete(baseViews).where(eq(baseViews.id, viewId));
      });
      await baseChanged(at.base, view.ownerId ? memberId : undefined);
    },

    // ── Recycle bin, audit, files, export ──────────────

    /**
     * Deleted records, deleted fields and data tables, newest first. Records past TRASH_DAYS are
     * deleted for good first. Records and fields of a deleted table come back with it.
     */
    async trash(
      memberId: string,
      baseId: string,
      query: { cursor?: string | undefined; limit: number },
    ): Promise<Page<TrashItem>> {
      const reader = await loadReader(memberId);
      // The recycle bin spans every table: not for a custom role.
      await baseAt(reader, baseId, 'editor', { standard: true });
      const after = query.cursor ? decodeTrash(query.cursor) : null;
      const rows = await getDb().execute<{
        kind: TrashItem['kind'];
        id: string;
        name: string;
        table_id: string;
        table_name: string;
        deleted_at: string;
        exact: string;
        deleted_by: string | null;
      }>(sql`
        SELECT bin.*, bin.deleted_at::text AS exact FROM (
          SELECT 'record' AS kind, r.id, coalesce(r.values ->> f.id, '') AS name, r.table_id, t.name AS table_name,
                 r.deleted_at, r.deleted_by
            FROM base_records r JOIN base_tables t ON t.id = r.table_id
            LEFT JOIN base_fields f ON f.table_id = r.table_id AND f.is_primary
           WHERE t.base_id = ${baseId} AND r.deleted_at IS NOT NULL AND t.archived_at IS NULL
          UNION ALL
          SELECT 'field', f.id, f.name, f.table_id, t.name, f.archived_at, NULL
            FROM base_fields f JOIN base_tables t ON t.id = f.table_id
           WHERE t.base_id = ${baseId} AND f.archived_at IS NOT NULL AND t.archived_at IS NULL
          UNION ALL
          SELECT 'table', t.id, t.name, t.id, t.name, t.archived_at, NULL
            FROM base_tables t WHERE t.base_id = ${baseId} AND t.archived_at IS NOT NULL
        ) bin
        ${after ? sql`WHERE (bin.deleted_at, bin.id) < (${after.at}::timestamptz, ${after.id})` : sql``}
        ORDER BY bin.deleted_at DESC, bin.id DESC
        LIMIT ${query.limit + 1}`);
      const list = [...rows];
      const more = list.length > query.limit;
      const page = more ? list.slice(0, query.limit) : list;
      const people = await memberNames(page.map((row) => row.deleted_by));
      const last = page[page.length - 1];
      return {
        items: page.map((row) => ({
          kind: row.kind,
          id: row.id,
          name: row.name,
          table_id: row.table_id,
          table_name: row.table_name,
          deleted_at: new Date(row.deleted_at).toISOString(),
          deleted_by: refOf(people, row.deleted_by),
        })),
        // The exact time (microseconds), so records deleted in the same millisecond are not skipped.
        next_cursor:
          more && last ? Buffer.from(JSON.stringify({ at: last.exact, id: last.id })).toString('base64url') : null,
      };
    },

    /** Who shared, archived, restored or deleted what in a base, newest first (owners). */
    async auditLog(
      memberId: string,
      baseId: string,
      query: { cursor?: string | undefined; limit: number },
    ): Promise<Page<BaseAuditEntry>> {
      const reader = await loadReader(memberId);
      await baseAt(reader, baseId, 'owner', { archived: true });
      const before = query.cursor ? Number(Buffer.from(query.cursor, 'base64url').toString('utf8')) : null;
      if (before !== null && !Number.isInteger(before)) throw invalidInput('The cursor is invalid.');
      const rows = await getDb()
        .select()
        .from(auditEvents)
        .where(
          and(
            or(
              and(eq(auditEvents.resourceType, 'base'), eq(auditEvents.resourceId, baseId)),
              and(eq(auditEvents.scopeType, 'base'), eq(auditEvents.scopeId, baseId)),
            ),
            before !== null ? lt(auditEvents.id, before) : undefined,
          ),
        )
        .orderBy(desc(auditEvents.id))
        .limit(query.limit + 1);
      const more = rows.length > query.limit;
      const page = more ? rows.slice(0, query.limit) : rows;
      const people = await memberNames(page.map((row) => row.actorId));
      return {
        items: page.map((row) => ({
          id: String(row.id),
          action: row.action,
          actor: refOf(people, row.actorId),
          summary: row.summary,
          created_at: row.createdAt,
        })),
        next_cursor: more ? Buffer.from(String(page[page.length - 1]!.id)).toString('base64url') : null,
      };
    },

    /**
     * Checks that the member may upload for an attachment field of this base (an editor), before
     * the body is read; the answer stores the file, which joins a record when a change names it.
     */
    async uploader(memberId: string, baseId: string) {
      const reader = await loadReader(memberId);
      await baseAt(reader, baseId, 'editor');
      return async (file: { name: string; contentType: string; bytes: Uint8Array }): Promise<RecordFile> => {
        const stored = await deps.files.store(memberId, { ...file, purpose: 'record', baseId });
        return {
          id: stored.id,
          name: stored.name,
          content_type: stored.content_type,
          size_bytes: stored.size_bytes,
          url: stored.url,
        };
      };
    },

    /**
     * The records of a view (its filter, sorts, group and visible fields), or of the whole table,
     * as CSV with a byte order mark so spreadsheets read it as UTF-8, written as a stream.
     */
    exportCsv: (memberId: string, tableId: string, viewId?: string) =>
      exportCsv({ files: deps.files }, memberId, tableId, viewId),

    /**
     * Whether a member may read a record file (the file service asks): one a live record holds,
     * in a field and a record their role sees; or, not yet in a record, their own upload while
     * they still see the base.
     */
    async canReadFile(
      memberId: string,
      row: { id: string; baseId: string | null; ownerId: string | null },
    ): Promise<boolean> {
      if (!row.baseId) return false;
      const [held] = await getDb()
        .select({ recordId: baseRecordFiles.recordId, fieldId: baseRecordFiles.fieldId })
        .from(baseRecordFiles)
        .where(eq(baseRecordFiles.fileId, row.id))
        .limit(1);
      if (!held) return row.ownerId === memberId && (await canRead(memberId, row.baseId));
      const reader = await loadReader(memberId).catch(() => null);
      if (!reader) return false;
      try {
        const at = await recordAt(reader, held.recordId, 'viewer');
        if (at.base.id !== row.baseId) return false;
        if (at.access && (await hiddenFields(at.access, at.table.id)).has(held.fieldId)) return false;
        return true;
      } catch {
        return false;
      }
    },

    /** Custom roles of a base. */
    roles,

    /** Group members, modules or statuses changed somewhere: who sees which base is asked again. */
    forgetAudiences() {
      audiences.clear();
    },
  };

  /** Tells the members a new share reaches (group members too; not the whole workspace). */
  async function tellShared(
    actor: TablesReader,
    base: BaseRow,
    added: ReadonlyArray<{ id: string; type: string; principal: string | null }>,
  ) {
    for (const share of added) {
      let memberIds: string[] = [];
      if (share.type === 'member' && share.principal) memberIds = [share.principal];
      if (share.type === 'group' && share.principal) {
        memberIds = (
          await getDb()
            .select({ id: groupMembers.memberId })
            .from(groupMembers)
            .where(eq(groupMembers.groupId, share.principal))
            .limit(200)
        ).map((row) => row.id);
      }
      for (const memberId of memberIds) {
        if (memberId === actor.memberId) continue;
        const reader = await loadReader(memberId).catch(() => null);
        if (!reader) continue;
        await deps.notifications.publish({
          memberId,
          kind: 'share',
          title:
            reader.locale === 'zh'
              ? `${actor.name} 把表格「${base.name}」分享给了你`
              : `${actor.name} shared the base "${base.name}" with you`,
          targetType: 'base',
          targetId: base.id,
          payload: { category: 'share', from_member_id: actor.memberId },
          dedupeKey: `share:${share.id}`,
        });
      }
    }
  }

  // The file service asks this module who may read record attachments.
  deps.files.govern('record', (memberId, row) => service.canReadFile(memberId, row));

  return service;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/** The recycle bin's cursor: the exact deletion time (as Postgres wrote it) and the id. */
function decodeTrash(cursor: string): { at: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    if (
      typeof value.at === 'string' &&
      TIMESTAMP.test(value.at) &&
      typeof value.id === 'string' &&
      value.id.length <= 64
    ) {
      return { at: value.at, id: value.id };
    }
  } catch {
    // fall through
  }
  throw invalidInput('The cursor is invalid.');
}

function decodeBases(cursor: string): { name: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { n?: unknown; i?: unknown };
    if (typeof value.n === 'string' && typeof value.i === 'string' && value.n.length <= 200 && value.i.length <= 64) {
      return { name: value.n, id: value.i };
    }
  } catch {
    // fall through
  }
  throw invalidInput('The cursor is invalid.');
}

export type TablesService = ReturnType<typeof createTablesService>;
