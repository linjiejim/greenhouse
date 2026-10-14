/**
 * `#/forms/:id`: an internal form to fill in (TBL-11). Its fields, then 提交表单; afterwards its
 * message and 再填一份, or for a single-submit form 你已经提交过 (also when opened again). Files
 * upload through the form itself: whoever fills it in may have no access to the base.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CircleCheck, ClipboardList, Paperclip, Plus, X } from 'lucide-react';
import {
  Banner,
  Button,
  Empty,
  ErrorBox,
  Field as FormControl,
  FieldGroup,
  IconButton,
  Input,
  Skeleton,
  StatusBadge,
  TextArea,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import {
  isEmptyValue,
  type Field,
  type FieldType,
  type FormFill,
  type FormFillField,
  type FormUpload,
  type RecordValues,
} from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useSession } from '../../../app/session';
import { formatSize } from '../../../data/files';
import { usePeople } from '../../../data/people';
import { queryClient } from '../../../data/query';
import { formsKeys, useFormFill } from '../../../data/tables-forms';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { Page, PageHeader } from '../../../shell/Page';
import { FieldInput, fromText } from '../cells';
import type { CellLookups } from '../model';
import { formsError } from './errors';
import '../../../styles/tables.css';
import '../../../styles/tables-forms.css';

export function FormPage({ id }: { id: string }) {
  const { t } = useI18n();
  const fill = useFormFill(id);
  if (fill.data) return <FillIn form={fill.data} />;
  const code = fill.error instanceof ApiClientError ? fill.error.code : '';
  return (
    <Page header={<PageHeader title={t('tables.forms.page')} />} width="form">
      {fill.isPending ? (
        <Skeleton lines={6} />
      ) : code === 'not_found' || code === 'form_closed' ? (
        <Gone closed={code === 'form_closed'} />
      ) : (
        <ErrorBox onRetry={() => void fill.refetch()}>{formsError(fill.error, t)}</ErrorBox>
      )}
    </Page>
  );
}

/** Not there for this member (deleted, or not shared with them), or not taking submissions now. */
function Gone({ closed }: { closed: boolean }) {
  const { t } = useI18n();
  return (
    <Empty
      icon={<ClipboardList strokeWidth={icon.stroke} />}
      title={closed ? t('tables.forms.error.closed') : t('tables.forms.fill.notFound')}
      description={closed ? t('tables.forms.fill.closedHint') : t('tables.forms.fill.notFoundHint')}
    />
  );
}

/** A form field as the table's own controls take it. */
const asField = (field: FormFillField, position: number): Field => ({
  id: field.id,
  table_id: field.table_id,
  name: field.name,
  type: field.type,
  config: field.config,
  required: field.required,
  is_primary: false,
  position,
});

/** Fields filled in with one input, by the input's type; pickers, files and checkboxes take a group label. */
const INPUT_TYPES: Partial<Record<FieldType, string>> = {
  text: 'text',
  number: 'text',
  url: 'url',
  email: 'email',
  phone: 'tel',
};

