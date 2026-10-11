/**
 * The one app form: a form card, a records card's "new", a `create_record`
 * button, the drawer's edit and an action's input dialog all render this.
 * Fields go through the shared `FieldEditor` (drafts via `field-draft`);
 * people and relation choices come from the gateway (`loadOptions` — app
 * viewers cannot read the Tables directory or the target table), attachments
 * upload through the app (`upload`) and bind on the write. Required fields are
 * checked here for a quick answer and again by the server; a `required_input`
 * refusal marks the fields it names.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppFieldOptionsView, AppUploadView } from '@greenhouse/types/apps';
import type { TableFieldValueEntry } from '@greenhouse/types/tables';
import { FormError, FormField } from '../form';
import { FieldEditor, fieldEditorOwnsLabel } from '../tables/field-editor';
import { fromFieldDraft, toFieldDraft, valuesFromDrafts, type FieldDraft } from '../tables/field-draft';
import { usePendingUploads } from '../tables/use-pending-uploads';
import { Button } from '../ui';
import { TablesRequestError, type TableField, type TableUserOption } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';

export interface AppRecordFormProps {
  /** The fields to fill, in order (already limited to what the role may write). */
  fields: readonly TableField[];
  /** Required beyond each field's own `required` (an action's required inputs). */
  requiredFieldIds?: ReadonlySet<number>;
  /** Stored values to start from (an edit). */
  initialValues?: Record<string, unknown>;
  /** `update` sends only the fields that changed. */
  mode: 'create' | 'update';
  loadOptions?: (fieldId: number) => Promise<AppFieldOptionsView>;
  upload?: (fieldId: number, file: File) => Promise<AppUploadView>;
  submitLabel: string;
  /** Resolves when stored; throws a refusal (`TablesRequestError`) to show. */
  onSubmit: (values: TableFieldValueEntry[]) => Promise<void>;
  onCancel?: () => void;
  /** Text for a failure other than missing required fields. */
  describeError: (error: unknown) => string;
  /** Shown above the fields (an action's confirmation text). */
  intro?: ReactNode;
  /** Keep the submit row in view at the bottom of a scrolling container (a form card on a fixed-height grid cell). */
  stickyActions?: boolean;
  testId?: string;
}

type FieldOptions = { users?: TableUserOption[]; relations?: Array<{ value: number; label: string }> };

