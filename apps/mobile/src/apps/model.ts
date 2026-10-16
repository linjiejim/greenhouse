import type { AppCard, AppRuntime, Field } from '../shared/contract';
import { computed, mayEdit } from '../tables/model';

export type RecordCard = Extract<AppCard, { fields: string[] }>;
export interface AppCardContext {
  runtime: AppRuntime;
  card: RecordCard;
  record?: string;
}

/** App detail fields are an explicit publication boundary, including an empty list. */
export function cardFields(runtime: AppRuntime, card: RecordCard, detail = false): Field[] {
  const table = runtime.base.tables.find((t) => t.id === card.table_id);
  const ids = detail ? (card.detail_fields ?? card.fields) : card.fields;
  return ids.flatMap((id) => table?.fields.find((f) => f.id === id) ?? []);
}
export function canAct(runtime: AppRuntime, tableId: string): boolean {
  const table = runtime.base.tables.find((t) => t.id === tableId);
  return !runtime.preview && runtime.version > 0 && !!table && table.access !== 'read' && mayEdit(runtime.base, table);
}
export function validValues(fields: Field[], values: Record<string, unknown>): boolean {
  return fields.every((f) => {
    if (computed(f.type)) return true;
    const value = values[f.id];
    if (typeof value === 'number' && !Number.isFinite(value)) return false;
    return (
      !f.required ||
      (value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0))
    );
  });
}

export const recordChoice = (field: Field) => ['relation', 'parent', 'dependency'].includes(field.type);

/** A picker may read titles only through a published record card that exposes them. */
export function choiceCard(runtime: AppRuntime, field: Field): RecordCard | undefined {
  const target = field.config.table_id ?? field.table_id;
  const primary = runtime.base.tables.find((table) => table.id === target)?.fields.find((f) => f.is_primary);
  if (!primary) return;
  return runtime.pages
    .flatMap((page) => page.cards)
    .find(
      (card): card is RecordCard =>
        'fields' in card && card.kind !== 'form' && card.table_id === target && card.fields.includes(primary.id),
    );
}

export function appCardPath(runtime: AppRuntime, cardId: string): string {
  const page = runtime.pages.find((p) => p.cards.some((c) => c.id === cardId));
  return `/#/apps/${encodeURIComponent(runtime.app.id)}${page ? `/${encodeURIComponent(page.id)}` : ''}`;
}
