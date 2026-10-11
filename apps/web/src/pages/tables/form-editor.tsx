/**
 * Create / edit one form (inside the forms dialog): the shown fields, who can
 * fill it in (Base members / everyone / chosen people and groups through the
 * shared `PrincipalPicker`), hidden prefilled values and single submission.
 * The server re-validates all of it; the editor only keeps people from saving
 * what it would refuse (relation fields outside Base audiences, a field both
 * shown and prefilled, a prefilled field with no value).
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { TableFieldType, TableFormAudience, TableFormConfig } from '@greenhouse/types/tables';
import { Button, Checkbox, IconButton, Input, Select, Textarea, Toggle } from '../../components/ui';
import { FormActions, FormError, FormField, FormSection } from '../../components/form';
import { FieldEditor } from '../../components/tables/field-editor';
import { fromFieldDraft, toFieldDraft, type FieldDraft } from '../../components/tables/field-draft';
import { isComputedField } from '../../components/tables/field-types';
import { PrincipalPicker, type PrincipalSelection } from '../../components/tables/principal-picker';
import { Plus, Trash2 } from '../../lib/icons';
import {
  createTableForm,
  listTableUsers,
  updateTableForm,
  type TableField,
  type TableForm,
  type TableUserOption,
} from '../../lib/api/tables';
import { useT, type TranslationKey } from '../../lib/i18n';

type AudienceKind = TableFormAudience['type'];
type DefaultToken = '$me' | '$today' | '$now';

/** The server-resolved token each field type may default to (spec §3). */
const TOKEN_FOR: Partial<Record<TableFieldType, DefaultToken>> = {
  user: '$me',
  multi_user: '$me',
  date: '$today',
  datetime: '$now',
};

const TOKEN_LABEL: Record<DefaultToken, TranslationKey> = {
  $me: 'tables.forms.defaults.me',
  $today: 'tables.forms.defaults.today',
  $now: 'tables.forms.defaults.now',
};

interface DefaultDraft {
  fieldId: number;
  /** `token` = the field type's `TOKEN_FOR`; `fixed` = `draft`. */
  mode: 'token' | 'fixed';
  draft: FieldDraft;
}

function readDefaults(config: TableFormConfig | undefined, byId: Map<number, TableField>): DefaultDraft[] {
  const raw: unknown = config?.defaults;
  const entries = Array.isArray(raw)
    ? (raw as Array<{ fieldId: number; value: unknown }>)
    : raw && typeof raw === 'object'
      ? Object.entries(raw).map(([fieldId, value]) => ({ fieldId: Number(fieldId), value }))
      : [];
  return entries.flatMap((entry): DefaultDraft[] => {
    const field = byId.get(entry.fieldId);
    if (!field) return [];
    const token = TOKEN_FOR[field.type];
    return token && entry.value === token
      ? [{ fieldId: field.id, mode: 'token', draft: '' }]
      : [{ fieldId: field.id, mode: 'fixed', draft: toFieldDraft(field, entry.value) }];
  });
}

function prefillable(field: TableField): boolean {
  return !isComputedField(field) && field.type !== 'attachment';
}

