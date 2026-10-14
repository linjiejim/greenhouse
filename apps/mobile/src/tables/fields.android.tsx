import { useState } from 'react';
import { DatePickerDialog, TimePickerDialog } from '@expo/ui/jetpack-compose';
import { parseMs } from '../data/time';
import { useLocale } from '../lib/i18n';
import { calendarDateLabel } from '../lib/time-words';
import { useAttachments } from './use-attachments';
import { saveFile } from '../chat/file-card';
import { useFieldChoices } from './field-choices';
import {
  FormNavRow,
  FormActionRow,
  FormSection,
  FormTextField,
  FormValueRow,
  FormSwitchRow,
  FormCheckRow,
  FormSelectRow,
  useNativeState,
} from '../ui/native-form.android';
import { useT } from '../lib/i18n';
import { computed, cellText, choiceValue } from './model';
import type { FieldProps } from './fields';
export function FieldEditor({ field, value, change, readonly, options, uploadPath, files }: FieldProps) {
  const t = useT();
  const locale = useLocale();
  const [dateOpen, setDateOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const attachments = useAttachments(uploadPath);
  const knownFiles = { ...files, ...attachments.files };
  const state = useNativeState(value == null ? '' : String(value));
  const label = `${field.name}${field.required ? ' *' : ''}`;
  const choicesResource = useFieldChoices(field);
  const choices = field.config.options ?? options ?? choicesResource.data ?? [];
  if (field.type === 'attachment')
    return (
      <FormSection title={label}>
        {(Array.isArray(value) ? value : []).map((id) => (
          <FormNavRow
            key={String(id)}
            label={knownFiles[String(id)]?.name ?? t('work.attachment')}
            onPress={() => {
              const file = knownFiles[String(id)];
              if (file?.url) saveFile(file.url, file.name);
            }}
          />
        ))}
        {!readonly && uploadPath ? (
          <FormActionRow
            label={t('work.upload')}
            loading={attachments.busy}
            onPress={() =>
              void attachments.add().then((id) => {
                if (id) change([...(Array.isArray(value) ? value : []), id]);
              })
            }
          />
        ) : null}
      </FormSection>
    );
  if (readonly || computed(field.type))
    return (
      <FormSection title={label} footer={computed(field.type) ? t('work.computed') : t('work.readonly')}>
        <FormValueRow
          label={
            cellText(field, value, undefined, Object.fromEntries(choices.map((o) => [o.id, o.label]))) ||
            t('work.emptyValue')
          }
        />
      </FormSection>
    );
  if (field.type === 'checkbox')
    return (
      <FormSection>
        <FormSwitchRow label={label} value={!!value} onValueChange={change} />
      </FormSection>
    );
  if (['single_select', 'multi_select', 'member', 'relation', 'parent', 'dependency'].includes(field.type)) {
    const multi = field.type === 'multi_select' || !!field.config.multiple || field.type === 'dependency';
    const picked = Array.isArray(value) ? value : value ? [value] : [];
    return (
      <FormSection title={label}>
        {multi ? (
          choices.map((o) => (
            <FormCheckRow
              key={o.id}
              label={o.label}
              checked={picked.includes(o.id)}
              onPress={() => change(picked.includes(o.id) ? picked.filter((id) => id !== o.id) : [...picked, o.id])}
            />
          ))
        ) : (
          <FormSelectRow
            label={label}
            value={String(value ?? '')}
            options={[
              { value: '', label: t('work.emptyValue') },
              ...choices.map((o) => ({ value: o.id, label: o.label })),
            ]}
            onChange={(id) => change(choiceValue(field, id))}
          />
        )}
      </FormSection>
    );
  }
  if (field.type === 'date' || field.type === 'datetime')
    return (
      <FormSection title={label}>
        <FormNavRow
          label={label}
          value={typeof value === 'string' ? calendarDateLabel(value) : t('work.emptyValue')}
          onPress={() => setDateOpen(true)}
        />
        {field.type === 'datetime' ? (
          <FormNavRow
            label={t('work.time')}
            value={
              typeof value === 'string'
                ? new Date(parseMs(value)).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
                : t('work.emptyValue')
            }
            onPress={() => setTimeOpen(true)}
          />
        ) : null}
        {timeOpen ? (
          <TimePickerDialog
            initialDate={typeof value === 'string' ? new Date(parseMs(value)).toISOString() : new Date().toISOString()}
            confirmButtonLabel={t('common.save')}
            dismissButtonLabel={t('common.cancel')}
            onDateSelected={(time) => {
              change(time.toISOString());
              setTimeOpen(false);
            }}
            onDismissRequest={() => setTimeOpen(false)}
          />
        ) : null}
        <FormNavRow label={t('work.clear')} onPress={() => change(null)} />
        {dateOpen ? (
          <DatePickerDialog
            confirmButtonLabel={t('common.save')}
            dismissButtonLabel={t('common.cancel')}
            initialDate={
              typeof value === 'string'
                ? field.type === 'date'
                  ? `${value}T12:00:00`
                  : new Date(parseMs(value)).toISOString()
                : new Date().toISOString()
            }
            onDateSelected={(d) => {
              if (field.type === 'datetime') {
                const previous = new Date(typeof value === 'string' ? parseMs(value) : Date.now());
                previous.setFullYear(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
                change(previous.toISOString());
              } else
                change(
                  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
                );
              setDateOpen(false);
            }}
            onDismissRequest={() => setDateOpen(false)}
          />
        ) : null}
      </FormSection>
    );
  return (
    <FormTextField
      label={label}
      state={state}
      onChangeText={(s) => change(field.type === 'number' ? (s.trim() ? Number(s) : null) : s)}
      multiline={field.type === 'long_text'}
      keyboard={
        field.type === 'number'
          ? 'decimal'
          : field.type === 'email'
            ? 'email'
            : field.type === 'phone'
              ? 'phone'
              : field.type === 'url'
                ? 'uri'
                : 'text'
      }
    />
  );
}
