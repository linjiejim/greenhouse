import { parseMs, zonedParts } from '../data/time';
import { COMPUTED_FIELD_TYPES } from '../shared/contract';
import type { Field, FormFillField, TableRecord, BaseTable, Base, View, RecordPage } from '../shared/contract';
export const computed = (type: string) => (COMPUTED_FIELD_TYPES as readonly string[]).includes(type);
export function mayEdit(base: Base, table: BaseTable): boolean {
  return !base.archived_at && (table.access === 'edit' || (!base.custom_role && base.access !== 'viewer'));
}
export function cellText(
  field: Pick<Field, 'type' | 'config'>,
  value: unknown,
  page?: Pick<RecordPage, 'linked' | 'files'>,
  names: Record<string, string> = {},
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && !Array.isArray(value)) return 'error' in value ? '!' : 'pending' in value ? '…' : '';
  if (field.type === 'checkbox') return value ? '✓' : '';
  const values = Array.isArray(value) ? value : [value];
  return values
    .map(
      (v) =>
        field.config.options?.find((o) => o.id === v)?.label ??
        page?.linked[String(v)]?.title ??
        page?.files[String(v)]?.name ??
        names[String(v)] ??
        (['member', 'relation', 'parent', 'dependency', 'attachment', 'single_select', 'multi_select'].includes(
          field.type,
        )
          ? ''
          : String(v)),
    )
    .filter(Boolean)
    .join(', ');
}
export function shownFields(table: BaseTable, view?: View): Field[] {
  const hidden = new Set(view?.config.hidden ?? []);
  const order = view?.config.order ?? [];
  return [...table.fields]
    .filter((f) => f.is_primary || !hidden.has(f.id))
    .sort((a, b) =>
      a.is_primary
        ? -1
        : b.is_primary
          ? 1
          : (order.indexOf(a.id) < 0 ? 1000 + a.position : order.indexOf(a.id)) -
            (order.indexOf(b.id) < 0 ? 1000 + b.position : order.indexOf(b.id)),
    );
}
export function titleOf(record: TableRecord, table: BaseTable): string {
  const primary = table.fields.find((f) => f.is_primary);
  return primary ? String(record.values[primary.id] ?? '') : '';
}
export function changedValues(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(after).filter(([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value)),
  );
}
export function groups(records: TableRecord[], field: string | undefined): { key: string; items: TableRecord[] }[] {
  const map = new Map<string, TableRecord[]>();
  for (const record of records) {
    const value = field ? record.values[field] : null;
    const key = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
    map.set(key, [...(map.get(key) ?? []), record]);
  }
  return [...map].map(([key, items]) => ({ key, items }));
}
export type EditableField = Field | FormFillField;
export function editable(field: EditableField): boolean {
  return !computed(field.type);
}

/** Members and record links are lists even when only one may be selected. */
export function choiceValue(field: Pick<Field, 'type'>, id: string): unknown {
  return ['member', 'relation', 'parent', 'dependency'].includes(field.type) ? (id ? [id] : []) : id || null;
}

/** Agenda days follow the member's time zone; date-only fields keep their calendar day. */
export function agendaGroups(records: TableRecord[], field: string | undefined, timeZone: string) {
  const grouped = new Map<string, TableRecord[]>();
  for (const record of records) {
    const raw = field ? record.values[field] : null;
    let key = '';
    if (typeof raw === 'string') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) key = raw;
      else {
        const ms = parseMs(raw);
        if (Number.isFinite(ms)) {
          const parts = zonedParts(ms, timeZone);
          key = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
        }
      }
    }
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  return [...grouped]
    .sort(([a], [b]) => (a ? (b ? a.localeCompare(b) : -1) : 1))
    .map(([key, items]) => ({ key, items }));
}
