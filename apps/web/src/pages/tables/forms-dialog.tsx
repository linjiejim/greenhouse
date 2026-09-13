import React, { useCallback, useEffect, useState } from 'react';
import type { TableFormConfig } from '@greenhouse/types/tables';
import { Button, Checkbox, Dialog, EmptyState, Input, Spinner, Textarea } from '../../components/ui';
import { ClipboardList, Copy, ExternalLink, Plus } from '../../lib/icons';
import {
  createTableForm,
  listTableForms,
  updateTableForm,
  type TableField,
  type TableForm,
} from '../../lib/api/tables';
import { useT } from '../../lib/i18n';

export function TablesFormsDialog({
  open,
  tableId,
  fields,
  onClose,
}: {
  open: boolean;
  tableId: number;
  fields: TableField[];
  onClose: () => void;
}) {
  const t = useT();
  const [forms, setForms] = useState<TableForm[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [fieldIds, setFieldIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const editableFields = fields.filter(
    (field) => field.type !== 'formula' && field.type !== 'rollup' && field.type !== 'attachment',
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setForms(await listTableForms(tableId));
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tables.forms.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [tableId, t]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const startCreate = () => {
    setCreating(true);
    setName('');
    setTitle('');
    setDescription('');
    setFieldIds(editableFields.map((field) => field.id));
  };

  const save = async () => {
    if (!name.trim() || fieldIds.length === 0) return;
    setSaving(true);
    setError('');
    try {
      const config: TableFormConfig = {
        version: 1,
        title: title.trim() || name.trim(),
        description: description.trim() || undefined,
        fieldIds,
        submitLabel: t('tables.forms.submit'),
        successMessage: t('tables.forms.responseRecorded'),
      };
      await createTableForm(tableId, { name: name.trim(), status: 'draft', config });
      setCreating(false);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.forms.createFailed'));
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (form: TableForm) => {
    setSaving(true);
    setError('');
    try {
      await updateTableForm(form.id, {
        revision: form.revision,
        status: form.status === 'published' ? 'draft' : 'published',
      });
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.forms.updateFailed'));
    } finally {
      setSaving(false);
    }
  };

  const formUrl = (formId: number) => `${window.location.origin}${window.location.pathname}#/tables/form/${formId}`;

  return (
    <Dialog open={open} onClose={onClose} title={t('tables.forms.title')} size="lg">
      <div className="space-y-4">
        {error && <p className="rounded-md bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</p>}
        {creating ? (
          <div className="space-y-4 rounded-lg border border-edge bg-surface-sunken p-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.forms.internalName')}</label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('tables.forms.internalNamePlaceholder')}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.forms.formTitle')}</label>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t('tables.forms.formTitlePlaceholder')}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-fg-muted">{t('common.description')}</label>
              <Textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-fg-muted">{t('tables.forms.publishedFields')}</p>
              <div className="grid max-h-48 grid-cols-1 gap-2 overflow-y-auto rounded-md border border-edge bg-surface-raised p-3 sm:grid-cols-2">
                {editableFields.map((field) => (
                  <Checkbox
                    key={field.id}
                    label={field.name}
                    checked={fieldIds.includes(field.id)}
                    onChange={(event) =>
                      setFieldIds((current) =>
                        event.target.checked
                          ? [...current, field.id]
                          : current.filter((fieldId) => fieldId !== field.id),
                      )
                    }
                  />
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-edge pt-3">
              <Button variant="ghost" onClick={() => setCreating(false)}>
                {t('common.cancel')}
              </Button>
              <Button disabled={saving || !name.trim() || fieldIds.length === 0} onClick={() => void save()}>
                {t('tables.forms.createDraft')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button size="sm" onClick={startCreate}>
              <Plus size={13} className="mr-1.5" />
              {t('tables.forms.newForm')}
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : forms.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            variant="compact"
            tone="neutral"
            title={t('tables.forms.emptyTitle')}
            description={t('tables.forms.emptyDescription')}
          />
        ) : (
          <div className="divide-y divide-edge rounded-lg border border-edge">
            {forms.map((form) => (
              <div key={form.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-fg">{form.name}</p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${form.status === 'published' ? 'bg-success-subtle text-success' : 'bg-surface-muted text-fg-faint'}`}
                    >
                      {form.status === 'published' ? t('common.published') : t('common.draft')}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-fg-faint">
                    {t('tables.forms.summary', { count: form.config.fieldIds.length, revision: form.revision })}
                  </p>
                </div>
                <Button variant="outline" size="sm" disabled={saving} onClick={() => void toggleStatus(form)}>
                  {form.status === 'published' ? t('tables.forms.unpublish') : t('tables.forms.publish')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void navigator.clipboard.writeText(formUrl(form.id))}
                  title={t('tables.forms.copyLink')}
                >
                  <Copy size={13} />
                </Button>
                <a
                  href={`#/tables/form/${form.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md p-2 text-fg-muted hover:bg-surface-muted hover:text-fg"
                  title={t('tables.forms.openForm')}
                >
                  <ExternalLink size={14} />
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
