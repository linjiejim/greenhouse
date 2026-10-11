/**
 * The submit page of a form (`#/forms/:id`, spec 20261011-tables-foundation §3).
 *
 * Talks only to `/api/forms`: the submit view carries the fields, their
 * options and (when there are people fields) the internal directory, so the
 * page never needs Base access. Fields render through the shared
 * `FieldEditor`; attachments upload through the form (`uploadTableFormFile`)
 * and are bound when this person submits. Prefilled values are not shown — the
 * server sets them.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { TableFormSubmitView, TableRecordValues } from '@greenhouse/types/tables';
import { Button, EmptyState, Spinner } from '../../components/ui';
import { FormError, FormField } from '../../components/form';
import { FieldEditor, fieldEditorOwnsLabel } from '../../components/tables/field-editor';
import { valuesFromDrafts, type FieldDraft } from '../../components/tables/field-draft';
import { CheckCircle2, ClipboardList } from '../../lib/icons';
import {
  TablesRequestError,
  openTableForm,
  submitTableForm,
  uploadTableFormFile,
  type TableUserOption,
} from '../../lib/api/tables';
import { useT } from '../../lib/i18n';

type SubmitField = TableFormSubmitView['fields'][number];

/** A submit-view field in the shape the shared editors read (`config` as the stored JSON). */
function editorField(field: SubmitField) {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    required: field.required,
    config: JSON.stringify({
      ...(field.options ? { options: field.options } : {}),
      ...(field.type === 'relation' ? { relation: { multiple: field.multiple === true } } : {}),
    }),
  };
}

type PageState =
  | { kind: 'loading' }
  | { kind: 'missing'; message: string }
  | { kind: 'draft' }
  | { kind: 'ready'; view: TableFormSubmitView };

export function TablesFormPage({ formId }: { formId: number }) {
  const t = useT();
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>({});
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState<{ message: string | null } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    openTableForm(formId)
      .then((view) => !cancelled && setState({ kind: 'ready', view }))
      .catch((loadError: unknown) => {
        if (cancelled) return;
        if (loadError instanceof TablesRequestError && loadError.details?.reason === 'not_published') {
          setState({ kind: 'draft' });
        } else if (loadError instanceof TablesRequestError && loadError.status === 404) {
          setState({ kind: 'missing', message: t('tables.forms.notFound') });
        } else {
          setState({
            kind: 'missing',
            message: loadError instanceof Error ? loadError.message : t('tables.forms.loadOneFailed'),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [formId, t]);

  const view = state.kind === 'ready' ? state.view : null;
  const fields = useMemo(() => (view ? view.fields.map(editorField) : []), [view]);
  const users = useMemo<TableUserOption[]>(
    () => (view?.userOptions ?? []).map((user) => ({ id: user.id, nickname: user.name, email: user.email ?? '' })),
    [view],
  );

  const submit = async () => {
    if (!view) return;
    setSaving(true);
    setError('');
    try {
      const values: TableRecordValues = valuesFromDrafts(fields, drafts, 'create');
      const result = await submitTableForm(formId, values);
      setSubmitted({ message: result.successMessage });
      setDrafts({});
    } catch (submitError) {
      if (submitError instanceof TablesRequestError && submitError.details?.reason === 'already_submitted') {
        setState({ kind: 'ready', view: { ...view, alreadySubmitted: true } });
      } else {
        setError(submitError instanceof Error ? submitError.message : t('tables.forms.submitFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  if (state.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (state.kind === 'missing') {
    return <EmptyState icon={ClipboardList} title={t('tables.forms.unavailable')} description={state.message} />;
  }
  if (state.kind === 'draft') {
    return (
      <EmptyState
        icon={ClipboardList}
        title={t('tables.forms.notPublished')}
        description={t('tables.forms.notPublishedHint')}
      />
    );
  }

  const done = submitted
    ? {
        title: t('tables.forms.responseRecordedTitle'),
        body: submitted.message ?? t('tables.forms.responseRecorded'),
        again: state.view.allowMultiple,
      }
    : state.view.alreadySubmitted
      ? { title: t('tables.forms.alreadySubmittedTitle'), body: t('tables.forms.alreadySubmittedHint'), again: false }
      : null;
  if (done) {
    return (
      <div className="h-full overflow-y-auto bg-surface-canvas px-4 py-12">
        <div
          className="mx-auto max-w-xl rounded-xl border border-edge bg-surface-raised p-8 text-center shadow-sm"
          data-testid="form-done"
        >
          <CheckCircle2 size={36} className="mx-auto text-success" />
          <h1 className="mt-4 text-xl font-semibold text-fg">{done.title}</h1>
          <p className="mt-2 text-sm text-fg-muted">{done.body}</p>
          {done.again && (
            <Button className="mt-6" onClick={() => setSubmitted(null)}>
              {t('tables.forms.submitAnother')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const { view: form } = state;
  return (
    <div className="h-full overflow-y-auto bg-surface-canvas px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-2xl rounded-xl border border-edge bg-surface-raised p-5 shadow-sm sm:p-8">
        <div className="mb-7 border-b border-edge pb-5">
          <div className="mb-2 flex items-center gap-2 text-primary-fg">
            <ClipboardList size={18} />
            <span className="text-xs font-semibold uppercase tracking-wider">{t('tables.forms.internalForm')}</span>
          </div>
          <h1 className="text-2xl font-semibold text-fg">{form.title}</h1>
          {form.description && <p className="mt-2 text-sm leading-6 text-fg-muted">{form.description}</p>}
        </div>
        <div className="space-y-5">
          {fields.map((field) => {
            const editor = (
              <FieldEditor
                field={field}
                value={drafts[String(field.id)] ?? ''}
                onChange={(next) => setDrafts((current) => ({ ...current, [String(field.id)]: next }))}
                users={users}
                uploadAttachment={(file) => uploadTableFormFile(formId, file)}
                emptyLabel={t('tables.forms.choose')}
                disabled={saving}
              />
            );
            if (fieldEditorOwnsLabel(field)) return <div key={field.id}>{editor}</div>;
            return (
              <FormField key={field.id} label={field.name} required={field.required}>
                {editor}
              </FormField>
            );
          })}
          <FormError>{error}</FormError>
          <div className="flex justify-end border-t border-edge pt-5">
            <Button disabled={saving} onClick={() => void submit()} data-testid="form-submit">
              {saving ? t('tables.forms.submitting') : (form.submitLabel ?? t('tables.forms.submit'))}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