function FillIn({ form }: { form: FormFill }) {
  const { t } = useI18n();
  const { me } = useSession();
  const { memberById } = usePeople();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const fields = useMemo(() => form.fields.map(asField), [form.fields]);
  const [values, setValues] = useState<RecordValues>({});
  const [uploads, setUploads] = useState<Record<string, FormUpload>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'filling' | 'sent' | 'already' | 'closed' | 'missing'>(
    form.single_submit && form.submitted ? 'already' : 'filling',
  );
  const draft = form.status === 'draft';
  const lookups: CellLookups = useMemo(
    () => ({ members: memberById, linked: {}, files: {}, timeZone: me?.timezone ?? 'Asia/Shanghai' }),
    [memberById, me?.timezone],
  );

  // After a failed submit the focus goes to the first field in error.
  const [focusError, setFocusError] = useState(0);
  useEffect(() => {
    if (!focusError) return;
    const first = form.fields.find((field) => errors[field.id]);
    const box = first && formRef.current?.querySelector(`[data-field="${first.id}"]`);
    box?.querySelector<HTMLElement>('input:not([type="file"]), textarea, button')?.focus();
  }, [focusError, errors, form.fields]);

  const submit = async () => {
    if (draft || busy) return;
    const out: RecordValues = {};
    const wrong: Record<string, string> = {};
    for (const field of fields) {
      const value = fromText(field, values[field.id]);
      if (value !== undefined) out[field.id] = value;
      const empty = field.type === 'checkbox' ? value !== true : isEmptyValue(value);
      if (field.required && empty) wrong[field.id] = t('tables.forms.fill.requiredError');
      else if (field.type === 'number' && !isEmptyValue(value) && typeof value !== 'number') {
        wrong[field.id] = t('tables.forms.fill.numberError');
      }
    }
    setErrors(wrong);
    setFailure('');
    if (Object.keys(wrong).length) {
      setFocusError((count) => count + 1);
      return;
    }
    setBusy(true);
    // The form stays loaded for this visit: coming back to it must know it was submitted.
    const submitted = () => queryClient.setQueryData<FormFill>(formsKeys.fill(form.id), { ...form, submitted: true });
    try {
      await api.tables.forms.submit(form.id, out);
      submitted();
      setState('sent');
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'already_submitted') {
        submitted();
        setState('already');
      } else if (error instanceof ApiClientError && error.code === 'form_closed') setState('closed');
      else if (error instanceof ApiClientError && error.status === 404) setState('missing');
      else {
        const field = error instanceof ApiClientError ? (error.details as { field?: string } | undefined)?.field : '';
        if (field && fields.some((entry) => entry.id === field)) {
          setErrors({ [field]: formsError(error, t) });
          setFocusError((count) => count + 1);
        } else setFailure(formsError(error, t));
      }
    } finally {
      setBusy(false);
    }
  };

  /** A changed value takes its error away with it. */
  const update = (fieldId: string, value: unknown) => {
    setValues((current) => ({ ...current, [fieldId]: value }));
    setErrors((current) => {
      if (!(fieldId in current)) return current;
      const rest = { ...current };
      delete rest[fieldId];
      return rest;
    });
  };

  const again = () => {
    setValues({});
    setUploads({});
    setErrors({});
    setFailure('');
    setState('filling');
  };

  let body;
  if (state === 'sent' || state === 'already') {
    body = (
      <div className="app-tf-done" role="status">
        <CircleCheck size={icon.lg} strokeWidth={icon.stroke} className="app-tf-done-icon" aria-hidden />
        <p className="app-tf-done-title">
          {state === 'already'
            ? t('tables.forms.fill.already')
            : form.success_message || t('tables.forms.defaultThanks')}
        </p>
        {state === 'already' && form.success_message && <p className="app-tf-description">{form.success_message}</p>}
        {state === 'sent' && !form.single_submit && <Button onClick={again}>{t('tables.forms.fill.again')}</Button>}
      </div>
    );
  } else if (state === 'closed' || state === 'missing') {
    body = <Gone closed={state === 'closed'} />;
  } else {
    body = (
      <form
        ref={formRef}
        id={formId}
        className="app-tf-fill"
        noValidate
        aria-label={t('tables.forms.fill.fields')}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {!fields.length && <p className="app-tf-note">{t('tables.forms.fill.empty')}</p>}
        {fields.map((field, index) => {
          const help = form.fields[index]!.help || undefined;
          const value = values[field.id];
          // One input sits in a field label, which names it with 必填 and wires its help and error.
          if (field.type === 'long_text' || INPUT_TYPES[field.type]) {
            const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
            return (
              <div key={field.id} data-field={field.id}>
                <FormControl label={field.name} required={field.required} description={help} error={errors[field.id]}>
                  {field.type === 'long_text' ? (
                    <TextArea rows={3} value={text} onChange={(event) => update(field.id, event.target.value)} />
                  ) : (
                    <Input
                      type={INPUT_TYPES[field.type]}
                      inputMode={field.type === 'number' ? 'decimal' : undefined}
                      className={field.type === 'number' ? 'app-tb-number-input' : undefined}
                      value={text}
                      onChange={(event) => update(field.id, event.target.value)}
                    />
                  )}
                </FormControl>
              </div>
            );
          }
          return (
            <div key={field.id} data-field={field.id}>
              <FieldGroup
                label={field.required ? `${field.name} · ${t('tables.forms.required')}` : field.name}
                description={help}
                error={errors[field.id]}
              >
                {field.type === 'attachment' ? (
                  <FormFiles
                    formId={form.id}
                    field={field}
                    value={(value as string[] | undefined) ?? []}
                    uploads={uploads}
                    disabled={draft}
                    onUploaded={(stored) =>
                      setUploads((current) => ({
                        ...current,
                        ...Object.fromEntries(stored.map((file) => [file.id, file])),
                      }))
                    }
                    onChange={(next) => update(field.id, next)}
                  />
                ) : (
                  <FieldInput
                    field={field}
                    value={value}
                    baseId=""
                    lookups={lookups}
                    onChange={(next) => update(field.id, next)}
                  />
                )}
              </FieldGroup>
            </div>
          );
        })}
        {failure && (
          <p className="app-form-error" role="alert">
            {failure}
          </p>
        )}
        {fields.length > 0 && (
          <div className="app-tf-submit">
            <Button
              kind="primary"
              type="submit"
              loading={busy}
              disabled={draft}
              disabledReason={t('tables.forms.fill.draftReason')}
            >
              {form.submit_label || t('tables.forms.defaultSubmit')}
            </Button>
          </div>
        )}
      </form>
    );
  }

  return (
    <Page
      width="form"
      header={
        <PageHeader
          title={form.name}
          badge={draft ? <StatusBadge status={t('tables.forms.status.draft')} tone="neutral" /> : undefined}
        />
      }
    >
      {draft && <Banner>{t('tables.forms.fill.preview')}</Banner>}
      {form.description && state === 'filling' && <p className="app-tf-description app-tf-intro">{form.description}</p>}
      {body}
    </Page>
  );
}

