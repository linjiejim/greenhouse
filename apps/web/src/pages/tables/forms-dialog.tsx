/**
 * A table's forms (builders): the list — status, audience, publish, link
 * (`#/forms/:id`) — and the editor (`./form-editor.tsx`) for a new or existing
 * form. The submit page itself is `./form-page.tsx`.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { TableFormAudience } from '@greenhouse/types/tables';
import { Badge, Button, Dialog, EmptyState, IconButton, Spinner, toast } from '../../components/ui';
import { ClipboardList, Copy, ExternalLink, Pencil, Plus } from '../../lib/icons';
import { listTableForms, updateTableForm, type TableField, type TableForm } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';
import { TablesFormEditor } from './form-editor';

/** The link people open (outside the Tables module gate). */
function tableFormUrl(formId: number): string {
  return `${window.location.origin}${window.location.pathname}#/forms/${formId}`;
}

function useAudienceSummary() {
  const t = useT();
  return (audience: TableFormAudience) =>
    audience.type === 'principals'
      ? t('tables.forms.audience.summaryPrincipals', { count: audience.userIds.length + audience.groupIds.length })
      : audience.type === 'team'
        ? t('tables.forms.audience.summaryTeam')
        : t('tables.forms.audience.summaryBase');
}

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
  const audienceSummary = useAudienceSummary();
  const [forms, setForms] = useState<TableForm[]>([]);
  /** `null` = the list; `'new'` or a form = the editor. */
  const [editing, setEditing] = useState<TableForm | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
    if (!open) setEditing(null);
  }, [load, open]);

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

  const copyLink = async (form: TableForm) => {
    await navigator.clipboard.writeText(tableFormUrl(form.id));
    toast(t('tables.forms.linkCopied'), 'success');
  };

  const title =
    editing === null
      ? t('tables.forms.title')
      : editing === 'new'
        ? t('tables.forms.newForm')
        : t('tables.forms.editForm');

  return (
    <Dialog open={open} onClose={onClose} title={title} size="xl">
      {editing !== null ? (
        <TablesFormEditor
          tableId={tableId}
          fields={fields}
          form={editing === 'new' ? undefined : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : (
        <div className="space-y-4">
          {error && <p className="rounded-md bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</p>}
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setEditing('new')} data-testid="forms-new">
              <Plus size={13} className="mr-1.5" />
              {t('tables.forms.newForm')}
            </Button>
          </div>
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
                <div
                  key={form.id}
                  className="flex flex-wrap items-center gap-2 px-3 py-3"
                  data-testid={`form-row-${form.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-fg">{form.name}</p>
                      <Badge variant={form.status === 'published' ? 'success' : 'secondary'}>
                        {form.status === 'published' ? t('common.published') : t('common.draft')}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-[11px] text-fg-faint">
                      {audienceSummary(form.audience)} ·{' '}
                      {t('tables.forms.summary', { count: form.config.fieldIds.length, revision: form.revision })}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" disabled={saving} onClick={() => void toggleStatus(form)}>
                    {form.status === 'published' ? t('tables.forms.unpublish') : t('tables.forms.publish')}
                  </Button>
                  <IconButton label={t('tables.forms.edit')} onClick={() => setEditing(form)}>
                    <Pencil size={14} />
                  </IconButton>
                  <IconButton label={t('tables.forms.copyLink')} onClick={() => void copyLink(form)}>
                    <Copy size={14} />
                  </IconButton>
                  <a
                    href={`#/forms/${form.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md p-2 text-fg-muted hover:bg-surface-muted hover:text-fg"
                    title={t('tables.forms.openForm')}
                    aria-label={t('tables.forms.openForm')}
                  >
                    <ExternalLink size={14} />
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
