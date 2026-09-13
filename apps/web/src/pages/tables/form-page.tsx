import React, { useEffect, useState } from 'react';
import type { TableFieldConfig, TableRecordValues } from '@greenhouse/types/tables';
import { Button, Checkbox, EmptyState, Input, Select, Spinner, Textarea } from '../../components/ui';
import { CheckCircle2, ClipboardList } from '../../lib/icons';
import { getTableForm, listTableUsers, submitTableForm, type TableField, type TableForm } from '../../lib/api/tables';
import { safeParse } from '../../lib/utils';
import { useT } from '../../lib/i18n';

type UserOption = { id: string; nickname: string; email: string };

function FormControl({
  field,
  users,
  value,
  onChange,
}: {
  field: TableField;
  users: UserOption[];
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const t = useT();
  const config = safeParse<TableFieldConfig>(field.config, {});
  const label = (
    <label className="mb-1.5 block text-sm font-medium text-fg">
      {field.name}
      {field.required && <span className="ml-1 text-danger">*</span>}
    </label>
  );
  if (field.type === 'boolean') {
    return (
      <Checkbox label={field.name} checked={value === true} onChange={(event) => onChange(event.target.checked)} />
    );
  }
  if (field.type === 'long_text') {
    return (
      <div>
        {label}
        <Textarea
          rows={4}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  }
  if (field.type === 'single_select') {
    return (
      <div>
        {label}
        <Select value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('tables.forms.choose')}</option>
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
      <div>
        {label}
        <div className="flex flex-wrap gap-3 rounded-md border border-edge p-3">
          {(config.options ?? []).map((option) => (
            <Checkbox
              key={option.id}
              label={option.label}
              checked={selected.includes(option.id)}
              onChange={(event) =>
                onChange(event.target.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id))
              }
            />
          ))}
        </div>
      </div>
    );
  }
  if (field.type === 'user') {
    return (
      <div>
        {label}
        <Select value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('tables.forms.choose')}</option>
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
      <div>
        {label}
        <div className="grid grid-cols-1 gap-2 rounded-md border border-edge p-3 sm:grid-cols-2">
          {users.map((user) => (
            <Checkbox
              key={user.id}
              label={user.nickname}
              checked={selected.includes(user.id)}
              onChange={(event) =>
                onChange(event.target.checked ? [...selected, user.id] : selected.filter((id) => id !== user.id))
              }
            />
          ))}
        </div>
      </div>
    );
  }
  if (field.type === 'relation') {
    const multiple = config.relation?.multiple === true;
    return (
      <div>
        {label}
        <Input
          value={Array.isArray(value) ? value.join(', ') : String(value ?? '')}
          placeholder={multiple ? t('tables.forms.recordIdsPlaceholder') : t('tables.forms.recordIdPlaceholder')}
          onChange={(event) =>
            onChange(
              multiple
                ? event.target.value
                    .split(',')
                    .map((entry) => Number(entry.trim()))
                    .filter((id) => Number.isInteger(id) && id > 0)
                : event.target.value,
            )
          }
        />
      </div>
    );
  }
  const type =
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
    <div>
      {label}
      <Input
        type={type}
        step={field.type === 'number' ? 'any' : undefined}
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function TablesFormPage({ formId }: { formId: number }) {
  const t = useT();
  const [form, setForm] = useState<TableForm | null>(null);
  const [fields, setFields] = useState<TableField[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [values, setValues] = useState<TableRecordValues>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    getTableForm(formId)
      .then(async (result) => {
        const nextUsers = await listTableUsers();
        setForm(result.form);
        setFields(result.fields);
        setUsers(nextUsers);
        setError('');
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : t('tables.forms.loadOneFailed')))
      .finally(() => setLoading(false));
  }, [formId, t]);

  const normalize = (): TableRecordValues => {
    const result: TableRecordValues = {};
    for (const field of fields) {
      const key = String(field.id);
      const value = values[key];
      if (value === undefined || value === '') continue;
      if (field.type === 'number') result[key] = Number(value);
      else if (field.type === 'datetime') result[key] = new Date(String(value)).toISOString();
      else if (field.type === 'relation' && !Array.isArray(value)) result[key] = Number(value);
      else result[key] = value;
    }
    return result;
  };

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      await submitTableForm(formId, normalize());
      setSubmitted(true);
      setValues({});
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t('tables.forms.submitFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  if (!form)
    return (
      <EmptyState
        icon={ClipboardList}
        title={t('tables.forms.unavailable')}
        description={error || t('tables.forms.notFound')}
      />
    );
  if (form.status !== 'published')
    return (
      <EmptyState
        icon={ClipboardList}
        title={t('tables.forms.notPublished')}
        description={t('tables.forms.notPublishedHint')}
      />
    );
  if (submitted) {
    return (
      <div className="h-full overflow-y-auto bg-surface-canvas px-4 py-12">
        <div className="mx-auto max-w-xl rounded-xl border border-edge bg-surface-raised p-8 text-center shadow-sm">
          <CheckCircle2 size={36} className="mx-auto text-success" />
          <h1 className="mt-4 text-xl font-semibold text-fg">{t('tables.forms.responseRecordedTitle')}</h1>
          <p className="mt-2 text-sm text-fg-muted">
            {form.config.successMessage ?? t('tables.forms.responseRecorded')}
          </p>
          <Button className="mt-6" onClick={() => setSubmitted(false)}>
            {t('tables.forms.submitAnother')}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto bg-surface-canvas px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-2xl rounded-xl border border-edge bg-surface-raised p-5 shadow-sm sm:p-8">
        <div className="mb-7 border-b border-edge pb-5">
          <div className="mb-2 flex items-center gap-2 text-primary-fg">
            <ClipboardList size={18} />
            <span className="text-xs font-semibold uppercase tracking-wider">{t('tables.forms.internalForm')}</span>
          </div>
          <h1 className="text-2xl font-semibold text-fg">{form.config.title ?? form.name}</h1>
          {form.config.description && <p className="mt-2 text-sm leading-6 text-fg-muted">{form.config.description}</p>}
        </div>
        <div className="space-y-5">
          {fields.map((field) => (
            <FormControl
              key={field.id}
              field={field}
              users={users}
              value={values[String(field.id)]}
              onChange={(value) => setValues((current) => ({ ...current, [String(field.id)]: value }))}
            />
          ))}
          {error && <p className="rounded-md bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</p>}
          <div className="flex justify-end border-t border-edge pt-5">
            <Button disabled={saving} onClick={() => void submit()}>
              {saving ? t('tables.forms.submitting') : (form.config.submitLabel ?? t('tables.forms.submit'))}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