/**
 * An attachment field of a form: files upload through the form's own address (the person may
 * not reach the base), show by name and size, and can be taken off before submitting.
 */
function FormFiles({
  formId,
  field,
  value,
  uploads,
  disabled,
  onUploaded,
  onChange,
}: {
  formId: string;
  field: Field;
  value: string[];
  uploads: Record<string, FormUpload>;
  disabled: boolean;
  onUploaded: (files: FormUpload[]) => void;
  onChange: (value: string[]) => void;
}) {
  const { t, locale } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const upload = async (picked: FileList | null) => {
    if (!picked?.length) return;
    setBusy(true);
    setError('');
    const stored: FormUpload[] = [];
    try {
      for (const file of [...picked]) stored.push(await api.tables.forms.upload(formId, file));
    } catch (failure) {
      setError(formsError(failure, t));
    } finally {
      if (stored.length) {
        onUploaded(stored);
        onChange([...value, ...stored.map((file) => file.id)]);
      }
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="app-tf-files">
      {value.length > 0 && (
        <ul className="app-tf-file-list">
          {value.map((id) => {
            const file = uploads[id];
            const name = file?.name ?? '';
            return (
              <li key={id} className="app-chip">
                <Paperclip size={icon.sm} strokeWidth={icon.stroke} aria-hidden />
                <span className="app-chip-text">{name}</span>
                {file && (
                  <span className="app-tf-file-size">
                    {formatSize(file.size_bytes, locale === 'zh' ? 'zh-CN' : 'en-US')}
                  </span>
                )}
                <IconButton
                  size="sm"
                  label={t('tables.forms.fill.removeFile', { name })}
                  onClick={() => onChange(value.filter((entry) => entry !== id))}
                >
                  <X size={icon.sm} strokeWidth={icon.stroke} />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label={field.name}
        onChange={(event) => void upload(event.target.files)}
      />
      <Button
        size="sm"
        loading={busy}
        disabled={disabled}
        disabledReason={t('tables.forms.fill.draftReason')}
        onClick={() => input.current?.click()}
      >
        <Plus size={icon.sm} strokeWidth={icon.stroke} />
        {t('tables.forms.fill.upload')}
      </Button>
      {error && (
        <p className="app-form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
