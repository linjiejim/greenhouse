/**
 * An adapter's settings from its JSON schema (the catalog's config_schema): text, numbers,
 * switches, choices, lists of words and repeatable groups (an LLM's models). Keys the dictionary
 * knows get their words; others show as written.
 */

import { Plus, Trash2 } from 'lucide-react';
import { Button, Field, FieldGroup, IconButton, Input, Select, Switch, TextArea } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { MessageKey } from '../../i18n/zh';
import { useI18n } from '../../lib/i18n';

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  format?: string;
  default?: unknown;
  description?: string;
}

type Value = Record<string, unknown>;

const LABELS: Record<string, MessageKey> = {
  baseUrl: 'provider.field.baseUrl',
  models: 'provider.field.models',
  defaultModel: 'provider.field.defaultModel',
  id: 'provider.field.id',
  label: 'provider.field.label',
  contextWindow: 'provider.field.contextWindow',
  tools: 'provider.field.tools',
  vision: 'provider.field.vision',
  reasoning: 'provider.field.reasoning',
  model: 'provider.field.model',
  voice: 'provider.field.voice',
  region: 'provider.field.region',
  bucket: 'provider.field.bucket',
  price: 'provider.field.price',
  input: 'provider.field.priceInput',
  output: 'provider.field.priceOutput',
  cachedInput: 'provider.field.priceCached',
  fromAddress: 'provider.field.fromAddress',
  fromName: 'provider.field.fromName',
  domain: 'provider.field.domain',
  host: 'provider.field.host',
  port: 'provider.field.port',
  security: 'provider.field.security',
  username: 'provider.field.username',
};

const typeOf = (schema: JsonSchema) =>
  Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;

function useLabel() {
  const { t } = useI18n();
  return (key: string) => (LABELS[key] ? t(LABELS[key]!) : key);
}

function FieldFor({
  name,
  schema,
  value,
  required,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const label = useLabel()(name);
  const type = typeOf(schema);

  if (schema.enum?.length) {
    return (
      <FieldGroup label={label} required={required}>
        <Select
          label={label}
          value={value === undefined ? '' : String(value)}
          options={schema.enum.map((option) => String(option))}
          onChange={onChange}
        />
      </FieldGroup>
    );
  }
  if (type === 'boolean') {
    return (
      <div className="app-setting-row is-plain">
        <span className="app-setting-text">
          <strong>{label}</strong>
        </span>
        <Switch label={label} checked={value === true} onChange={onChange} />
      </div>
    );
  }
  if (type === 'integer' || type === 'number') {
    return (
      <Field label={label} required={required}>
        <Input
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
        />
      </Field>
    );
  }
  if (type === 'object' && schema.properties) {
    const object = value && typeof value === 'object' ? (value as Value) : {};
    return (
      <fieldset className="app-fieldset">
        <legend>{label}</legend>
        <SchemaFields
          schema={schema}
          value={object}
          onChange={(next) => onChange(Object.keys(next).length ? next : undefined)}
        />
      </fieldset>
    );
  }
  if (type === 'array' && schema.items && typeOf(schema.items) === 'object') {
    const list = Array.isArray(value) ? (value as Value[]) : [];
    return (
      <fieldset className="app-fieldset">
        <legend>{label}</legend>
        {list.map((item, index) => (
          <div key={index} className="app-fieldset-item">
            <SchemaFields
              schema={schema.items!}
              value={item}
              onChange={(next) => onChange(list.map((entry, at) => (at === index ? next : entry)))}
            />
            <IconButton
              label={t('provider.removeItem')}
              size="sm"
              onClick={() => onChange(list.filter((_, at) => at !== index))}
            >
              <Trash2 size={icon.sm} />
            </IconButton>
          </div>
        ))}
        <Button size="sm" onClick={() => onChange([...list, {}])}>
          <Plus size={icon.sm} />
          {t('provider.addItem', { name: label })}
        </Button>
      </fieldset>
    );
  }
  if (type === 'array') {
    const list = Array.isArray(value) ? (value as unknown[]).map(String) : [];
    return (
      <Field label={label} description={t('provider.onePerLine')}>
        <TextArea
          value={list.join('\n')}
          maxRows={6}
          onChange={(event) =>
            onChange(
              event.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
            )
          }
        />
      </Field>
    );
  }
  return (
    <Field label={label} required={required}>
      <Input
        type={schema.format === 'uri' ? 'url' : 'text'}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={schema.format === 'uri' ? 'https://' : undefined}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
      />
    </Field>
  );
}

export function SchemaFields({
  schema,
  value,
  onChange,
}: {
  schema: JsonSchema;
  value: Value;
  onChange: (value: Value) => void;
}) {
  const properties = Object.entries(schema.properties ?? {});
  return (
    <>
      {properties.map(([key, child]) => (
        <FieldFor
          key={key}
          name={key}
          schema={child}
          value={value[key]}
          required={schema.required?.includes(key) ?? false}
          onChange={(next) => {
            const copy = { ...value };
            if (next === undefined) delete copy[key];
            else copy[key] = next;
            onChange(copy);
          }}
        />
      ))}
    </>
  );
}
