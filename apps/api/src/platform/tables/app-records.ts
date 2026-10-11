/**
 * Records as an app delivers them (docs/specs/20261011-tables-apps.md §3) —
 * `AppRecordRow` (only the fields a card shows that the role reads, computed
 * values merged in), the labels behind them (`AppRecordRefs`: app viewers
 * cannot call `/api/tables`, so people, linked records and files are named
 * here), and which declared actions a viewer may run on each row right now.
 *
 * Relation labels follow the role's read scope on the target table: a target
 * row outside it comes back as `null` ("no permission"), never its text; one
 * inside it shows its primary field when the role reads that field, else `#id`.
 */

import type { TableRecordRow } from '@greenhouse/db';
import {
  actionAllowedForRole,
  type AppCard,
  type AppRecordAction,
  type AppRecordRefs,
  type AppRecordRow,
} from '@greenhouse/types/apps';
import type { TableAccessSchemaFacts, TableDataScope } from '@greenhouse/types/table-access';
import { isRecordsCard } from './app-scope.js';
import { sessionTableAccess, type AppSession } from './app-session.js';
import type { Handler } from './handlers/shared.js';

type Context = Parameters<Handler>[1];

function isoTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** One record as an app card / drawer delivers it: `fields` only (values ∪ computed), absent never null-filled. */
export function appRecordRow(row: TableRecordRow, fields: ReadonlySet<number>, actionIds: string[]): AppRecordRow {
  const values: Record<string, unknown> = {};
  for (const source of [row.values, row.computed_values]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (fields.has(Number(key))) values[key] = value;
    }
  }
  return {
    id: row.id,
    revision: row.revision,
    values,
    createdBy: row.created_by,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    actionIds,
  };
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
}

function labelText(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (Array.isArray(value)) {
    const parts = value.map(labelText).filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(', ') : undefined;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Labels for what `rows` show in `fields`: people (user fields and creators),
 * linked records (inside the role's read scope on their table, else null),
 * attachments (live files only).
 */
export async function appRecordRefs(
  context: Context,
  session: AppSession,
  tableId: number,
  rows: readonly TableRecordRow[],
  fields: ReadonlySet<number>,
): Promise<AppRecordRefs> {
  const facts: TableAccessSchemaFacts = await session.facts();
  const byId = new Map(facts.fields.filter((field) => field.tableId === tableId).map((field) => [field.id, field]));
  const userIds = new Set<string>();
  const fileIds = new Set<number>();
  const links = new Map<number, Set<number>>();
  for (const row of rows) {
    if (row.created_by) userIds.add(row.created_by);
    for (const fieldId of fields) {
      const field = byId.get(fieldId);
      if (!field) continue;
      const key = String(fieldId);
      const value = key in (row.computed_values ?? {}) ? row.computed_values[key] : row.values[key];
      if (field.type === 'user' || field.type === 'multi_user') {
        for (const id of asList(value)) if (typeof id === 'string' && id) userIds.add(id);
      } else if (field.type === 'attachment') {
        for (const id of asList(value)) if (typeof id === 'number') fileIds.add(id);
      } else if (field.type === 'relation' && field.relationTargetTableId) {
        const target = links.get(field.relationTargetTableId) ?? new Set<number>();
        for (const id of asList(value)) if (typeof id === 'number') target.add(id);
        links.set(field.relationTargetTableId, target);
      }
    }
  }

  const users: AppRecordRefs['users'] = {};
  if (userIds.size > 0) {
    for (const user of await context.db.users.list()) {
      if (userIds.has(user.id)) users[user.id] = { nickname: user.nickname };
    }
  }

  const records: AppRecordRefs['records'] = {};
  for (const [targetTableId, ids] of links) {
    for (const id of ids) records[`${targetTableId}:${id}`] = null;
    const access = await sessionTableAccess(context, session, targetTableId, 'read');
    if (!access.ok || access.ceiling.read !== 'full') continue;
    const primary = facts.fields.find((field) => field.tableId === targetTableId && field.isPrimary);
    const readsPrimary = primary ? access.scope.readableFieldIds.includes(primary.id) : false;
    for (const target of await context.db.tables.listRecordsByIds(targetTableId, [...ids], access.scope)) {
      const key = primary ? String(primary.id) : '';
      const raw = primary ? (key in target.computed_values ? target.computed_values[key] : target.values[key]) : null;
      records[`${targetTableId}:${target.id}`] = (readsPrimary ? labelText(raw) : undefined) ?? `#${target.id}`;
    }
  }

  const files: AppRecordRefs['files'] = {};
  for (const file of await context.db.tables.listDriveFileMeta([...fileIds])) {
    if (file.status !== 'active' || file.base_id !== session.base.id) continue;
    files[String(file.id)] = { name: file.name, size: file.size, mimeType: file.content_type };
  }
  return { users, records, files };
}

/** Declared actions the role in play may use on this card (roles, page, D6). */
export function usableActions(
  session: AppSession,
  pageId: string,
  actions: readonly AppRecordAction[],
  broken: ReadonlySet<string>,
): AppRecordAction[] {
  return actions.filter(
    (action) =>
      !broken.has(action.id) &&
      (session.role ? actionAllowedForRole(session.spec, pageId, action, session.role.key) : true),
  );
}

/**
 * Which of `actions` each record allows right now: the effect's rights on
 * the table (the kernel op and the role's rule — set_fields keys editable,
 * delete allowed, automations need an edit rule), the row inside the card's
 * edit scope, and `when` holding (THE compiler, one query per action). The
 * write re-checks all of it inside its transaction.
 */
export async function availableActionIds(
  context: Context,
  session: AppSession,
  card: AppCard,
  editScope: TableDataScope,
  actions: readonly AppRecordAction[],
  recordIds: readonly number[],
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>(recordIds.map((id) => [id, []]));
  if (!isRecordsCard(card) || actions.length === 0 || recordIds.length === 0) return out;
  const tableId = card.source.tableId;
  const opOk = new Map<string, Awaited<ReturnType<typeof sessionTableAccess>>>();
  const access = async (op: 'update' | 'delete') => {
    if (!opOk.has(op)) opOk.set(op, await sessionTableAccess(context, session, tableId, op));
    return opOk.get(op)!;
  };
  for (const action of actions) {
    const op = action.do.type === 'delete' ? 'delete' : 'update';
    const granted = await access(op);
    if (!granted.ok || !granted.ceiling.write) continue;
    if (action.do.type === 'set_fields') {
      const editable = new Set(granted.scope.editableFieldIds);
      const keys = [...action.do.values.map((entry) => entry.fieldId), ...(action.do.inputFieldIds ?? [])];
      if (!granted.editable || keys.some((key) => !editable.has(key))) continue;
    } else if (action.do.type === 'delete') {
      if (!granted.scope.canDelete) continue;
    } else if (!granted.editable) {
      continue;
    }
    const matched = await context.db.tables.matchRecordIds(tableId, recordIds, editScope, {
      purpose: 'edit',
      condition: action.when,
    });
    for (const id of matched) out.get(id)?.push(action.id);
  }
  return out;
}
