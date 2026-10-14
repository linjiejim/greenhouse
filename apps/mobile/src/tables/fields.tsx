import { useAttachments } from './use-attachments';
import { saveFile } from '../chat/file-card';
import { useFieldChoices } from './field-choices';
import { Section, TextField, Toggle, Picker, Text, DatePicker, useNativeState } from '@expo/ui/swift-ui';
import { disabled, pickerStyle, tag, keyboardType } from '@expo/ui/swift-ui/modifiers';
import { FormNavRow, FormCheckRow } from '../ui/native-form';
import { useT } from '../lib/i18n';
import { parseMs } from '../data/time';
import { computed, cellText, choiceValue, type EditableField } from './model';
export interface FieldProps {
  field: EditableField;
  value: unknown;
  change: (value: unknown) => void;
  readonly?: boolean;
  disabled?: boolean;
  uploadPath?: string;
  files?: Record<string, { name: string; url?: string }>;
  options?: { id: string; label: string }[];
}
export function FieldEditor({
  field,
  value,
  change,
  readonly,
  disabled: inactive = false,
  options,
  uploadPath,
  files,
}: FieldProps) {
  const t = useT();
  const attachments = useAttachments(uploadPath);
  const knownFiles = { ...files, ...attachments.files };
  const text = useNativeState(value == null ? '' : String(value));
  const label = `${field.name}${field.required ? ' *' : ''}`;
  const choicesResource = useFieldChoices(field, !readonly && options === undefined);
  const choices = field.config.options ?? options ?? choicesResource.data ?? [];
  if (field.type === 'attachment')
    return (
      <Section modifiers={[disabled(inactive)]} title={label}>
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
          <FormNavRow
            label={attachments.busy ? t('work.saving') : t('work.upload')}
            onPress={() =>
              void attachments.add().then((id) => {
                if (id) change([...(Array.isArray(value) ? value : []), id]);
              })
            }
          />
        ) : null}
      </Section>
    );
  if (readonly || computed(field.type))
    return (
      <Section
        modifiers={[disabled(inactive)]}
        title={label}
        footer={<Text>{computed(field.type) ? t('work.computed') : t('work.readonly')}</Text>}
      >
        <Text>
          {(field.type === 'checkbox' && typeof value === 'boolean'
            ? t(value ? 'common.yes' : 'common.no')
            : cellText(field, value, undefined, Object.fromEntries(choices.map((o) => [o.id, o.label])))) ||
            t('work.emptyValue')}
        </Text>
      </Section>
    );
  if (field.type === 'checkbox')
    return (
      <Section modifiers={[disabled(inactive)]}>
        <Toggle label={label} isOn={!!value} onIsOnChange={change} />
      </Section>
    );
  if (['single_select', 'multi_select', 'member', 'relation', 'parent', 'dependency'].includes(field.type)) {
    const multi = field.type === 'multi_select' || !!field.config.multiple || field.type === 'dependency';
    const picked = Array.isArray(value) ? value : value ? [value] : [];
    return (
      <Section modifiers={[disabled(inactive)]} title={label}>
        {multi ? (
          choices.map((o) => (
            <FormCheckRow
              key={o.id}
              label={o.label}
              choice="multiple"
              checked={picked.includes(o.id)}
              onPress={() => change(picked.includes(o.id) ? picked.filter((id) => id !== o.id) : [...picked, o.id])}
            />
          ))
        ) : (
          <Picker
            label={label}
            selection={String(value ?? '')}
            onSelectionChange={(id) => change(choiceValue(field, id))}
            modifiers={[pickerStyle('menu')]}
          >
            <Text modifiers={[tag('')]}>{t('work.emptyValue')}</Text>
            {choices.map((o) => (
              <Text key={o.id} modifiers={[tag(o.id)]}>
                {o.label}
              </Text>
            ))}
          </Picker>
        )}
      </Section>
    );
  }
  if (field.type === 'date' || field.type === 'datetime') {
    const parsed = typeof value === 'string' ? parseMs(field.type === 'date' ? `${value}T12:00:00` : value) : NaN;
    const date = new Date(Number.isFinite(parsed) ? parsed : Date.now());
    return (
      <Section modifiers={[disabled(inactive)]} title={label}>
        <DatePicker
          title={label}
          selection={date}
          displayedComponents={field.type === 'date' ? ['date'] : ['date', 'hourAndMinute']}
          onDateChange={(d) =>
            change(
              field.type === 'date'
                ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                : d.toISOString(),
            )
          }
        />
        <FormCheckRow label={t('work.clear')} checked={value == null} onPress={() => change(null)} />
      </Section>
    );
  }
  return (
    <Section modifiers={[disabled(inactive)]} title={label}>
      <TextField
        text={text}
        placeholder={label}
        axis={field.type === 'long_text' ? 'vertical' : 'horizontal'}
        maxLength={field.type === 'long_text' ? 100000 : 10000}
        modifiers={[
          keyboardType(
            field.type === 'number'
              ? 'decimal-pad'
              : field.type === 'email'
                ? 'email-address'
                : field.type === 'phone'
                  ? 'phone-pad'
                  : field.type === 'url'
                    ? 'url'
                    : 'default',
          ),
        ]}
        onTextChange={(s) => change(field.type === 'number' ? (s.trim() ? Number(s) : null) : s)}
      />
    </Section>
  );
}
