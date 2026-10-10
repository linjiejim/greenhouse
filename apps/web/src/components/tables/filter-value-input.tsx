/**
 * The value control of one filter clause, chosen by `filterValueKind`: text,
 * number, date (tokens + a specific date), yes/no, option / user pickers (with
 * `$me`), multi-choice lists, record ids. Part of `FilterEditor`.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { TableFilterClause } from '@greenhouse/types/tables';
import { Checkbox, Input, Select } from '../ui';
import type { TableUserOption } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';
import { fieldConfig } from './field-types';
import { isoToLocalInput } from './field-draft';
import {
  DATE_FILTER_TOKENS,
  DATETIME_FILTER_TOKENS,
  isFilterToken,
  USER_FILTER_TOKEN,
  type FilterTarget,
  type FilterValueKind,
} from './filter-model';

const CUSTOM_DATE = '__custom';

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A text box that keeps what is typed (`1.`, `12, `) while emitting the parsed value. */
function DraftInput({
  value,
  format,
  parse,
  onChange,
  ...props
}: {
  value: unknown;
  format: (value: unknown) => string;
  parse: (text: string) => unknown;
  onChange: (value: unknown) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'size'>) {
  const [text, setText] = useState(() => format(value));
  const emitted = useRef(value);
  useEffect(() => {
    if (!sameValue(value, emitted.current)) {
      emitted.current = value;
      setText(format(value));
    }
  }, [format, value]);
  return (
    <Input
      {...props}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = parse(event.target.value);
        emitted.current = parsed;
        onChange(parsed);
      }}
    />
  );
}

const formatText = (value: unknown) => (typeof value === 'string' ? value : '');
const parseText = (text: string) => (text === '' ? undefined : text);
const formatNumber = (value: unknown) => (typeof value === 'number' ? String(value) : '');
const parseNumber = (text: string) => (text.trim() === '' || !Number.isFinite(Number(text)) ? undefined : Number(text));
const formatRecords = (value: unknown) =>
  Array.isArray(value) ? value.join(', ') : typeof value === 'number' ? String(value) : '';

function ChoiceList({
  label,
  choices,
  value,
  onChange,
}: {
  label: string;
  choices: Array<{ value: string; label: string }>;
  value: unknown;
  onChange: (value: string[] | undefined) => void;
}) {
  const selected = Array.isArray(value) ? value.map(String) : [];
  return (
    <div
      role="group"
      aria-label={label}
      className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-edge px-2 py-1.5"
    >
      {choices.map((choice) => (
        <Checkbox
          key={choice.value}
          label={choice.label}
          checked={selected.includes(choice.value)}
          onChange={(event) => {
            const next = event.target.checked
              ? [...new Set([...selected, choice.value])]
              : selected.filter((entry) => entry !== choice.value);
            onChange(next.length > 0 ? next : undefined);
          }}
        />
      ))}
    </div>
  );
}

function DateValue({
  kind,
  value,
  onChange,
}: {
  kind: 'date' | 'datetime';
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const t = useT();
  const [custom, setCustom] = useState(() => typeof value === 'string' && value !== '' && !isFilterToken(value));
  const tokens = kind === 'datetime' ? DATETIME_FILTER_TOKENS : DATE_FILTER_TOKENS;
  const choice = isFilterToken(value) ? value : custom ? CUSTOM_DATE : '';
  return (
    <div className="flex min-w-0 gap-2">
      <Select
        aria-label={t('tables.value')}
        value={choice}
        onChange={(event) => {
          const next = event.target.value;
          setCustom(next === CUSTOM_DATE);
          onChange(next === CUSTOM_DATE || next === '' ? undefined : next);
        }}
      >
        <option value="">{t('tables.filter.chooseValue')}</option>
        {tokens.map((entry) => (
          <option key={entry.token} value={entry.token}>
            {t(entry.labelKey)}
          </option>
        ))}
        <option value={CUSTOM_DATE}>{t('tables.filter.specificDate')}</option>
      </Select>
      {choice === CUSTOM_DATE && (
        <Input
          aria-label={t('tables.value')}
          type={kind === 'date' ? 'date' : 'datetime-local'}
          value={typeof value === 'string' ? (kind === 'date' ? value : isoToLocalInput(value)) : ''}
          onChange={(event) => {
            const text = event.target.value;
            if (!text) return onChange(undefined);
            onChange(kind === 'date' ? text : new Date(text).toISOString());
          }}
        />
      )}
    </div>
  );
}

export function FilterValueInput({
  target,
  kind,
  clause,
  users,
  onChange,
}: {
  target: FilterTarget;
  kind: FilterValueKind;
  clause: TableFilterClause;
  users: TableUserOption[];
  onChange: (value: unknown) => void;
}) {
  const t = useT();
  const label = t('tables.value');
  const value = clause.value;
  const options =
    target.kind === 'field'
      ? (fieldConfig(target.field).options ?? []).map((option) => ({ value: option.id, label: option.label }))
      : [];
  const people = [
    { value: USER_FILTER_TOKEN.token, label: t(USER_FILTER_TOKEN.labelKey) },
    ...users.map((user) => ({ value: user.id, label: user.nickname })),
  ];

  switch (kind) {
    case 'none':
      return <Input aria-label={label} value="" disabled placeholder={t('tables.noValueNeeded')} />;
    case 'number':
      return (
        <DraftInput
          aria-label={label}
          type="number"
          step="any"
          placeholder={label}
          value={value}
          format={formatNumber}
          parse={parseNumber}
          onChange={onChange}
        />
      );
    case 'date':
    case 'datetime':
      return <DateValue kind={kind} value={value} onChange={onChange} />;
    case 'boolean':
      return (
        <Select
          aria-label={label}
          value={typeof value === 'boolean' ? String(value) : ''}
          onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}
        >
          <option value="">{t('tables.filter.chooseValue')}</option>
          <option value="true">{t('common.yes')}</option>
          <option value="false">{t('common.no')}</option>
        </Select>
      );
    case 'option':
    case 'user': {
      const choices = kind === 'option' ? options : people;
      return (
        <Select
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          <option value="">{t('tables.filter.chooseValue')}</option>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Select>
      );
    }
    case 'options':
    case 'users':
      return (
        <ChoiceList label={label} choices={kind === 'options' ? options : people} value={value} onChange={onChange} />
      );
    case 'record': {
      const multiple = target.kind === 'field' && fieldConfig(target.field).relation?.multiple === true;
      return (
        <DraftInput
          aria-label={label}
          placeholder={t(multiple ? 'tables.recordIdsPlaceholder' : 'tables.recordIdPlaceholder')}
          value={value}
          format={formatRecords}
          parse={(text) => {
            const ids = text
              .split(/[,;\s]+/)
              .map((entry) => Number(entry.replace(/^#/, '')))
              .filter((id) => Number.isInteger(id) && id > 0);
            if (ids.length === 0) return undefined;
            return multiple ? ids : ids[0];
          }}
          onChange={onChange}
        />
      );
    }
    default:
      return (
        <DraftInput
          aria-label={label}
          placeholder={label}
          value={value}
          format={formatText}
          parse={parseText}
          onChange={onChange}
        />
      );
  }
}
