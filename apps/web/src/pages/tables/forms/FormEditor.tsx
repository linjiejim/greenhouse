/**
 * A form being built, in the forms drawer in place of its summary (编辑 → 取消 / 保存): name,
 * description, the table's fields to ask in order with a title, a line of help and 必填 each,
 * and what submitting looks like. A save based on an older form offers 重新载入 or 覆盖.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Field,
  IconButton,
  Input,
  OverlayActions,
  Select,
  TextArea,
  type SelectOption,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import {
  FORM_DESCRIPTION_MAX,
  FORM_HELP_MAX,
  FORM_LABEL_MAX,
  FORM_MESSAGE_MAX,
  FORM_NAME_MAX,
  FORM_SUBMIT_LABEL_MAX,
  isComputedType,
  type Base,
  type BaseTable,
  type Form,
  type FormField,
} from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { putForm } from '../../../data/tables-forms';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { FieldIcon } from '../cells';
import { formsError } from './errors';

interface Draft {
  name: string;
  description: string;
  fields: FormField[];
  submit_label: string;
  success_message: string;
  single_submit: boolean;
}

const draftOf = (form: Form): Draft => ({
  name: form.name,
  description: form.description,
  fields: form.config.fields,
  submit_label: form.config.submit_label ?? '',
  success_message: form.config.success_message ?? '',
  single_submit: form.config.single_submit === true,
});

export function FormEditor({
  base,
  table,
  form,
  onDone,
  onDirty,
}: {
  base: Base;
  table: BaseTable;
  form: Form;
  onDone: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const [from, setFrom] = useState(form);
  const [draft, setDraft] = useState(() => draftOf(form));
  const [stale, setStale] = useState<Form | null>(null);
  const [nameError, setNameError] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(from));
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  // Computed fields are worked out by the table: nobody fills them in.
  const fillable = useMemo(() => table.fields.filter((field) => !isComputedType(field.type)), [table.fields]);
  const byId = new Map(fillable.map((field) => [field.id, field]));
  const chosen = draft.fields.filter((item) => byId.has(item.field_id));
  // A field the table requires is always in the form.
  for (const field of fillable) {
    if (field.required && !chosen.some((item) => item.field_id === field.id)) chosen.push({ field_id: field.id });
  }
  const remaining: SelectOption[] = fillable
    .filter((field) => !chosen.some((item) => item.field_id === field.id))
    .map((field) => ({ value: field.id, label: field.name, icon: <FieldIcon type={field.type} /> }));

  const set = (change: Partial<Draft>) => setDraft((current) => ({ ...current, ...change }));
  const setFields = (fields: FormField[]) => set({ fields });
  const change = (index: number, patch: Partial<FormField>) =>
    setFields(chosen.map((item, at) => (at === index ? { ...item, ...patch } : item)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...chosen];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    setFields(next);
  };

  const save = async (over?: Form) => {
    if (!draft.name.trim()) {
      setNameError(t('tables.forms.fill.requiredError'));
      return;
    }
    setBusy(true);
    setFailure('');
    setNameError('');
    try {
      const saved = await api.tables.forms.update(form.id, {
        revision: (over ?? from).revision,
        name: draft.name.trim(),
        description: draft.description,
        config: {
          fields: chosen.map((item) => ({
            field_id: item.field_id,
            ...(item.label?.trim() ? { label: item.label.trim() } : {}),
            ...(item.help?.trim() ? { help: item.help.trim() } : {}),
            ...(item.required ? { required: true } : {}),
          })),
          submit_label: draft.submit_label.trim(),
          success_message: draft.success_message.trim(),
          single_submit: draft.single_submit,
        },
      });
      putForm(base.id, saved);
      setStale(null);
      onDirty(false);
      onDone();
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'stale_revision') {
        setStale((error.details as { form?: Form } | undefined)?.form ?? null);
      } else setFailure(formsError(error, t));
      setBusy(false);
    }
  };

  return (
    <>
      <form
        id={formId}
        className="app-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {stale && (
          <Banner
            tone="warning"
            action={
              <span className="app-inline-actions">
                <Button
                  size="sm"
                  onClick={() => {
                    putForm(base.id, stale);
                    setFrom(stale);
                    setDraft(draftOf(stale));
                    setStale(null);
                  }}
                >
                  {t('tables.forms.reload')}
                </Button>
                <Button size="sm" kind="primary" onClick={() => void save(stale)}>
                  {t('tables.forms.overwrite')}
                </Button>
              </span>
            }
          >
            {t('tables.forms.stale')}
          </Banner>
        )}
        {failure && (
          <p className="app-form-error" role="alert">
            {failure}
          </p>
        )}
        <Field label={t('tables.forms.name')} required error={nameError || undefined}>
          <Input value={draft.name} maxLength={FORM_NAME_MAX} onChange={(event) => set({ name: event.target.value })} />
        </Field>
        <Field label={t('tables.forms.description')}>
          <TextArea
            rows={2}
            value={draft.description}
            maxLength={FORM_DESCRIPTION_MAX}
            onChange={(event) => set({ description: event.target.value })}
          />
        </Field>
        <section className="app-tf-section" aria-label={t('tables.forms.fields')}>
          <h4 className="app-tf-section-title">{t('tables.forms.fields')}</h4>
          {chosen.length ? (
            <ol className="app-tf-edit-fields">
              {chosen.map((item, index) => {
                const field = byId.get(item.field_id)!;
                return (
                  <li key={field.id} className="app-tf-edit-field">
                    <div className="app-tf-edit-head">
                      <FieldIcon type={field.type} />
                      <span className="app-tf-edit-name">{field.name}</span>
                      {field.required ? (
                        <Badge>{t('tables.forms.tableRequired')}</Badge>
                      ) : (
                        <Checkbox
                          label={t('tables.forms.required')}
                          aria-label={t('tables.forms.requiredOf', { name: field.name })}
                          checked={item.required === true}
                          onChange={(on) => change(index, { required: on || undefined })}
                        />
                      )}
                      <IconButton
                        size="sm"
                        label={t('tables.forms.moveUp', { name: field.name })}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp size={icon.sm} strokeWidth={icon.stroke} />
                      </IconButton>
                      <IconButton
                        size="sm"
                        label={t('tables.forms.moveDown', { name: field.name })}
                        disabled={index === chosen.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown size={icon.sm} strokeWidth={icon.stroke} />
                      </IconButton>
                      <IconButton
                        size="sm"
                        label={t('tables.forms.remove', { name: field.name })}
                        disabled={field.required}
                        disabledReason={t('tables.forms.tableRequired')}
                        onClick={() => setFields(chosen.filter((_, at) => at !== index))}
                      >
                        <X size={icon.sm} strokeWidth={icon.stroke} />
                      </IconButton>
                    </div>
                    <div className="app-tf-edit-text">
                      <Input
                        aria-label={t('tables.forms.labelOf', { name: field.name })}
                        placeholder={field.name}
                        value={item.label ?? ''}
                        maxLength={FORM_LABEL_MAX}
                        onChange={(event) => change(index, { label: event.target.value })}
                      />
                      <Input
                        aria-label={t('tables.forms.helpOf', { name: field.name })}
                        placeholder={t('tables.forms.helpPlaceholder')}
                        value={item.help ?? ''}
                        maxLength={FORM_HELP_MAX}
                        onChange={(event) => change(index, { help: event.target.value })}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="app-tf-note">{t('tables.forms.noFields')}</p>
          )}
          {remaining.length > 0 && (
            <Select
              label={t('tables.forms.addField')}
              placeholder={t('tables.forms.addField')}
              value=""
              options={remaining}
              onChange={(id) => id && setFields([...chosen, { field_id: id }])}
            />
          )}
        </section>
        <section className="app-tf-section" aria-label={t('tables.forms.submitting')}>
          <h4 className="app-tf-section-title">{t('tables.forms.submitting')}</h4>
          <Checkbox
            label={t('tables.forms.single')}
            checked={draft.single_submit}
            onChange={(on) => set({ single_submit: on })}
          />
          <Field label={t('tables.forms.submitLabel')}>
            <Input
              placeholder={t('tables.forms.defaultSubmit')}
              value={draft.submit_label}
              maxLength={FORM_SUBMIT_LABEL_MAX}
              onChange={(event) => set({ submit_label: event.target.value })}
            />
          </Field>
          <Field label={t('tables.forms.successMessage')}>
            <TextArea
              rows={2}
              placeholder={t('tables.forms.defaultThanks')}
              value={draft.success_message}
              maxLength={FORM_MESSAGE_MAX}
              onChange={(event) => set({ success_message: event.target.value })}
            />
          </Field>
        </section>
      </form>
      <OverlayActions>
        <Button
          onClick={() => {
            setDraft(draftOf(from));
            onDirty(false);
            onDone();
          }}
        >
          {t('common.cancel')}
        </Button>
        {/* Keyed apart from 编辑: a reused button would turn into this submit while 编辑's click runs. */}
        <Button key="save" kind="primary" type="submit" form={formId} loading={busy}>
          {t('tables.forms.save')}
        </Button>
      </OverlayActions>
    </>
  );
}
