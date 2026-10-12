/**
 * The SwiftUI form for a record's fields — one control per field type (spec
 * 20261011-mobile-tables-apps §3; the type → control map is
 * ./model/fields.ts `controlFor`): text / number as labelled text fields (the
 * system keyboard per type), long text as its own section, boolean a Toggle,
 * date the Reminders-style optional day (one inline calendar open at a time),
 * datetime a toggle + compact date/time picker, single select (and a person,
 * when the user directory is at hand) a menu Picker, multi-select / people /
 * related rows a row that opens the choice sheet (`app/tables/pick.tsx`),
 * computed fields read-only, attachments read-only — or, on submit forms and
 * app forms, photos from the camera / library uploaded as they are picked.
 *
 * Used by the record sheet (`app/tables/record-form.tsx`), submit-only forms
 * (`app/forms/[formId].tsx`) and app forms (`app/apps/form.tsx`). Render it
 * inside a `NativeForm`; native text fields read their initial value once, so
 * mount it after the record has loaded (the screens keep the Form itself from
 * the first frame).
 */

import React from 'react';
import {
  Button,
  DatePicker,
  HStack,
  Label,
  LabeledContent,
  Menu,
  Picker,
  ProgressView,
  Section,
  Spacer,
  Text,
  TextField,
  Toggle,
  useNativeState,
} from '@expo/ui/swift-ui';
import {
  datePickerStyle,
  foregroundStyle,
  keyboardType,
  lineLimit,
  multilineTextAlignment,
  pickerStyle,
  tag,
  textInputAutocapitalization,
} from '@expo/ui/swift-ui/modifiers';
import type { TableUser } from '../shared/tables-wire';
import { useT } from '../lib/i18n';
import { OptionalDateField } from '../projects/form-fields';
import { useTheme } from '../theme';
import { FormNavRow } from '../ui/native-form';
import {
  controlFor,
  keyboardFor,
  numberDraftValid,
  selectOptions,
  valueText,
  type FieldLike,
  type ValueLabels,
} from './model/fields';

export interface AttachmentDraft {
  id: number;
  name: string;
}

export interface FieldFormProps {
  fields: readonly FieldLike[];
  /** Field id → draft value (./model/fields.ts `draftValue`). */
  draft: Readonly<Record<string, unknown>>;
  onChange: (fieldId: number, value: unknown) => void;
  /** Fields the writer may change; the rest show read-only. */
  editable: ReadonlySet<number>;
  labels: ValueLabels;
  /** The user directory (Tables). Without it, person fields open the choice sheet (apps). */
  users?: readonly TableUser[];
  /** Opens the choice sheet for a multi-valued / related / (directory-less) person field. */
  onPick: (field: FieldLike) => void;
  /** Labels of chosen values the labels resolver cannot name (picked related rows, gateway people). */
  picked?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Which date field has its inline calendar open. */
  openDate: number | null;
  setOpenDate: (fieldId: number | null) => void;
  /** Attachment fields take photos here (submit forms, app forms); absent = read-only. */
  attachments?: {
    files: Readonly<Record<string, readonly AttachmentDraft[]>>;
    uploading: number | null;
    onAdd: (field: FieldLike, from: 'camera' | 'library') => void;
    onRemove: (field: FieldLike, fileId: number) => void;
  };
  /** Section title of the main rows. */
  title?: string;
}

export function FieldForm(props: FieldFormProps) {
  const t = useT();
  const { fields } = props;
  const rows = fields.filter((field) => controlFor(field) !== 'long_text' && controlFor(field) !== 'attachment');
  const longs = fields.filter((field) => controlFor(field) === 'long_text');
  const files = fields.filter((field) => controlFor(field) === 'attachment');
  return (
    <>
      {rows.length ? (
        <Section title={props.title}>
          {rows.map((field) => (
            <FieldRow key={field.id} field={field} {...props} />
          ))}
        </Section>
      ) : null}
      {longs.map((field) => (
        <Section key={field.id} title={required(field, t)}>
          {props.editable.has(field.id) ? (
            <LongTextField
              field={field}
              initial={String(props.draft[String(field.id)] ?? '')}
              onChange={props.onChange}
            />
          ) : (
            <Text>{valueText(field, props.draft[String(field.id)], props.labels) || '—'}</Text>
          )}
        </Section>
      ))}
      {files.map((field) => (
        <AttachmentSection key={field.id} field={field} {...props} />
      ))}
    </>
  );
}

