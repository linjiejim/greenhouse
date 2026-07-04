/**
 * CrudFieldInput — renders one form field from its FieldDef, wired to the form
 * value. Built on @greenhouse/ui primitives so it inherits the design system
 * (and branding) for free. Unknown/extension types resolve through the registry.
 */

import React, { useEffect, useState } from 'react';
import { Input, Textarea, Select, Toggle, Checkbox, Tag } from '@greenhouse/ui/components/ui';
import { X } from '@greenhouse/ui/lib/icons';

import type { FieldDef, OptionsSource, SelectOption } from './schema.js';
import { getCrudField } from './registry.js';
import { formatCell } from './util.js';

function useOptions(source: OptionsSource | undefined): SelectOption[] {
  const [opts, setOpts] = useState<SelectOption[]>(Array.isArray(source) ? source : []);
  useEffect(() => {
    let alive = true;
    if (typeof source === 'function') {
      source()
        .then((r) => alive && setOpts(r))
        .catch(() => alive && setOpts([]));
    } else if (Array.isArray(source)) {
      setOpts(source);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return opts;
}

export interface CrudFieldInputProps<TRow> {
  field: FieldDef<TRow>;
  value: unknown;
  onChange: (value: unknown) => void;
  form: Record<string, unknown>;
  mode: 'add' | 'edit';
  disabled?: boolean;
}

export function CrudFieldInput<TRow>({ field, value, onChange, form, mode, disabled }: CrudFieldInputProps<TRow>) {
  const placeholder = 'placeholder' in field ? field.placeholder : undefined;

  switch (field.type) {
    case 'text':
    case 'password':
    case 'email':
    case 'url': {
      const htmlType = field.type === 'text' ? 'text' : field.type;
      return (
        <Input
          type={htmlType}
          value={(value as string) ?? ''}
          maxLength={field.maxLength}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    case 'textarea':
      return (
        <Textarea
          value={(value as string) ?? ''}
          rows={field.rows ?? 4}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'number':
      return (
        <Input
          type="number"
          value={value === undefined || value === null ? '' : (value as number)}
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'select':
      return <SelectField source={field.options} value={value} onChange={onChange} disabled={disabled} />;
    case 'radio':
      return <RadioField source={field.options} value={value} onChange={onChange} disabled={disabled} />;
    case 'multi-select':
      return <MultiSelectField source={field.options} value={value} onChange={onChange} disabled={disabled} />;
    case 'tags':
      return <TagsField value={value} onChange={onChange} disabled={disabled} placeholder={placeholder} />;
    case 'switch':
      return <Toggle checked={!!value} onChange={onChange} disabled={disabled} />;
    case 'date':
      return (
        <Input
          type="date"
          value={(value as string) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'datetime':
      return (
        <Input
          type="datetime-local"
          value={(value as string) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'json':
      return <JsonField value={value} onChange={onChange} disabled={disabled} />;
    case 'readonly':
      return <div className="text-sm text-fg-secondary py-1.5">{formatCell(undefined, value)}</div>;
    case 'custom':
      return <>{field.render({ value, onChange, form, mode, disabled, placeholder })}</>;
    case 'extension': {
      const Comp = getCrudField(field.name);
      if (!Comp) return <div className="text-xs text-danger">Unknown field: {field.name}</div>;
      return <>{Comp({ value, onChange, form, mode, disabled, placeholder, config: field.config })}</>;
    }
    default:
      return null;
  }
}

function SelectField({
  source,
  value,
  onChange,
  disabled,
}: {
  source: OptionsSource;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  const options = useOptions(source);
  return (
    <Select
      value={value === undefined || value === null ? '' : String(value)}
      disabled={disabled}
      onChange={(e) => {
        const raw = e.target.value;
        const match = options.find((o) => String(o.value) === raw);
        onChange(match ? match.value : raw);
      }}
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

function RadioField({
  source,
  value,
  onChange,
  disabled,
}: {
  source: OptionsSource;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  const options = useOptions(source);
  return (
    <div className="flex flex-wrap gap-3 py-1">
      {options.map((o) => (
        <label key={String(o.value)} className="flex items-center gap-1.5 text-sm cursor-pointer">
          <input
            type="radio"
            checked={String(value) === String(o.value)}
            disabled={disabled}
            onChange={() => onChange(o.value)}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

function MultiSelectField({
  source,
  value,
  onChange,
  disabled,
}: {
  source: OptionsSource;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  const options = useOptions(source);
  const arr = Array.isArray(value) ? (value as unknown[]) : [];
  const toggle = (v: SelectOption['value']) => {
    const has = arr.some((x) => String(x) === String(v));
    onChange(has ? arr.filter((x) => String(x) !== String(v)) : [...arr, v]);
  };
  return (
    <div className="flex flex-wrap gap-2 py-1">
      {options.map((o) => (
        <Checkbox
          key={String(o.value)}
          checked={arr.some((x) => String(x) === String(o.value))}
          disabled={disabled}
          onChange={() => toggle(o.value)}
          label={o.label}
        />
      ))}
    </div>
  );
}

function TagsField({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const tags = Array.isArray(value) ? (value as string[]) : [];
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setDraft('');
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {tags.map((tag) => (
          <Tag key={tag} icon={undefined}>
            {tag}
            {!disabled && (
              <button
                type="button"
                className="ml-1 text-fg-faint hover:text-danger"
                onClick={() => onChange(tags.filter((x) => x !== tag))}
              >
                <X size={10} />
              </button>
            )}
          </Tag>
        ))}
      </div>
      <Input
        value={draft}
        disabled={disabled}
        placeholder={placeholder ?? 'Type and press Enter'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

function JsonField({
  value,
  onChange,
  disabled,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  // null (a nullable json column) shows an empty box, not the literal text "null".
  const [text, setText] = useState(() => (value == null ? '' : JSON.stringify(value, null, 2)));
  const [error, setError] = useState('');
  return (
    <div>
      <Textarea
        value={text}
        rows={6}
        disabled={disabled}
        className="font-mono text-xs"
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === '') {
            setError('');
            onChange(null);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value));
            setError('');
          } catch {
            setError('Invalid JSON');
          }
        }}
      />
      {error && <p className="text-[11px] text-danger mt-0.5">{error}</p>}
    </div>
  );
}
