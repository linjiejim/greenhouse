import React, { useEffect, useState } from 'react';
import { Button, EmptyState, Spinner } from '../../components/ui';
import { FormField } from '../../components/form';
import { FieldEditor, fieldEditorOwnsLabel } from '../../components/tables/field-editor';
import { valuesFromDrafts, type FieldDraft } from '../../components/tables/field-draft';
import { CheckCircle2, ClipboardList } from '../../lib/icons';
import {
  getTableForm,
  listTableUsers,
  submitTableForm,
  type TableField,
  type TableForm,
  type TableUserOption,
} from '../../lib/api/tables';
import { useT } from '../../lib/i18n';

export function TablesFormPage({ formId }: { formId: number }) {
  const t = useT();
  const [form, setForm] = useState<TableForm | null>(null);
  const [fields, setFields] = useState<TableField[]>([]);
  const [users, setUsers] = useState<TableUserOption[]>([]);
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>({});
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

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      await submitTableForm(formId, valuesFromDrafts(fields, drafts, 'create'));
      setSubmitted(true);
      setDrafts({});
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
          {fields.map((field) => {
            const editor = (
              <FieldEditor
                field={field}
                value={drafts[String(field.id)] ?? ''}
                onChange={(next) => setDrafts((current) => ({ ...current, [String(field.id)]: next }))}
                users={users}
                emptyLabel={t('tables.forms.choose')}
              />
            );
            if (fieldEditorOwnsLabel(field)) return <div key={field.id}>{editor}</div>;
            return (
              <FormField key={field.id} label={field.name} required={field.required}>
                {editor}
              </FormField>
            );
          })}
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