function required(field: FieldLike, t: ReturnType<typeof useT>): string {
  return field.required ? `${field.name} · ${t('tables.form.required')}` : field.name;
}

function FieldRow(props: FieldFormProps & { field: FieldLike }) {
  const t = useT();
  const { hex } = useTheme();
  const { field, draft, onChange, editable, labels } = props;
  const key = String(field.id);
  const value = draft[key];
  const control = controlFor(field);
  const readOnly = !editable.has(field.id) || control === 'readonly';

  if (readOnly) {
    return (
      <LabeledContent label={field.type === 'ai' ? `${field.name} · ${t('tables.aiGenerated')}` : field.name}>
        <Text modifiers={[foregroundStyle(hex.secondaryLabel), lineLimit(3)]}>
          {valueText(field, value, labels) || '—'}
        </Text>
      </LabeledContent>
    );
  }

  switch (control) {
    case 'text':
    case 'number':
      return <TextRow field={field} initial={String(value ?? '')} onChange={onChange} />;
    case 'boolean':
      return <Toggle label={field.name} isOn={value === true} onIsOnChange={(on) => onChange(field.id, on)} />;
    case 'date':
      return (
        <OptionalDateField
          label={field.required ? `${field.name} *` : field.name}
          icon="calendar"
          value={typeof value === 'string' ? value : null}
          onChange={(stamp) => onChange(field.id, stamp)}
          expanded={props.openDate === field.id}
          onExpandedChange={(open) => props.setOpenDate(open ? field.id : null)}
        />
      );
    case 'datetime':
      return (
        <DateTimeRow
          field={field}
          value={typeof value === 'string' ? value : null}
          onChange={(iso) => onChange(field.id, iso)}
        />
      );
    case 'single_select':
      return (
        <Picker
          label={field.name}
          selection={typeof value === 'string' ? value : ''}
          onSelectionChange={(id) => onChange(field.id, id ? String(id) : null)}
          modifiers={[pickerStyle('menu')]}
        >
          <Text modifiers={[tag('')]}>{t('tables.form.none')}</Text>
          {selectOptions(field).map((option) => (
            <Text key={option.id} modifiers={[tag(option.id)]}>
              {option.label}
            </Text>
          ))}
        </Picker>
      );
    case 'user':
      if (props.users?.length) {
        const users = props.users;
        const current = typeof value === 'string' ? value : '';
        return (
          <Picker
            label={field.name}
            selection={current}
            onSelectionChange={(id) => onChange(field.id, id ? String(id) : null)}
            modifiers={[pickerStyle('menu')]}
          >
            <Text modifiers={[tag('')]}>{t('tables.form.none')}</Text>
            {/* keep a current person who is no longer in the directory */}
            {current && !users.some((user) => user.id === current) ? (
              <Text modifiers={[tag(current)]}>{labels.user(current) ?? current}</Text>
            ) : null}
            {users.map((user) => (
              <Text key={user.id} modifiers={[tag(user.id)]}>
                {user.nickname || user.email}
              </Text>
            ))}
          </Picker>
        );
      }
      return <PickRow {...props} />;
    case 'multi_select':
    case 'multi_user':
    case 'relation':
      return <PickRow {...props} />;
    default:
      return null;
  }
}

function TextRow({
  field,
  initial,
  onChange,
}: {
  field: FieldLike;
  initial: string;
  onChange: (fieldId: number, value: unknown) => void;
}) {
  const t = useT();
  const text = useNativeState(initial);
  const keyboard = keyboardFor(field.type);
  return (
    <LabeledContent label={<Label title={field.name} />}>
      <TextField
        text={text}
        placeholder={field.required ? t('tables.form.required') : ''}
        onTextChange={(next) => onChange(field.id, next)}
        modifiers={[
          keyboardType(keyboard),
          multilineTextAlignment('trailing'),
          ...(keyboard === 'default' ? [] : [textInputAutocapitalization('never')]),
        ]}
      />
    </LabeledContent>
  );
}