export function TablesFormEditor({
  tableId,
  fields,
  form,
  onSaved,
  onCancel,
}: {
  tableId: number;
  fields: TableField[];
  form?: TableForm;
  onSaved: (form: TableForm) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const byId = useMemo(() => new Map(fields.map((field) => [field.id, field])), [fields]);
  const writable = useMemo(() => fields.filter((field) => !isComputedField(field)), [fields]);
  const [name, setName] = useState(form?.name ?? '');
  const [title, setTitle] = useState(form?.config.title ?? '');
  const [description, setDescription] = useState(form?.config.description ?? '');
  const [successMessage, setSuccessMessage] = useState(form?.config.successMessage ?? '');
  const [audience, setAudience] = useState<AudienceKind>(form?.audience.type ?? 'base');
  const [principals, setPrincipals] = useState<PrincipalSelection>(
    form?.audience.type === 'principals'
      ? { userIds: form.audience.userIds, groupIds: form.audience.groupIds }
      : { userIds: [], groupIds: [] },
  );
  const [defaults, setDefaults] = useState<DefaultDraft[]>(() => readDefaults(form?.config, byId));
  const [fieldIds, setFieldIds] = useState<number[]>(
    () =>
      form?.config.fieldIds ??
      writable.filter((field) => field.type !== 'relation' || audience === 'base').map((field) => field.id),
  );
  const [allowMultiple, setAllowMultiple] = useState(form?.config.allowMultiple !== false);
  const [users, setUsers] = useState<TableUserOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    listTableUsers()
      .then((loaded) => !cancelled && setUsers(loaded))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const outsideBase = audience !== 'base';
  const prefilledIds = new Set(defaults.map((entry) => entry.fieldId));
  const candidates = (current?: number) =>
    fields.filter(
      (field) =>
        prefillable(field) && !fieldIds.includes(field.id) && (field.id === current || !prefilledIds.has(field.id)),
    );

  const changeAudience = (next: AudienceKind) => {
    setAudience(next);
    // Linked records only make sense to people who can read the Base.
    if (next !== 'base') setFieldIds((current) => current.filter((id) => byId.get(id)?.type !== 'relation'));
  };

  const toggleField = (fieldId: number, checked: boolean) => {
    setFieldIds((current) => (checked ? [...current, fieldId] : current.filter((id) => id !== fieldId)));
    if (checked) setDefaults((current) => current.filter((entry) => entry.fieldId !== fieldId));
  };

  const updateDefault = (index: number, patch: Partial<DefaultDraft>) =>
    setDefaults((current) => current.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)));

  const addDefault = () => {
    const field = candidates()[0];
    if (!field) return;
    setDefaults((current) => [
      ...current,
      { fieldId: field.id, mode: TOKEN_FOR[field.type] ? 'token' : 'fixed', draft: toFieldDraft(field, null) },
    ]);
  };

  const defaultValues = (): TableFormConfig['defaults'] | null => {
    const values: NonNullable<TableFormConfig['defaults']> = [];
    for (const entry of defaults) {
      const field = byId.get(entry.fieldId);
      if (!field) continue;
      const token = TOKEN_FOR[field.type];
      const value = entry.mode === 'token' && token ? token : fromFieldDraft(field, entry.draft);
      if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return null;
      values.push({ fieldId: field.id, value });
    }
    return values;
  };

  const save = async () => {
    setError('');
    if (fieldIds.length === 0) return setError(t('tables.forms.fieldsRequired'));
    if (audience === 'principals' && principals.userIds.length + principals.groupIds.length === 0) {
      return setError(t('tables.forms.audience.pickRequired'));
    }
    const prefilled = defaultValues();
    if (!prefilled) return setError(t('tables.forms.defaults.valueRequired'));
    const config: TableFormConfig = {
      version: 1,
      title: title.trim() || name.trim(),
      description: description.trim(),
      fieldIds,
      submitLabel: form?.config.submitLabel || t('tables.forms.submit'),
      successMessage: successMessage.trim() || t('tables.forms.responseRecorded'),
      defaults: prefilled,
      allowMultiple,
    };
    const nextAudience: TableFormAudience =
      audience === 'principals' ? { type: 'principals', ...principals } : { type: audience };
    setSaving(true);
    try {
      const saved = form
        ? await updateTableForm(form.id, { revision: form.revision, name: name.trim(), config, audience: nextAudience })
        : await createTableForm(tableId, { name: name.trim(), status: 'draft', config, audience: nextAudience });
      onSaved(saved);
    } catch (saveError) {
      const fallback = form ? 'tables.forms.updateFailed' : 'tables.forms.createFailed';
      setError(saveError instanceof Error ? saveError.message : t(fallback));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="form-editor">
      <FormField label={t('tables.forms.internalName')} required>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('tables.forms.internalNamePlaceholder')}
          data-testid="form-name-input"
        />
      </FormField>
      <FormField label={t('tables.forms.formTitle')}>
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('tables.forms.formTitlePlaceholder')}
        />
      </FormField>
      <FormField label={t('common.description')}>
        <Textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
      </FormField>

      <FormSection title={t('tables.forms.audience.title')} description={t(`tables.forms.audience.${audience}Hint`)}>
        <Select
          aria-label={t('tables.forms.audience.title')}
          value={audience}
          onChange={(event) => changeAudience(event.target.value as AudienceKind)}
          data-testid="form-audience-select"
        >
          <option value="base">{t('tables.forms.audience.base')}</option>
          <option value="team">{t('tables.forms.audience.team')}</option>
          <option value="principals">{t('tables.forms.audience.principals')}</option>
        </Select>
        {audience === 'principals' && (
          <div className="mt-3">
            <PrincipalPicker value={principals} onChange={setPrincipals} allowGroups />
          </div>
        )}
      </FormSection>

      <FormSection
        title={t('tables.forms.publishedFields')}
        description={
          outsideBase && writable.some((field) => field.type === 'relation')
            ? t('tables.forms.relationBaseOnly')
            : undefined
        }
      >
        <div
          role="group"
          aria-label={t('tables.forms.publishedFields')}
          className="grid max-h-48 grid-cols-1 gap-2 overflow-y-auto rounded-md border border-edge bg-surface-raised p-3 sm:grid-cols-2"
        >
          {writable.map((field) => (
            <Checkbox
              key={field.id}
              label={field.name}
              checked={fieldIds.includes(field.id)}
              disabled={outsideBase && field.type === 'relation'}
              onChange={(event) => toggleField(field.id, event.target.checked)}
            />
          ))}
        </div>
      </FormSection>

      <FormSection title={t('tables.forms.defaults.title')} description={t('tables.forms.defaults.description')}>
        <div className="space-y-2">
          {defaults.length === 0 && <p className="text-xs text-fg-faint">{t('tables.forms.defaults.none')}</p>}
          {defaults.map((entry, index) => {
            const field = byId.get(entry.fieldId);
            if (!field) return null;
            const token = TOKEN_FOR[field.type];
            return (
              <div
                key={`${entry.fieldId}-${index}`}
                className="flex flex-col gap-2 rounded-md border border-edge p-2 sm:flex-row sm:items-start"
              >
                <div className="sm:w-48 sm:shrink-0">
                  <Select
                    aria-label={t('tables.forms.defaults.field')}
                    value={String(entry.fieldId)}
                    onChange={(event) => {
                      const next = byId.get(Number(event.target.value));
                      if (!next) return;
                      updateDefault(index, {
                        fieldId: next.id,
                        mode: TOKEN_FOR[next.type] ? 'token' : 'fixed',
                        draft: toFieldDraft(next, null),
                      });
                    }}
                  >
                    {candidates(entry.fieldId).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </Select>
                </div>
                {token && (
                  <div className="sm:w-48 sm:shrink-0">
                    <Select
                      aria-label={t('tables.forms.defaults.value')}
                      value={entry.mode}
                      onChange={(event) => updateDefault(index, { mode: event.target.value as DefaultDraft['mode'] })}
                    >
                      <option value="token">{t(TOKEN_LABEL[token])}</option>
                      <option value="fixed">{t('tables.forms.defaults.fixed')}</option>
                    </Select>
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  {(entry.mode === 'fixed' || !token) && (
                    <FieldEditor
                      field={field}
                      value={entry.draft}
                      onChange={(draft) => updateDefault(index, { draft })}
                      users={users}
                      emptyLabel={t('tables.forms.choose')}
                    />
                  )}
                </div>
                <IconButton
                  variant="destructive"
                  size="compact"
                  label={t('tables.forms.defaults.remove')}
                  onClick={() => setDefaults((current) => current.filter((_, at) => at !== index))}
                >
                  <Trash2 size={13} />
                </IconButton>
              </div>
            );
          })}
          {candidates().length > 0 ? (
            <Button type="button" variant="outline" size="sm" onClick={addDefault}>
              <Plus size={13} className="mr-1.5" />
              {t('tables.forms.defaults.add')}
            </Button>
          ) : (
            defaults.length === 0 && <p className="text-xs text-fg-faint">{t('tables.forms.defaults.noFields')}</p>
          )}
        </div>
      </FormSection>

      <FormSection>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg">{t('tables.forms.allowMultiple')}</div>
            <div className="text-xs text-fg-muted">{t('tables.forms.allowMultipleHint')}</div>
          </div>
          <Toggle checked={allowMultiple} onChange={setAllowMultiple} label={t('tables.forms.allowMultiple')} />
        </div>
        <FormField className="mt-4" label={t('tables.forms.successMessage')}>
          <Input
            value={successMessage}
            onChange={(event) => setSuccessMessage(event.target.value)}
            placeholder={t('tables.forms.successMessagePlaceholder')}
          />
        </FormField>
      </FormSection>

      <FormError>{error}</FormError>
      <FormActions>
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button disabled={saving || !name.trim()} onClick={() => void save()} data-testid="form-save">
          {form ? t('tables.forms.saveChanges') : t('tables.forms.createDraft')}
        </Button>
      </FormActions>
    </div>
  );
}
