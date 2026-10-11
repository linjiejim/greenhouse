/**
 * Rows of "field → value" where a value is either a fixed value (through the
 * one `FieldEditor`) or the server-resolved token that field type takes
 * (`$me` for people, `$today` for dates, `$now` for date-times). Form
 * prefills (Tables forms) and an app's prefills and action values (the app
 * builder) all edit `TableFieldValueEntry[]` with it.
 *
 * Rows hold drafts (`FieldDraft`), so half-typed input is not parsed away
 * under the cursor; `fieldValueEntries` converts them when the host saves.
 * Copy comes from the host: "the person submitting" and "the person running
 * the action" are the same token in different places.
 */

import { useMemo } from 'react';
import type { TableFieldType, TableFieldValueEntry } from '@greenhouse/types/tables';
import { Button, IconButton, Select } from '../ui';
import { Plus, Trash2 } from '../../lib/icons';
import type { TableField, TableUserOption } from '../../lib/api/tables';
import { FieldEditor } from './field-editor';
import { fromFieldDraft, toFieldDraft, type FieldDraft } from './field-draft';
import { isComputedField } from './field-types';

export type FieldValueToken = '$me' | '$today' | '$now';

/** The token each field type may take (the server's default-token table: people, dates, date-times). */
export const FIELD_VALUE_TOKEN_FOR: Partial<Record<TableFieldType, FieldValueToken>> = {
  user: '$me',
  multi_user: '$me',
  date: '$today',
  datetime: '$now',
};

export interface FieldValueRow {
  fieldId: number;
  /** `token` = the field type's `FIELD_VALUE_TOKEN_FOR`; `fixed` = `draft`. */
  mode: 'token' | 'fixed';
  draft: FieldDraft;
}

/** Fields a fixed value or a token can fill: stored fields, not attachments. */
export function prefillableField(field: Pick<TableField, 'type'>): boolean {
  return !isComputedField(field) && field.type !== 'attachment';
}

/** Stored entries → rows. Accepts the legacy `{fieldId: value}` object shape; unknown fields drop out. */
export function fieldValueRows(raw: unknown, byId: ReadonlyMap<number, TableField>): FieldValueRow[] {
  const entries = Array.isArray(raw)
    ? (raw as Array<{ fieldId: number; value: unknown }>)
    : raw && typeof raw === 'object'
      ? Object.entries(raw).map(([fieldId, value]) => ({ fieldId: Number(fieldId), value }))
      : [];
  return entries.flatMap((entry): FieldValueRow[] => {
    const field = byId.get(entry.fieldId);
    if (!field) return [];
    const token = FIELD_VALUE_TOKEN_FOR[field.type];
    return token && entry.value === token
      ? [{ fieldId: field.id, mode: 'token', draft: '' }]
      : [{ fieldId: field.id, mode: 'fixed', draft: toFieldDraft(field, entry.value) }];
  });
}

export function isEmptyFieldValue(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

/**
 * Rows → entries. `requireValue`: a row whose fixed value is empty makes the
 * whole result `null` (the host refuses to save); otherwise it becomes
 * `value: null` (write nothing / clear the field).
 */
export function fieldValueEntries(
  rows: readonly FieldValueRow[],
  byId: ReadonlyMap<number, TableField>,
  { requireValue = true }: { requireValue?: boolean } = {},
): TableFieldValueEntry[] | null {
  const entries: TableFieldValueEntry[] = [];
  for (const row of rows) {
    const field = byId.get(row.fieldId);
    if (!field) continue;
    const token = FIELD_VALUE_TOKEN_FOR[field.type];
    const value = row.mode === 'token' && token ? token : fromFieldDraft(field, row.draft);
    if (isEmptyFieldValue(value)) {
      if (requireValue) return null;
      entries.push({ fieldId: field.id, value: null });
      continue;
    }
    entries.push({ fieldId: field.id, value });
  }
  return entries;
}

/** A new row on `field`: its token when it has one, else an empty fixed value. */
export function newFieldValueRow(field: TableField): FieldValueRow {
  return {
    fieldId: field.id,
    mode: FIELD_VALUE_TOKEN_FOR[field.type] ? 'token' : 'fixed',
    draft: toFieldDraft(field, null),
  };
}

export interface FieldValuesEditorCopy {
  field: string;
  value: string;
  fixed: string;
  tokens: Record<FieldValueToken, string>;
  add: string;
  remove: string;
  /** Shown when there are no rows. */
  none: string;
  /** Shown when no further field can be added and there are no rows. */
  noFields?: string;
}

export function FieldValuesEditor({
  rows,
  onChange,
  fields,
  users,
  copy,
  emptyLabel,
  disabled = false,
}: {
  rows: readonly FieldValueRow[];
  onChange: (rows: FieldValueRow[]) => void;
  /** The fields a row may target (the host filters: prefillable, not already shown, …). */
  fields: readonly TableField[];
  users: TableUserOption[];
  copy: FieldValuesEditorCopy;
  /** The empty choice of single-value pickers. */
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const byId = useMemo(() => new Map(fields.map((field) => [field.id, field])), [fields]);
  const used = new Set(rows.map((row) => row.fieldId));
  /** A row may keep its own field and take any field no other row uses. */
  const candidates = (current?: number) => fields.filter((field) => field.id === current || !used.has(field.id));

  const update = (index: number, patch: Partial<FieldValueRow>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const add = () => {
    const field = candidates()[0];
    if (field) onChange([...rows, newFieldValueRow(field)]);
  };

  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="text-xs text-fg-faint">{copy.none}</p>}
      {rows.map((row, index) => {
        const field = byId.get(row.fieldId);
        if (!field) return null;
        const token = FIELD_VALUE_TOKEN_FOR[field.type];
        return (
          <div
            key={`${row.fieldId}-${index}`}
            className="flex flex-col gap-2 rounded-md border border-edge p-2 sm:flex-row sm:items-start"
          >
            <div className="sm:w-48 sm:shrink-0">
              <Select
                aria-label={copy.field}
                value={String(row.fieldId)}
                disabled={disabled}
                onChange={(event) => {
                  const next = byId.get(Number(event.target.value));
                  if (next) update(index, newFieldValueRow(next));
                }}
              >
                {candidates(row.fieldId).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </div>
            {token && (
              <div className="sm:w-48 sm:shrink-0">
                <Select
                  aria-label={copy.value}
                  value={row.mode}
                  disabled={disabled}
                  onChange={(event) => update(index, { mode: event.target.value as FieldValueRow['mode'] })}
                >
                  <option value="token">{copy.tokens[token]}</option>
                  <option value="fixed">{copy.fixed}</option>
                </Select>
              </div>
            )}
            <div className="min-w-0 flex-1">
              {(row.mode === 'fixed' || !token) && (
                <FieldEditor
                  field={field}
                  value={row.draft}
                  onChange={(draft) => update(index, { draft })}
                  users={users}
                  emptyLabel={emptyLabel}
                  disabled={disabled}
                />
              )}
            </div>
            <IconButton
              variant="destructive"
              size="compact"
              label={copy.remove}
              disabled={disabled}
              onClick={() => onChange(rows.filter((_, at) => at !== index))}
            >
              <Trash2 size={13} />
            </IconButton>
          </div>
        );
      })}
      {candidates().length > 0 ? (
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={add}>
          <Plus size={13} className="mr-1.5" />
          {copy.add}
        </Button>
      ) : (
        rows.length === 0 && copy.noFields && <p className="text-xs text-fg-faint">{copy.noFields}</p>
      )}
    </div>
  );
}
