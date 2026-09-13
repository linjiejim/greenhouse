import React, { useEffect, useState } from 'react';
import type { TableFieldConfig, TableRecordValues } from '@greenhouse/types/tables';
import { Button, Checkbox, Dialog, Input, Select, Textarea } from '../../components/ui';
import { safeParse } from '../../lib/utils';
import type { TableField, TableRecord } from '../../lib/api/tables';
import { AttachmentPicker } from './attachment-picker';
import { useT } from '../../lib/i18n';

interface RecordDialogProps {
  open: boolean;
  baseId: number;
  fields: TableField[];
  record?: TableRecord | null;
  users: Array<{ id: string; nickname: string; email: string }>;
  saving: boolean;
  onClose: () => void;
  onSave: (values: TableRecordValues) => Promise<void>;
}

function initialValue(field: TableField, value: unknown): unknown {
  if (field.type === 'datetime' && typeof value === 'string') return value.slice(0, 16);
  if (field.type === 'multi_select' || field.type === 'multi_user' || field.type === 'attachment') {
    return Array.isArray(value) ? value : [];
  }
  if (field.type === 'boolean') return value === true;
  if (field.type === 'relation') {
    const config = safeParse<TableFieldConfig>(field.config, {});
    return config.relation?.multiple ? (Array.isArray(value) ? value : []) : (value ?? '');
  }
  return value ?? '';
}

function FieldLabel({ field }: { field: TableField }) {
  return (
    <label className="mb-1 block text-xs font-medium text-fg-muted">
      {field.name}
      {field.required && <span className="ml-1 text-danger">*</span>}
    </label>
  );
}

