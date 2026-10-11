/**
 * The one editing control per Tables field type. The record dialog, inline
 * grid cells and the form page all render this — there is no second copy of
 * "how do you edit a multi-user field".
 *
 * It edits a draft (see ./field-draft): `toFieldDraft` before, `fromFieldDraft`
 * after. `density="form"` is the full control for dialogs and pages;
 * `density="inline"` is the compact control inside a grid cell, which also
 * owns the cell's commit gestures (Enter / blur for typed values, a pick for
 * discrete ones, Escape to cancel) through `onCommit` / `onCancel`.
 */

import React, { useState } from 'react';
import { Checkbox, Input, Select, Textarea } from '../ui';
import type { TableField, TableUserOption } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';
import { AttachmentPicker } from './attachment-picker';
import { AttachmentUploader, type AttachmentUpload } from './attachment-uploader';
import { fieldConfig, isComputedField } from './field-types';
import { fromFieldDraft, toFieldDraft, type FieldDraft } from './field-draft';
import { InlineMultiSelectEditor } from './inline-multi-select-editor';

export interface FieldEditorProps {
  /** A schema field, or a form's submit-view field shaped like one (only these four are read). */
  field: Pick<TableField, 'id' | 'name' | 'type' | 'config'>;
  value: FieldDraft;
  onChange: (value: FieldDraft) => void;
  users: TableUserOption[];
  /** Attachment fields pick from this Base's files; without it (or `uploadAttachment`) they are not editable here. */
  baseId?: number;
  /**
   * Upload-only attachments for people who cannot browse the Base's Drive (a
   * form's audience): files go through this and their ids become the value.
   * Takes precedence over `baseId`.
   */
  uploadAttachment?: AttachmentUpload;
  /** Attachment fields: an upload started / finished. Hosts disable their submit while one is in flight. */
  onBusyChange?: (busy: boolean) => void;
  /**
   * Relation fields: pick from these records instead of typing ids — for
   * writers who cannot browse the target table (an app's viewers; the gateway
   * lists only records in their read scope).
   */
  relationOptions?: ReadonlyArray<{ value: number; label: string }>;
  density?: 'form' | 'inline';
  /** Shown as the empty choice of single-value pickers. Default `—`. */
  emptyLabel?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Inline density: commit this draft (Enter, blur, or a discrete pick). */
  onCommit?: (value: FieldDraft) => void;
  /** Inline density: abandon the edit (Escape, or leaving a picker untouched). */
  onCancel?: () => void;
  /** Forwarded by `FormField`. */
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
}

const INPUT_TYPES: Partial<Record<TableField['type'], string>> = {
  number: 'number',
  date: 'date',
  datetime: 'datetime-local',
  email: 'email',
  url: 'url',
  phone: 'tel',
};

/** Boolean editors carry their own label (a checkbox reads as one control); callers skip the outer label. */
export function fieldEditorOwnsLabel(field: Pick<TableField, 'type'>): boolean {
  return field.type === 'boolean';
}

/** Whether a grid cell may switch into this editor. Computed fields never; attachments open the record dialog. */
export function isInlineEditable(field: Pick<TableField, 'type'>): boolean {
  return !isComputedField(field) && field.type !== 'attachment';
}

