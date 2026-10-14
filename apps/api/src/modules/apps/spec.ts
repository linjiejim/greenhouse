import { appSpecSchema, isComputedType, isSystemField, type AppCard, type AppSpec } from '@greenhouse/contract';
import type { BaseFieldRow } from '@greenhouse/db';
import { invalidInput } from '../../http/errors.js';
import { cleanRules } from '../tables/roles.js';
import { fieldsOf } from '../tables/load.js';
import { baseTables, getDb } from '@greenhouse/db';
import { and, eq, isNull } from 'drizzle-orm';

export const readSpec = (value: string): AppSpec => appSpecSchema.parse(JSON.parse(value));
export const fieldsIn = (card: AppCard): string[] =>
  'fields' in card ? [...card.fields, ...(card.detail_fields ?? [])] : 'list' in card ? (card.list?.fields ?? []) : [];
export const actionsIn = (card: AppCard) => ('action' in card ? [card.action] : 'actions' in card ? card.actions : []);

/** Refuse cross-base references, unknown fields and malformed drafts before publishing them. */
export async function checkSpec(baseId: string, spec: AppSpec): Promise<AppSpec> {
  if (Buffer.byteLength(JSON.stringify(spec), 'utf8') > 1_000_000) throw invalidInput('An app spec is at most 1 MB.');
  const tables = await getDb()
    .select()
    .from(baseTables)
    .where(and(eq(baseTables.baseId, baseId), isNull(baseTables.archivedAt)));
  const fields = await fieldsOf(tables.map((t) => t.id));
  for (const page of spec.pages)
    for (const card of page.cards) {
      if (card.kind === 'custom') continue;
      if (!tables.some((t) => t.id === card.table_id)) throw invalidInput('Cards use data tables of this base.');
      const own = fields.filter((f) => f.tableId === card.table_id);
      if (fieldsIn(card).some((id) => !own.some((f) => f.id === id)))
        throw invalidInput('Card fields belong to their data table.');
      const refs = [
        ...fieldsIn(card),
        ...('group_field' in card && card.group_field ? [card.group_field] : []),
        ...('filter' in card ? (card.filter?.clauses.map((c) => c.field) ?? []) : []),
        ...('measure' in card && card.measure?.field ? [card.measure.field] : []),
        ...('group' in card && card.group ? [card.group.field] : []),
        ...('list' in card ? (card.list?.fields ?? []) : []),
      ];
      if (refs.some((id) => !isSystemField(id) && !own.some((f) => f.id === id)))
        throw invalidInput('A card names a field that is not in its data table.');
      if ('group_field' in card && card.kind === 'kanban' && !card.group_field)
        throw invalidInput('A board needs its group field.');
      const actions = actionsIn(card);
      if (new Set(actions.map((a) => a.id)).size !== actions.length)
        throw invalidInput('Action ids must be unique in a card.');
      for (const action of actions) {
        for (const id of Object.keys(action.values)) {
          const field = own.find((f) => f.id === id);
          if (!field || isComputedType(field.type))
            throw invalidInput('An action writes editable fields of its data table.');
          // Template snapshots never capture live record, file or member references.
          if (
            ['attachment', 'relation', 'parent', 'dependency', 'member'].includes(field.type) &&
            action.values[id] !== '$me'
          )
            throw invalidInput('Actions cannot store fixed file, record or member ids.');
        }
        if (card.kind === 'button' && action.type !== 'create')
          throw invalidInput('A page button creates a record; updates belong to a record card.');
      }
      if (card.kind === 'form' && card.fields.some((id) => isComputedType(own.find((f) => f.id === id)!.type)))
        throw invalidInput('Forms contain editable fields.');
    }
  const roles = [];
  for (const role of spec.roles) {
    if (role.id === 'use') throw invalidInput('The role id use is reserved.');
    roles.push({ ...role, rules: await cleanRules(baseId, role.rules) });
  }
  return { ...spec, roles };
}

/** A card whose predicate or fixed action reads a hidden field must not disclose that value. */
export function trimCard(card: AppCard, visible: Map<string, Pick<BaseFieldRow, 'id'>>): AppCard | null {
  if (card.kind === 'custom') return { ...card, html: '' };
  const refs = 'filter' in card ? (card.filter?.clauses.map((c) => c.field) ?? []) : [];
  if ('group' in card && card.group) refs.push(card.group.field);
  if ('measure' in card && card.measure?.field) refs.push(card.measure.field);
  if ('group_field' in card && card.group_field) refs.push(card.group_field);
  if (refs.some((id) => !isSystemField(id) && !visible.has(id))) return null;
  const actions = actionsIn(card).filter((a) => Object.keys(a.values).every((id) => visible.has(id)));
  if ('action' in card) return actions.length ? { ...card, action: actions[0]! } : null;
  if ('fields' in card)
    return {
      ...card,
      fields: card.fields.filter((id) => visible.has(id)),
      detail_fields: card.detail_fields?.filter((id) => visible.has(id)),
      actions,
    };
  return {
    ...card,
    ...('list' in card && card.list
      ? {
          list: {
            ...card.list,
            fields: card.list.fields.filter((id) => visible.has(id)),
            sorts: card.list.sorts?.filter((s) => isSystemField(s.field) || visible.has(s.field)),
          },
        }
      : {}),
  };
}