export function RecordDialog({ open, baseId, fields, record, users, saving, onClose, onSave }: RecordDialogProps) {
  const t = useT();
  const [values, setValues] = useState<TableRecordValues>({});
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setValues(
      Object.fromEntries(
        fields.map((field) => [
          String(field.id),
          initialValue(
            field,
            record?.computed_values[String(field.id)] === undefined
              ? record?.values[String(field.id)]
              : record.computed_values[String(field.id)],
          ),
        ]),
      ),
    );
    setError('');
  }, [fields, open, record]);

  const setValue = (fieldId: number, value: unknown) => {
    setValues((current) => ({ ...current, [String(fieldId)]: value }));
  };

  const toggleArrayValue = (fieldId: number, value: string, checked: boolean) => {
    const key = String(fieldId);
    const current = Array.isArray(values[key]) ? (values[key] as string[]) : [];
    setValue(fieldId, checked ? [...new Set([...current, value])] : current.filter((entry) => entry !== value));
  };

  const normalizedValues = (): TableRecordValues => {
    const result: TableRecordValues = {};
    for (const field of fields) {
      if (field.type === 'formula' || field.type === 'rollup') continue;
      const key = String(field.id);
      const value = values[key];
      if (field.type === 'number') {
        if (value !== '') result[key] = Number(value);
        else if (record) result[key] = null;
      } else if (field.type === 'datetime') {
        if (typeof value === 'string' && value) result[key] = new Date(value).toISOString();
        else if (record) result[key] = null;
      } else if (field.type === 'attachment') {
        result[key] = Array.isArray(value) ? value : [];
      } else if (field.type === 'relation') {
        const config = safeParse<TableFieldConfig>(field.config, {});
        if (config.relation?.multiple) result[key] = Array.isArray(value) ? value : [];
        else if (value !== '') result[key] = Number(value);
        else if (record) result[key] = null;
      } else if (field.type === 'boolean') {
        result[key] = value === true;
      } else if (value !== '') {
        result[key] = value;
      } else if (record) {
        result[key] = null;
      }
    }
    return result;
  };

  const submit = async () => {
    setError('');
    try {
      await onSave(normalizedValues());
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.saveRecordFailed'));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={record ? t('tables.editRecordNumber', { id: record.id }) : t('tables.newRecord')}
      size="lg"
    >
      <div className="space-y-4">
        {fields.map((field) => {
          const key = String(field.id);
          const value = values[key];
          const config = safeParse<TableFieldConfig>(field.config, {});

          if (field.type === 'formula' || field.type === 'rollup') {
            return (
              <div key={field.id}>
                <FieldLabel field={field} />
                <div className="rounded-md border border-edge bg-surface-sunken px-3 py-2 text-sm text-fg-secondary">
                  {value === null || value === undefined || value === ''
                    ? '—'
                    : Array.isArray(value)
                      ? value.join(', ')
                      : String(value)}
                </div>
                <p className="mt-1 text-[11px] text-fg-faint">{t('tables.computedReadOnly')}</p>
              </div>
            );
          }

          if (field.type === 'boolean') {
            return (
              <Checkbox
                key={field.id}
                label={field.name}
                checked={value === true}
                onChange={(event) => setValue(field.id, event.target.checked)}
              />
            );
          }

          if (field.type === 'long_text') {
            return (
              <div key={field.id}>
                <FieldLabel field={field} />
                <Textarea
                  rows={4}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(event) => setValue(field.id, event.target.value)}
                />
              </div>
            );
          }

          if (field.type === 'single_select') {
            return (
              <div key={field.id}>
                <FieldLabel field={field} />
                <Select
                  value={typeof value === 'string' ? value : ''}
                  onChange={(event) => setValue(field.id, event.target.value)}
                >
                  <option value="">—</option>
                  {(config.options ?? []).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
            );
          }

          if (field.type === 'multi_select') {
            const selected = Array.isArray(value) ? (value as string[]) : [];
            return (
              <div key={field.id}>
                <FieldLabel field={field} />
                <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-md border border-edge px-3 py-2">
                  {(config.options ?? []).map((option) => (
                    <Checkbox
                      key={option.id}
                      label={option.label}
                      checked={selected.includes(option.id)}
                      onChange={(event) => toggleArrayValue(field.id, option.id, event.target.checked)}
                    />
                  ))}
                  {(config.options ?? []).length === 0 && (
                    <span className="text-xs text-fg-faint">{t('tables.addOptionsFirst')}</span>
                  )}
                </div>
              </div>
            );
          }

          if (field.type === 'user') {
            return (
              <div key={field.id}>
                <FieldLabel field={field} />
                <Select
                  value={typeof value === 'string' ? value : ''}
                  onChange={(event) => setValue(field.id, event.target.value)}
                >
                  <option value="">—</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.nickname} · {user.email}
                    </option>
                  ))}
                </Select>
              </div>
            );
          }

          if (field.type === 'multi_user') {
            const selected = Array.isArray(value) ? (value as string[]) : [];
            return (
              <div key={field.id}>
                <FieldLabel field={field} />
                <div className="grid max-h-40 grid-cols-1 gap-2 overflow-y-auto rounded-md border border-edge px-3 py-2 sm:grid-cols-2">
                  {users.map((user) => (
                    <Checkbox
                      key={user.id}
                      label={user.nickname}
                      checked={selected.includes(user.id)}
                      onChange={(event) => toggleArrayValue(field.id, user.id, event.target.checked)}
                    />
                  ))}
                </div>
              </div>
            );
          }

          if (field.type === 'attachment') {
            const attachments = Array.isArray(value) ? (value as Array<number | string>) : [];
            return (
              <div key={field.id}>
                <FieldLabel field={field} />
                <AttachmentPicker baseId={baseId} value={attachments} onChange={(next) => setValue(field.id, next)} />
              </div>
            );
          }

          if (field.type === 'relation') {
            const multiple = config.relation?.multiple === true;
            const relationValue = multiple
              ? Array.isArray(value)
                ? (value as number[]).join(', ')
                : ''
              : typeof value === 'number'
                ? String(value)
                : '';
            return (
              <div key={field.id}>
                <FieldLabel field={field} />
                <Input
                  value={relationValue}
                  placeholder={multiple ? t('tables.recordIdsPlaceholder') : t('tables.recordIdPlaceholder')}
                  onChange={(event) => {
                    if (!multiple) {
                      setValue(field.id, event.target.value);
                      return;
                    }
                    setValue(
                      field.id,
                      event.target.value
                        .split(',')
                        .map((entry) => Number(entry.trim().replace(/^#/, '')))
                        .filter((entry) => Number.isInteger(entry) && entry > 0),
                    );
                  }}
                />
              </div>
            );
          }

          const inputType =
            field.type === 'number'
              ? 'number'
              : field.type === 'date'
                ? 'date'
                : field.type === 'datetime'
                  ? 'datetime-local'
                  : field.type === 'email'
                    ? 'email'
                    : field.type === 'url'
                      ? 'url'
                      : field.type === 'phone'
                        ? 'tel'
                        : 'text';
          return (
            <div key={field.id}>
              <FieldLabel field={field} />
              <Input
                type={inputType}
                step={field.type === 'number' ? 'any' : undefined}
                value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                onChange={(event) => setValue(field.id, event.target.value)}
              />
            </div>
          );
        })}

        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex items-center justify-between border-t border-edge pt-4">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? t('common.saving') : t('tables.saveRecord')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
