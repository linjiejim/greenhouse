/**
 * Create / edit one form (inside the forms dialog): the shown fields, who can
 * fill it in (Base members / everyone / chosen people and groups through the
 * shared `PrincipalPicker`), hidden prefilled values and single submission.
 * The server re-validates all of it; the editor only keeps people from saving
 * what it would refuse (relation fields outside Base audiences, a field both
 * shown and prefilled, a prefilled field with no value).
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { TableFormAudience, TableFormConfig } from '@greenhouse/types/tables';
import { Button, Checkbox, Input, Select, Textarea, Toggle } from '../../components/ui';
import { FormActions, FormError, FormField, FormSection } from '../../components/form';
import { isComputedField } from '../../components/tables/field-types';
import {
  FieldValuesEditor,
  fieldValueEntries,
  fieldValueRows,
  prefillableField,
  type FieldValueRow,
  type FieldValuesEditorCopy,
} from '../../components/tables/field-values-editor';
import { PrincipalPicker, type PrincipalSelection } from '../../components/tables/principal-picker';
import {
  createTableForm,
  listTableUsers,
  updateTableForm,
  type TableField,
  type TableForm,
  type TableUserOption,
} from '../../lib/api/tables';
import { useT } from '../../lib/i18n';

type AudienceKind = TableFormAudience['type'];

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
  const [defaults, setDefaults] = useState<FieldValueRow[]>(() => fieldValueRows(form?.config?.defaults, byId));
  // Archived fields drop out: the server refuses to save a form that shows one.
  const [fieldIds, setFieldIds] = useState<number[]>(() =>
    form
      ? form.config.fieldIds.filter((fieldId) => byId.has(fieldId))
      : writable.filter((field) => field.type !== 'relation' || audience === 'base').map((field) => field.id),
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
  // Prefill only what the form does not show (a shown field is the respondent's to fill).
  const prefillFields = fields.filter((field) => prefillableField(field) && !fieldIds.includes(field.id));
  const defaultsCopy: FieldValuesEditorCopy = {
    field: t('tables.forms.defaults.field'),
    value: t('tables.forms.defaults.value'),
    fixed: t('tables.forms.defaults.fixed'),
    tokens: {
      $me: t('tables.forms.defaults.me'),
      $today: t('tables.forms.defaults.today'),
      $now: t('tables.forms.defaults.now'),
    },
    add: t('tables.forms.defaults.add'),
    remove: t('tables.forms.defaults.remove'),
    none: t('tables.forms.defaults.none'),
    noFields: t('tables.forms.defaults.noFields'),
  };

  const changeAudience = (next: AudienceKind) => {
    setAudience(next);
    // Linked records only make sense to people who can read the Base.
    if (next !== 'base') setFieldIds((current) => current.filter((id) => byId.get(id)?.type !== 'relation'));
  };

  const toggleField = (fieldId: number, checked: boolean) => {
    setFieldIds((current) => (checked ? [...current, fieldId] : current.filter((id) => id !== fieldId)));
    if (checked) setDefaults((current) => current.filter((entry) => entry.fieldId !== fieldId));
  };

  const save = async () => {
    setError('');
    if (fieldIds.length === 0) return setError(t('tables.forms.fieldsRequired'));
    if (audience === 'principals' && principals.userIds.length + principals.groupIds.length === 0) {
      return setError(t('tables.forms.audience.pickRequired'));
    }
    const prefilled = fieldValueEntries(defaults, byId);
    if (!prefilled) return setError(t('tables.forms.defaults.valueRequired'));
    const config: TableFormConfig = {
      version: 1,
      title: title.trim() || name.trim(),
      description: description.trim(),
      fieldIds,
      // Only what the builder typed: left empty, each respondent gets their own language's copy.
      submitLabel: form?.config.submitLabel || '',
      successMessage: successMessage.trim(),
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
        <FieldValuesEditor
          rows={defaults}
          onChange={setDefaults}
          fields={prefillFields}
          users={users}
          copy={defaultsCopy}
          emptyLabel={t('tables.forms.choose')}
        />
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
