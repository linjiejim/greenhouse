/**
 * What a reader sees of a data table. Owners, builders, editors and viewers see every field and
 * record; a custom role (base_roles) may hide the table, some fields and some records. Every read
 * path takes its fields and records from here: lists, single records, search, exports,
 * dashboards, history, comments and realtime events.
 *
 * A computed field is hidden with what it reads: a formula or AI field reading a hidden field; a
 * lookup or rollup following a hidden link, reading a hidden field, or reading a table the role
 * sees only in part (its value would add up records the reader may not see); and anything that
 * reads a link as its records' titles when the role does not see every record it links to.
 */

import { and, eq, type SQL } from 'drizzle-orm';
import { isComputedType, isLinkType, roleAtLeast } from '@greenhouse/contract';
import { baseFieldDeps, baseFields, baseRecords, getDb, type BaseFieldRow } from '@greenhouse/db';
import type { CustomAccess, TablesReader } from './access.js';
import { fieldsOf, type TableAt } from './load.js';
import { compileRoleFilters, inIds, type QueryContext } from './query.js';

export interface TableScope {
  /** The live fields the reader sees, in the table's order. */
  fields: BaseFieldRow[];
  /** Live fields the reader does not see. */
  hidden: ReadonlySet<string>;
  /** Which records the reader sees, as a condition on base_records (undefined: all). */
  rows: SQL | undefined;
  /** Whether the reader may change records here. */
  canEdit: boolean;
  /** Seen through a custom role: told less (no record ids in realtime events, no recycle bin). */
  limited: boolean;
}

/** Each role's hidden fields for every table it sees, worked out once per request. */
const hiddenByAccess = new WeakMap<CustomAccess, Promise<Map<string, Set<string>>>>();

/** The fields a custom role hides in a table, with the computed fields that read what it may not see. */
export async function hiddenFields(access: CustomAccess, tableId: string): Promise<Set<string>> {
  if (!access.tables.has(tableId)) return new Set((await fieldsOf(tableId)).map((field) => field.id));
  let all = hiddenByAccess.get(access);
  if (!all) {
    all = hiddenAll(access);
    hiddenByAccess.set(access, all);
  }
  return new Set((await all).get(tableId) ?? []);
}

/**
 * Hidden fields of every table a role sees, to a fixed point: a computed field is hidden with
 * anything it reads that is hidden, a table the role sees only in part (a lookup or rollup over
 * it would read records it may not see), or a link whose records' titles it may not read.
 */
async function hiddenAll(access: CustomAccess): Promise<Map<string, Set<string>>> {
  const tableIds = [...access.tables.keys()];
  const fields = await fieldsOf(tableIds);
  const hidden = new Map<string, Set<string>>();
  for (const id of tableIds) {
    const primary = fields.find((field) => field.tableId === id && field.isPrimary)?.id;
    hidden.set(id, new Set([...access.tables.get(id)!.hidden].filter((field) => field !== primary)));
  }
  const computed = fields.filter((field) => isComputedType(field.type));
  if (!computed.length) return hidden;
  const deps = await getDb()
    .select({
      field: baseFieldDeps.fieldId,
      on: baseFieldDeps.dependsOnFieldId,
      kind: baseFieldDeps.kind,
      table: baseFields.tableId,
      type: baseFields.type,
      config: baseFields.config,
    })
    .from(baseFieldDeps)
    .innerJoin(baseFields, eq(baseFields.id, baseFieldDeps.dependsOnFieldId))
    .where(
      inIds(
        baseFieldDeps.fieldId,
        computed.map((field) => field.id),
      ),
    );
  const fullySeen = (tableId: string | undefined) => {
    const rules = tableId ? access.tables.get(tableId) : undefined;
    return !!rules && rules.rows.length === 0;
  };
  /** A link's titles are readable when the role sees every record of the table it links to. */
  const titlesOpen = (dep: (typeof deps)[number]) =>
    !isLinkType(dep.type) || fullySeen(dep.type === 'relation' ? dep.config.table_id : dep.table);
  const isHidden = (tableId: string, fieldId: string) =>
    !access.tables.has(tableId) || (hidden.get(tableId)?.has(fieldId) ?? false);
  for (let changed = true; changed; ) {
    changed = false;
    for (const field of computed) {
      const own = hidden.get(field.tableId)!;
      if (own.has(field.id)) continue;
      const hide = deps
        .filter((dep) => dep.field === field.id)
        .some((dep) =>
          dep.kind === 'target'
            ? !fullySeen(dep.table) || isHidden(dep.table, dep.on) || !titlesOpen(dep)
            : isHidden(dep.table, dep.on) || !titlesOpen(dep),
        );
      if (hide) {
        own.add(field.id);
        changed = true;
      }
    }
  }
  return hidden;
}

/** The condition a custom role puts on a table's records (undefined: it sees them all). */
export async function rowsOf(
  reader: TablesReader,
  at: { table: { id: string }; custom: TableAt['custom'] },
): Promise<SQL | undefined> {
  if (!at.custom?.rows.length) return undefined;
  const fields = await fieldsOf(at.table.id);
  const ctx: QueryContext = {
    fields: new Map(fields.map((field) => [field.id, field])),
    memberId: reader.memberId,
    timeZone: reader.timeZone,
  };
  return compileRoleFilters(at.custom.rows, ctx);
}

/** Whether a custom role sees this record (always, for the four roles). */
export async function recordVisible(
  reader: TablesReader,
  at: { table: { id: string }; custom: TableAt['custom'] },
  recordId: string,
): Promise<boolean> {
  const rows = await rowsOf(reader, at);
  if (!rows) return true;
  const [found] = await getDb()
    .select({ id: baseRecords.id })
    .from(baseRecords)
    .where(and(eq(baseRecords.id, recordId), rows));
  return !!found;
}

/** The reader's view of a table they reached through tableAt (or recordAt, fieldAt). */
export async function scopeOf(reader: TablesReader, at: TableAt): Promise<TableScope> {
  const fields = await fieldsOf(at.table.id);
  const canEditBase = roleAtLeast(at.role, 'editor') && !at.base.archivedAt;
  if (!at.access || !at.custom) {
    return { fields, hidden: new Set(), rows: undefined, canEdit: canEditBase, limited: false };
  }
  const hidden = await hiddenFields(at.access, at.table.id);
  return {
    fields: fields.filter((field) => !hidden.has(field.id)),
    hidden,
    rows: await rowsOf(reader, at),
    canEdit: canEditBase && at.custom.access === 'edit',
    limited: true,
  };
}

/** Whether a custom role sees a table of its base (every table, for the four roles). */
export const tableVisible = (access: CustomAccess | null, tableId: string) => !access || access.tables.has(tableId);