function LongTextField({
  field,
  initial,
  onChange,
}: {
  field: FieldLike;
  initial: string;
  onChange: (fieldId: number, value: unknown) => void;
}) {
  const text = useNativeState(initial);
  return (
    <TextField
      text={text}
      axis="vertical"
      placeholder={field.name}
      onTextChange={(next) => onChange(field.id, next)}
      modifiers={[lineLimit({ min: 2, max: 8 })]}
    />
  );
}

/** A datetime: a switch for "has a time", then the system's compact date + time picker. */
function DateTimeRow({
  field,
  value,
  onChange,
}: {
  field: FieldLike;
  value: string | null;
  onChange: (iso: string | null) => void;
}) {
  const date = value ? new Date(value) : null;
  const valid = date && !Number.isNaN(date.valueOf()) ? date : null;
  return (
    <>
      <Toggle label={field.name} isOn={!!valid} onIsOnChange={(on) => onChange(on ? new Date().toISOString() : null)} />
      {valid ? (
        <DatePicker
          selection={valid}
          displayedComponents={['date', 'hourAndMinute']}
          onDateChange={(next) => onChange(next.toISOString())}
          modifiers={[datePickerStyle('compact')]}
        />
      ) : null}
    </>
  );
}

/** A row that opens the choice sheet; its value is what is chosen now. */
function PickRow(props: FieldFormProps & { field: FieldLike }) {
  const t = useT();
  const { field, draft, labels, picked } = props;
  const value = draft[String(field.id)];
  const ids = Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value];
  const known = picked?.[String(field.id)] ?? {};
  // a picked label first (related rows, gateway people), else how the value reads
  const names = ids.map((id) => known[String(id)] ?? valueText(field, [id], labels));
  const joined = names.join(', ');
  const summary =
    ids.length === 0
      ? t('tables.form.choose')
      : joined.length <= 28
        ? joined
        : t('tables.form.nChosen', { n: ids.length });
  return (
    <FormNavRow
      label={field.required ? `${field.name} *` : field.name}
      value={summary}
      onPress={() => props.onPick(field)}
    />
  );
}

function AttachmentSection(props: FieldFormProps & { field: FieldLike }) {
  const t = useT();
  const { field, draft, labels, attachments } = props;
  const key = String(field.id);
  const editable = props.editable.has(field.id) && !!attachments;
  if (!editable) {
    const text = valueText(field, draft[key], labels);
    return (
      <Section title={field.name} footer={<Text>{t('tables.form.attachmentsReadOnly')}</Text>}>
        <Text>{text || '—'}</Text>
      </Section>
    );
  }
  const files = attachments.files[key] ?? [];
  const busy = attachments.uploading === field.id;
  return (
    <Section title={required(field, t)}>
      {files.map((file) => (
        <HStack key={file.id} spacing={10}>
          <Label title={file.name} systemImage="photo" />
          <Spacer />
          <Button
            label={t('tables.forms.removeFile')}
            role="destructive"
            onPress={() => attachments.onRemove(field, file.id)}
          />
        </HStack>
      ))}
      {busy ? (
        <HStack spacing={10}>
          <ProgressView />
          <Text>{t('tables.forms.uploading')}</Text>
        </HStack>
      ) : (
        <Menu label={<Label title={t('tables.forms.addPhoto')} systemImage="camera" />}>
          <Button
            label={t('tables.forms.takePhoto')}
            systemImage="camera"
            onPress={() => attachments.onAdd(field, 'camera')}
          />
          <Button
            label={t('tables.forms.chooseFromLibrary')}
            systemImage="photo.on.rectangle"
            onPress={() => attachments.onAdd(field, 'library')}
          />
        </Menu>
      )}
    </Section>
  );
}

/** A number draft that is not a number (the save button stays off). */
export function invalidNumbers(fields: readonly FieldLike[], draft: Readonly<Record<string, unknown>>): FieldLike[] {
  return fields.filter((field) => controlFor(field) === 'number' && !numberDraftValid(draft[String(field.id)]));
}
