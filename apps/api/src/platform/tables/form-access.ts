/**
 * Who may open and submit a form (spec 20261011-tables-foundation §3, D5) — the
 * one gate behind `openForm`, `submitForm` and the form upload route.
 *
 * Audience:
 *  - `base`       → the Base's own people with create rights on the table
 *                   (`requireTableData(…, 'create')`, kernel ceiling included);
 *  - `team`       → every active internal user;
 *  - `principals` → a listed user, or a member of a listed group through a
 *                   `group_members` row (a group's creator is not a member).
 * The Base's builders can always open and submit their own forms (to try them).
 * The capability (`tables.data.submitForm`) is checked by dispatch, or by the
 * upload route before it calls here.
 *
 * A passing submitter writes through a form scope, never their Base scope: the
 * shown fields plus the prefilled ones are editable, nothing is readable, create
 * only. For a Base audience the shown fields are additionally capped by the
 * member's own editable fields, so a form never widens a member's rights.
 * Links (relation targets, D14): a custom-role member links inside its own read
 * rows; a built-in member or a builder may link any row (they read them all); a
 * prefilled link is the builder's value (it wins over the client's), so its
 * target is open for everyone. Relation fields are shown only to a Base
 * audience, so nobody else picks a link.
 * Everything that fails — missing, archived, outside the audience — is the same
 * `not_found`; only an audience member learns a form is still a draft.
 */

import { effectiveUserId, type ActorContext } from '@greenhouse/platform-kernel';
import {
  formDefaultEntries,
  normalizeFormAudience,
  parseTableFieldConfig,
  type DatabaseProvider,
  type TableBaseRow,
  type TableFormRow,
} from '@greenhouse/db';
import {
  fullTableAccess,
  type TableAccessScope,
  type TableDataScope,
  type TableRelationTargetScope,
} from '@greenhouse/types/table-access';
import type { TableFormAudience } from '@greenhouse/types/tables';
import { baseForTable, requireBase, requireTableData } from './access.js';

type FormContext = { db: DatabaseProvider };

export type FormSubmitterGate =
  | { ok: true; form: TableFormRow; base: TableBaseRow; userId: string; scope: TableDataScope }
  | { ok: false; reason: 'not_found' | 'not_published' };

const NOT_FOUND = { ok: false, reason: 'not_found' } as const;

/**
 * The scope a submission writes with (see the module comment). `member` is the
 * submitter's Base scope (full for a built-in member or a builder), undefined
 * for someone admitted by a team / principals audience; `relationTargetOf` maps
 * the table's relation fields to their target tables.
 */
export function formSubmitScope(
  form: TableFormRow,
  userId: string,
  member: TableAccessScope | undefined,
  relationTargetOf: ReadonlyMap<number, number> = new Map(),
): TableDataScope {
  const shown =
    member?.kind === 'scoped'
      ? form.config.fieldIds.filter((fieldId) => member.editableFieldIds.includes(fieldId))
      : form.config.fieldIds;
  const prefilled = formDefaultEntries(form.config).map((entry) => entry.fieldId);
  const relationTargets: TableRelationTargetScope[] =
    member?.kind === 'scoped' ? [...(member.relationTargets ?? [])] : [];
  const openLinks = member?.kind === 'full' ? [...shown, ...prefilled] : prefilled;
  for (const fieldId of openLinks) {
    const tableId = relationTargetOf.get(fieldId);
    if (tableId !== undefined && !relationTargets.some((entry) => entry.tableId === tableId)) {
      relationTargets.push({ tableId, rows: [] });
    }
  }
  return {
    kind: 'scoped',
    userId,
    tableId: form.table_id,
    rows: [],
    editRows: [],
    readableFieldIds: [],
    editableFieldIds: [...new Set([...shown, ...prefilled])],
    canCreate: true,
    canDelete: false,
    relationTargets,
  };
}

/** Relation field id → target table id, for the table's active relation fields. */
async function relationTargetsOf(ctx: FormContext, tableId: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const field of await ctx.db.tables.listFields(tableId)) {
    const target = field.type === 'relation' ? parseTableFieldConfig(field).relation?.targetTableId : undefined;
    if (target) out.set(field.id, target);
  }
  return out;
}

/** Audience membership for one person; `member` is their Base scope when the audience is the Base. */
async function audienceAdmits(
  ctx: FormContext,
  actor: ActorContext,
  form: TableFormRow,
  userId: string,
): Promise<{ admitted: boolean; member?: TableAccessScope }> {
  const audience = form.audience;
  if (audience.type === 'base') {
    const data = await requireTableData({ actor }, ctx, form.table_id, 'create');
    return data ? { admitted: true, member: data.scope } : { admitted: false };
  }
  if (audience.type === 'team') return { admitted: true };
  return { admitted: await ctx.db.tables.formAudienceIncludes(audience, userId) };
}

export async function resolveFormSubmitter(
  ctx: FormContext,
  actor: ActorContext,
  formId: number,
): Promise<FormSubmitterGate> {
  const form = await ctx.db.tables.getForm(formId);
  if (!form) return NOT_FOUND;
  const [table, base] = await Promise.all([ctx.db.tables.getTable(form.table_id), baseForTable(ctx.db, form.table_id)]);
  if (!table || table.archived_at || !base || base.archived_at) return NOT_FOUND;
  const userId = effectiveUserId(actor);
  const user = await ctx.db.users.getById(userId);
  if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) return NOT_FOUND;

  let { admitted, member } = await audienceAdmits(ctx, actor, form, userId);
  if (!admitted && (await requireBase(ctx, actor, base.id, 'form', 'builder'))) {
    admitted = true;
    member = fullTableAccess(userId);
  }
  if (!admitted) return NOT_FOUND;
  if (form.status !== 'published') return { ok: false, reason: 'not_published' };
  const scope = formSubmitScope(form, userId, member, await relationTargetsOf(ctx, form.table_id));
  return { ok: true, form, base, userId, scope };
}

/**
 * The audience a builder is saving, or a refusal. Groups follow the Base-sharing
 * rule (spec §1, D12): the granter must be the group's creator or a member
 * (super: any) — an unknown or invisible group is `group_not_found`. Groups
 * already on the form (`current`) stay, so a co-builder can edit a form that
 * names a group they cannot see.
 */
export async function grantableFormAudience(
  ctx: FormContext,
  actor: ActorContext,
  raw: unknown,
  current?: TableFormAudience,
): Promise<{ ok: true; audience: TableFormAudience | undefined } | { ok: false; reason: 'group_not_found' }> {
  if (raw === undefined) return { ok: true, audience: undefined };
  const audience = normalizeFormAudience(raw);
  if (audience.type !== 'principals') return { ok: true, audience };
  const kept = new Set(current?.type === 'principals' ? current.groupIds : []);
  const added = audience.groupIds.filter((groupId) => !kept.has(groupId));
  if (added.length === 0) return { ok: true, audience };
  const userId = effectiveUserId(actor);
  const user = await ctx.db.users.getById(userId);
  if (user?.role === 'super') {
    const found = await Promise.all(added.map((groupId) => ctx.db.groups.getById(groupId)));
    return found.every(Boolean) ? { ok: true, audience } : { ok: false, reason: 'group_not_found' };
  }
  const visible = new Set((await ctx.db.groups.listForUser(userId)).map((group) => group.id));
  return added.every((groupId) => visible.has(groupId))
    ? { ok: true, audience }
    : { ok: false, reason: 'group_not_found' };
}