function isBlank(field: TableField, draft: FieldDraft | undefined): boolean {
  if (field.type === 'boolean') return false;
  if (draft === undefined) return true;
  const value = fromFieldDraft(field, draft);
  return value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/** People / relation choices for the fields that need them, loaded once per form. */
function useFieldOptions(fields: readonly TableField[], loadOptions: AppRecordFormProps['loadOptions']) {
  const [options, setOptions] = useState<Record<number, FieldOptions>>({});
  // Hosts pass an inline loader; the fields that need choices decide when to (re)load, not its identity.
  const loader = useRef(loadOptions);
  loader.current = loadOptions;
  const wanted = useMemo(
    () =>
      fields
        .filter((field) => field.type === 'user' || field.type === 'multi_user' || field.type === 'relation')
        .map((field) => `${field.id}:${field.type}`)
        .join(','),
    [fields],
  );
  useEffect(() => {
    const load = loader.current;
    if (!load || !wanted) return;
    let alive = true;
    for (const entry of wanted.split(',')) {
      const [id, type] = entry.split(':');
      const fieldId = Number(id);
      load(fieldId)
        .then((view) => {
          if (!alive) return;
          const next: FieldOptions =
            type === 'relation'
              ? {
                  relations: view.options.flatMap((option) =>
                    typeof option.value === 'number' ? [{ value: option.value, label: option.label }] : [],
                  ),
                }
              : {
                  users: view.options.map((option) => ({
                    id: String(option.value),
                    nickname: option.label,
                    email: option.detail ?? '',
                  })),
                };
          setOptions((current) => ({ ...current, [fieldId]: next }));
        })
        // No choices: people pickers stay empty, relations fall back to typing record ids.
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [wanted]);
  return options;
}

export function AppRecordForm({
  fields,
  requiredFieldIds,
  initialValues,
  mode,
  loadOptions,
  upload,
  submitLabel,
  onSubmit,
  onCancel,
  describeError,
  intro,
  stickyActions = false,
  testId,
}: AppRecordFormProps) {
  const t = useT();
  const initialDrafts = useMemo(
    () =>
      Object.fromEntries(
        fields.map((field) => [String(field.id), toFieldDraft(field, initialValues?.[String(field.id)])]),
      ),
    [fields, initialValues],
  );
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>(initialDrafts);
  const [missing, setMissing] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const { uploading, busyChange } = usePendingUploads();
  const options = useFieldOptions(fields, loadOptions);
  const required = (field: TableField) => field.required || Boolean(requiredFieldIds?.has(field.id));

  const submit = async () => {
    if (saving || uploading) return;
    const blank = new Set(
      fields.filter((field) => required(field) && isBlank(field, drafts[String(field.id)])).map((field) => field.id),
    );
    setMissing(blank);
    if (blank.size > 0) {
      setError(t('apps.runtime.form.fillRequired'));
      return;
    }
    const changed =
      mode === 'update'
        ? fields.filter(
            (field) =>
              JSON.stringify(fromFieldDraft(field, drafts[String(field.id)] ?? '')) !==
              JSON.stringify(fromFieldDraft(field, initialDrafts[String(field.id)] ?? '')),
          )
        : fields;
    const values = valuesFromDrafts(changed, drafts, mode);
    setSaving(true);
    setError('');
    try {
      await onSubmit(
        changed.flatMap((field) =>
          Object.prototype.hasOwnProperty.call(values, String(field.id))
            ? [{ fieldId: field.id, value: values[String(field.id)] }]
            : [],
        ),
      );
    } catch (submitError) {
      const named =
        submitError instanceof TablesRequestError && Array.isArray(submitError.details?.fieldIds)
          ? new Set((submitError.details.fieldIds as unknown[]).map(Number))
          : null;
      if (named && named.size > 0) setMissing(named);
      setError(describeError(submitError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-testid={testId}>
      {intro}
      {fields.length === 0 && <p className="text-sm text-fg-muted">{t('apps.runtime.form.noFields')}</p>}
      {fields.map((field) => {
        const key = String(field.id);
        const fieldOptions = options[field.id];
        const invalid = missing.has(field.id);
        const editor = (
          <FieldEditor
            field={field}
            value={drafts[key] ?? ''}
            onChange={(next) => {
              setDrafts((current) => ({ ...current, [key]: next }));
              if (invalid) setMissing((current) => new Set([...current].filter((id) => id !== field.id)));
            }}
            users={fieldOptions?.users ?? []}
            relationOptions={fieldOptions?.relations}
            uploadAttachment={upload ? (file) => upload(field.id, file) : undefined}
            onBusyChange={busyChange(field.id)}
            emptyLabel={t('apps.runtime.form.choose')}
            disabled={saving}
            aria-invalid={invalid || undefined}
          />
        );
        if (fieldEditorOwnsLabel(field)) return <div key={field.id}>{editor}</div>;
        return (
          <FormField
            key={field.id}
            label={field.name}
            required={required(field)}
            error={invalid ? t('apps.runtime.form.required') : undefined}
          >
            {editor}
          </FormField>
        );
      })}
      <FormError>{error}</FormError>
      <div
        className={`flex flex-wrap justify-end gap-2 border-t border-edge pt-4${
          stickyActions ? ' sticky bottom-0 z-10 bg-surface-card pb-1' : ''
        }`}
      >
        {onCancel && (
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            {t('common.cancel')}
          </Button>
        )}
        <Button
          onClick={() => void submit()}
          disabled={saving || uploading}
          data-testid={testId ? `${testId}-submit` : undefined}
        >
          {saving ? t('apps.runtime.form.submitting') : uploading ? t('apps.runtime.form.uploading') : submitLabel}
        </Button>
      </div>
    </div>
  );
}
