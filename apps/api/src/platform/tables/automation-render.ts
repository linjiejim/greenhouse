/**
 * Text and values an automation produces from a record — pure functions.
 *
 * - `renderTemplate`: notify title / message, `{{field:<id>}}` replaced by the
 *   field's display text. Rendered once PER RECIPIENT against that recipient's
 *   readable fields (`readable`); anything they may not read becomes "—", so a
 *   hidden column never reaches an inbox, IM DM, email or push.
 * - `resolveActionValues`: `update_record` / `create_record` values, with the
 *   whole-value tokens `$now` / `$today` / `$actor` and `{{field}}` templates
 *   in text-like fields. The executor is builder+, so it reads every field.
 * - `webhookFields`: the `{name: value}` map a webhook body carries.
 */

import { expandDateToken } from '@greenhouse/types/date-tokens';
import {
  TABLE_AUTOMATION_FIELD_TEMPLATE,
  type TableFieldValueEntry,
  type TableRecordValues,
} from '@greenhouse/types/tables';
import { parseTableFieldConfig, type TableFieldRow, type TableRecordRow } from '@greenhouse/db';
import type { BotsLocale } from '../../bots/engine/copy.js';

export const UNREADABLE_PLACEHOLDER = '—';

export interface RenderUser {
  id: string;
  nickname: string | null;
  email: string;
}

export interface RenderContext {
  fields: ReadonlyMap<number, TableFieldRow>;
  record: Pick<TableRecordRow, 'values' | 'computed_values'> | null;
  usersById: ReadonlyMap<string, RenderUser>;
  locale: BotsLocale;
  timeZone: string;
  /** Field ids the reader may see; null = all of them. */
  readable: ReadonlySet<number> | null;
}

const COPY: Record<BotsLocale, { yes: string; no: string; files: (count: number) => string }> = {
  en: { yes: 'Yes', no: 'No', files: (count) => `${count} file${count === 1 ? '' : 's'}` },
  zh: { yes: '是', no: '否', files: (count) => `${count} 个文件` },
};

/** `YYYY-MM-DD HH:mm` in `timeZone` (falls back to UTC for an unknown zone). */
export function formatLocalDateTime(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 16).replace('T', ' ');
  }
}

function userName(ctx: Pick<RenderContext, 'usersById'>, id: unknown): string {
  if (typeof id !== 'string') return '';
  const user = ctx.usersById.get(id);
  return user ? user.nickname || user.email : id;
}

/** One stored value as display text ('' when empty). */
export function formatFieldValue(
  field: TableFieldRow,
  value: unknown,
  ctx: Pick<RenderContext, 'usersById' | 'locale' | 'timeZone'>,
): string {
  if (value === null || value === undefined || value === '') return '';
  const options = new Map((parseTableFieldConfig(field).options ?? []).map((option) => [option.id, option.label]));
  const list = (items: unknown[], each: (item: unknown) => string) => items.map(each).filter(Boolean).join(', ');
  switch (field.type) {
    case 'boolean':
      return value === true ? COPY[ctx.locale].yes : value === false ? COPY[ctx.locale].no : '';
    case 'datetime': {
      const date = new Date(String(value));
      return Number.isNaN(date.valueOf()) ? String(value) : formatLocalDateTime(date, ctx.timeZone);
    }
    case 'single_select':
      return options.get(String(value)) ?? String(value);
    case 'multi_select':
      return Array.isArray(value) ? list(value, (item) => options.get(String(item)) ?? String(item)) : '';
    case 'user':
      return userName(ctx, value);
    case 'multi_user':
      return Array.isArray(value) ? list(value, (item) => userName(ctx, item)) : '';
    case 'attachment':
      return Array.isArray(value) && value.length > 0 ? COPY[ctx.locale].files(value.length) : '';
    case 'relation':
      return (Array.isArray(value) ? value : [value]).map((id) => `#${String(id)}`).join(', ');
    default:
      if (Array.isArray(value)) return list(value, (item) => (item === null ? '' : String(item)));
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
  }
}

function recordValue(record: RenderContext['record'], fieldId: number): unknown {
  if (!record) return undefined;
  const key = String(fieldId);
  return key in (record.computed_values ?? {}) ? record.computed_values[key] : record.values[key];
}

/** `{{field:<id>}}` → that field's display text for this reader, "—" when hidden, missing or empty. */
export function renderTemplate(text: string, ctx: RenderContext): string {
  return text.replace(TABLE_AUTOMATION_FIELD_TEMPLATE, (_, rawId: string) => {
    const fieldId = Number(rawId);
    const field = ctx.fields.get(fieldId);
    if (!field || !ctx.record || (ctx.readable && !ctx.readable.has(fieldId))) return UNREADABLE_PLACEHOLDER;
    return formatFieldValue(field, recordValue(ctx.record, fieldId), ctx) || UNREADABLE_PLACEHOLDER;
  });
}

export interface ValueResolution {
  /** Fields of the table being written. */
  targetFields: ReadonlyMap<number, TableFieldRow>;
  /** The triggering record and its table's fields (templates read from it). */
  source: RenderContext;
  actor: RenderUser | null;
  now: Date;
}

/** Action values → a `values` object for the record write. */
export function resolveActionValues(
  entries: readonly TableFieldValueEntry[],
  input: ValueResolution,
): TableRecordValues {
  const values: TableRecordValues = {};
  for (const entry of entries) {
    const field = input.targetFields.get(entry.fieldId);
    const type = field?.type;
    let value = entry.value;
    if (value === '$now') {
      value =
        type === 'datetime'
          ? input.now.toISOString()
          : type === 'date'
            ? expandDateToken('$today', input.now, input.source.timeZone)
            : formatLocalDateTime(input.now, input.source.timeZone);
    } else if (value === '$today') {
      value = expandDateToken('$today', input.now, input.source.timeZone);
    } else if (value === '$actor') {
      if (!input.actor) value = null;
      else if (type === 'user') value = input.actor.id;
      else if (type === 'multi_user') value = [input.actor.id];
      else value = input.actor.nickname || input.actor.email;
    } else if (typeof value === 'string' && value.includes('{{field:')) {
      // The executor is builder+: templates in values read every field.
      value = renderTemplate(value, { ...input.source, readable: null });
    }
    values[String(entry.fieldId)] = value;
  }
  return values;
}

/** A webhook's `fields`: names → raw values, limited to `fieldIds` (default: every field). */
export function webhookFields(
  fields: readonly TableFieldRow[],
  record: Pick<TableRecordRow, 'values' | 'computed_values'> | null,
  fieldIds: readonly number[] | undefined,
): Record<string, unknown> {
  if (!record) return {};
  const wanted = fieldIds && fieldIds.length > 0 ? new Set(fieldIds) : null;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (wanted && !wanted.has(field.id)) continue;
    const value = recordValue(record, field.id);
    out[field.name] = value === undefined ? null : value;
  }
  return out;
}