export function FieldEditor({
  field,
  value,
  onChange,
  users,
  baseId,
  uploadAttachment,
  onBusyChange,
  relationOptions,
  density = 'form',
  emptyLabel = '—',
  disabled = false,
  autoFocus = false,
  onCommit,
  onCancel,
  id,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: FieldEditorProps) {
  const t = useT();
  const inline = density === 'inline';
  const size = inline ? 'sm' : 'md';
  const config = fieldConfig(field);
  const a11y = { id, 'aria-describedby': describedBy, 'aria-invalid': invalid };

  if (isComputedField(field)) return null;

  const pick = (next: FieldDraft) => {
    onChange(next);
    if (inline) onCommit?.(next);
  };

  const textKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    if (!inline) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel?.();
    } else if (event.key === 'Enter' && event.currentTarget.tagName !== 'SELECT') {
      event.preventDefault();
      onCommit?.(value);
    }
  };

  // A cell editor must not bubble its clicks to the row (which opens the record).
  const stop = inline ? (event: React.MouseEvent) => event.stopPropagation() : undefined;

  if (field.type === 'boolean') {
    return (
      <Checkbox
        {...a11y}
        label={inline ? undefined : field.name}
        aria-label={inline ? field.name : undefined}
        autoFocus={autoFocus}
        checked={value === true}
        disabled={disabled}
        onClick={stop}
        onChange={(event) => pick(event.target.checked)}
        onBlur={inline ? () => onCancel?.() : undefined}
        onKeyDown={textKeyDown}
      />
    );
  }

  if (field.type === 'single_select' || field.type === 'user') {
    const options =
      field.type === 'single_select'
        ? (config.options ?? []).map((option) => ({ value: option.id, label: option.label }))
        : users.map((user) => ({
            value: user.id,
            label: inline || !user.email ? user.nickname : `${user.nickname} · ${user.email}`,
          }));
    return (
      <Select
        {...a11y}
        size={size}
        aria-label={inline ? field.name : undefined}
        autoFocus={autoFocus}
        disabled={disabled}
        value={typeof value === 'string' ? value : ''}
        onClick={stop}
        onChange={(event) => pick(event.target.value)}
        onBlur={inline ? () => onCancel?.() : undefined}
        onKeyDown={textKeyDown}
      >
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  }

  if (field.type === 'multi_select' || field.type === 'multi_user') {
    const selected = Array.isArray(value) ? value.map(String) : [];
    const options =
      field.type === 'multi_select'
        ? (config.options ?? []).map((option) => ({ value: option.id, label: option.label }))
        : users.map((user) => ({ value: user.id, label: user.nickname }));
    if (inline) {
      return (
        <InlineMultiSelectEditor
          label={field.name}
          selected={selected}
          options={options}
          allowCustomOptions={false}
          saving={disabled}
          error=""
          onCancel={() => onCancel?.()}
          onApply={(next) => pick(next)}
        />
      );
    }
    const toggle = (optionValue: string, checked: boolean) =>
      onChange(checked ? [...new Set([...selected, optionValue])] : selected.filter((entry) => entry !== optionValue));
    return (
      <div
        id={id}
        role="group"
        aria-label={field.name}
        aria-describedby={describedBy}
        className={
          field.type === 'multi_user'
            ? 'grid max-h-40 grid-cols-1 gap-2 overflow-y-auto rounded-md border border-edge px-3 py-2 sm:grid-cols-2'
            : 'flex flex-wrap gap-x-4 gap-y-2 rounded-md border border-edge px-3 py-2'
        }
      >
        {options.map((option) => (
          <Checkbox
            key={option.value}
            label={option.label}
            checked={selected.includes(option.value)}
            disabled={disabled}
            onChange={(event) => toggle(option.value, event.target.checked)}
          />
        ))}
        {options.length === 0 && (
          <span className="text-xs text-fg-faint">
            {field.type === 'multi_select' ? t('tables.addOptionsFirst') : emptyLabel}
          </span>
        )}
      </div>
    );
  }

  if (field.type === 'attachment') {
    const attachments = Array.isArray(value) ? (value as Array<number | string>) : [];
    if (inline) return null;
    if (uploadAttachment) {
      return (
        <AttachmentUploader
          id={id}
          aria-describedby={describedBy}
          label={field.name}
          value={attachments}
          onChange={(next) => onChange(next)}
          upload={uploadAttachment}
          disabled={disabled}
          onBusyChange={onBusyChange}
        />
      );
    }
    if (baseId === undefined) return null;
    return (
      <AttachmentPicker
        baseId={baseId}
        value={attachments}
        onChange={(next) => onChange(next)}
        onBusyChange={onBusyChange}
      />
    );
  }

  if (field.type === 'long_text' && !inline) {
    return (
      <Textarea
        {...a11y}
        rows={4}
        autoFocus={autoFocus}
        disabled={disabled}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  const multipleRelation = field.type === 'relation' && config.relation?.multiple === true;
  if (field.type === 'relation' && relationOptions && !inline) {
    // The draft stays the id text `fromFieldDraft` parses ("12" / "12, 13").
    const picked = (typeof value === 'string' ? value : '')
      .split(/[,;\s]+/)
      .map((entry) => entry.trim().replace(/^#/, ''))
      .filter(Boolean);
    if (!multipleRelation) {
      return (
        <Select
          {...a11y}
          size={size}
          disabled={disabled}
          value={picked[0] ?? ''}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{emptyLabel}</option>
          {relationOptions.map((option) => (
            <option key={option.value} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </Select>
      );
    }
    const toggle = (id: string, checked: boolean) =>
      onChange((checked ? [...new Set([...picked, id])] : picked.filter((entry) => entry !== id)).join(', '));
    return (
      <div
        id={id}
        role="group"
        aria-label={field.name}
        aria-describedby={describedBy}
        className="grid max-h-40 grid-cols-1 gap-2 overflow-y-auto rounded-md border border-edge px-3 py-2 sm:grid-cols-2"
      >
        {relationOptions.map((option) => (
          <Checkbox
            key={option.value}
            label={option.label}
            checked={picked.includes(String(option.value))}
            disabled={disabled}
            onChange={(event) => toggle(String(option.value), event.target.checked)}
          />
        ))}
        {relationOptions.length === 0 && <span className="text-xs text-fg-faint">{emptyLabel}</span>}
      </div>
    );
  }
  return (
    <Input
      {...a11y}
      size={size}
      aria-label={inline ? field.name : undefined}
      type={INPUT_TYPES[field.type] ?? 'text'}
      step={field.type === 'number' ? 'any' : undefined}
      autoFocus={autoFocus}
      disabled={disabled}
      placeholder={
        field.type === 'relation'
          ? t(multipleRelation ? 'tables.recordIdsPlaceholder' : 'tables.recordIdPlaceholder')
          : undefined
      }
      value={typeof value === 'string' ? value : ''}
      onClick={stop}
      onChange={(event) => onChange(event.target.value)}
      onBlur={inline ? () => onCommit?.(value) : undefined}
      onKeyDown={textKeyDown}
    />
  );
}

/**
 * A grid cell's editor: holds the draft for one stored value and hands the
 * parsed result to `onCommit` (the cell compares and saves).
 */
export function InlineFieldEditor({
  field,
  stored,
  users,
  saving,
  onCommit,
  onCancel,
}: {
  field: TableField;
  stored: unknown;
  users: TableUserOption[];
  saving: boolean;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<FieldDraft>(() => toFieldDraft(field, stored));
  return (
    <FieldEditor
      field={field}
      value={draft}
      onChange={setDraft}
      users={users}
      density="inline"
      autoFocus
      disabled={saving}
      onCommit={(next) => onCommit(fromFieldDraft(field, next))}
      onCancel={onCancel}
    />
  );
}
