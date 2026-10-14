/**
 * A field's value shown (CellValue) and changed (FieldInput), the same in the grid, on cards and
 * in the record drawer. Options are colored chips, members their avatar and name, links the
 * linked records' titles, files their names.
 */

import { useRef, useState, type ReactNode } from 'react';
import {
  AtSign,
  Calendar,
  CalendarClock,
  CheckSquare,
  CircleDot,
  FileText,
  GitBranch,
  Hash,
  Link2,
  List,
  ListTree,
  Paperclip,
  Phone,
  Plus,
  Sigma,
  Sparkles,
  Spline,
  Text,
  Type,
  User,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  Checkbox,
  DatePicker,
  IconButton,
  Input,
  MultiSelect,
  Select,
  TextArea,
  type SelectOption,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import {
  isEmptyValue,
  isComputedType,
  isComputedError,
  isComputedPending,
  valueTypeOf,
  zonedInstant,
  zonedParts,
  type Field,
  type FieldType,
  type MemberSummary,
  type RecordFile,
  type SelectOption as OptionDef,
} from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { useTitles } from '../../data/tables';
import { usePeople } from '../../data/people';
import { api } from '../../lib/api';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { MemberAvatar } from '../../shell/MemberAvatar';
import { tablesError } from './errors';
import { dayOfValue, linkTable, type CellLookups } from './model';

const TYPE_ICONS: Record<FieldType, LucideIcon> = {
  text: Type,
  long_text: Text,
  number: Hash,
  checkbox: CheckSquare,
  date: Calendar,
  datetime: CalendarClock,
  single_select: CircleDot,
  multi_select: List,
  member: User,
  url: Link2,
  email: AtSign,
  phone: Phone,
  attachment: Paperclip,
  relation: Spline,
  parent: GitBranch,
  dependency: Spline,
  formula: Sigma,
  lookup: ListTree,
  rollup: Sigma,
  ai: Sparkles,
};

export function FieldIcon({ type, size = icon.sm }: { type: FieldType; size?: number }) {
  const Icon = TYPE_ICONS[type];
  return <Icon size={size} strokeWidth={icon.stroke} className="app-tb-field-icon" aria-hidden />;
}

/** A day as 「10 月 16 日」 (with the year when not this one), or "Oct 16" (content.md, 时间). */
export function shortDay(day: string, locale: 'zh' | 'en'): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const thisYear = new Date().getFullYear() === year;
  if (locale === 'zh') return `${thisYear ? '' : `${year} 年 `}${month} 月 ${date} 日`;
  const name = new Date(Date.UTC(year, month - 1, date)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
    ...(thisYear ? {} : { year: 'numeric' }),
  });
  return name;
}

export function shortDateTime(iso: string, locale: 'zh' | 'en', timeZone: string): string {
  const parts = zonedParts(iso, timeZone);
  if (!parts) return '';
  const day = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  return `${shortDay(day, locale)} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function OptionChip({ option }: { option: OptionDef }) {
  return <span className={cx('app-tb-chip', `is-${option.color}`)}>{option.label}</span>;
}

function MemberChip({ member, id }: { member: MemberSummary | undefined; id: string }) {
  const { t } = useI18n();
  const name = member?.name ?? t('tables.activity.someone');
  return (
    <span className="app-tb-person" key={id}>
      <MemberAvatar name={name} url={member?.avatar_url} size={18} />
      <span>{name}</span>
    </span>
  );
}

const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []);

/** A value as it reads in a cell, on a card or in the drawer. */
export function CellValue({
  field,
  value,
  lookups,
  onOpenRecord,
}: {
  field: Field;
  value: unknown;
  lookups: CellLookups;
  /** Links open the linked record. */
  onOpenRecord?: (id: string) => void;
}) {
  const { locale, t } = useI18n();
  if (isComputedError(value))
    return (
      <span className="app-tb-computed-error" role="status">
        {t(`tables.computed.${value.error}`)}
      </span>
    );
  if (isComputedPending(value))
    return (
      <span className="app-muted" role="status">
        {t('tables.computed.pending')}
      </span>
    );
  if (field.type === 'lookup')
    return (
      <span className="app-tb-text">
        {Array.isArray(value)
          ? value.map((entry) => (Array.isArray(entry) ? entry.join(', ') : String(entry ?? ''))).join(', ')
          : ''}
      </span>
    );
  const kind = valueTypeOf(field);
  if (kind === 'checkbox') {
    return value === true ? <CheckSquare size={icon.md} strokeWidth={icon.stroke} className="app-tb-check" /> : null;
  }
  if (isEmptyValue(value)) return null;
  switch (kind) {
    case 'number': {
      if (typeof value !== 'number') return null;
      const digits = field.config.precision;
      return (
        <span className="app-tb-number">
          {value.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
            minimumFractionDigits: digits ?? 0,
            maximumFractionDigits: digits ?? 6,
          })}
        </span>
      );
    }
    case 'date':
      return <span className="app-tb-date">{shortDay(String(value), locale)}</span>;
    case 'datetime':
      return <span className="app-tb-date">{shortDateTime(String(value), locale, lookups.timeZone)}</span>;
    case 'single_select': {
      const option = field.config.options?.find((entry) => entry.id === value);
      return option ? <OptionChip option={option} /> : null;
    }
    case 'multi_select':
      return (
        <span className="app-tb-chips">
          {list(value).map((id) => {
            const option = field.config.options?.find((entry) => entry.id === id);
            return option ? <OptionChip key={id} option={option} /> : null;
          })}
        </span>
      );
    case 'member':
      return (
        <span className="app-tb-chips">
          {list(value).map((id) => (
            <MemberChip key={id} id={id} member={lookups.members.get(id)} />
          ))}
        </span>
      );
    case 'url':
      if (!/^https?:\/\//i.test(String(value).trim())) return <span className="app-tb-text">{String(value)}</span>;
      return (
        <a className="app-tb-link" href={String(value)} target="_blank" rel="noreferrer noopener">
          {String(value)}
        </a>
      );
    case 'email':
      return (
        <a className="app-tb-link" href={`mailto:${encodeURIComponent(String(value))}`}>
          {String(value)}
        </a>
      );
    case 'phone':
      return (
        <a className="app-tb-link" href={`tel:${String(value)}`}>
          {String(value)}
        </a>
      );
    case 'attachment':
      return (
        <span className="app-tb-chips">
          {list(value).map((id) => {
            const file = lookups.files[id];
            if (!file) return null;
            return (
              <a key={id} className="app-tb-file" href={file.url} target="_blank" rel="noreferrer noopener">
                {file.content_type.startsWith('image/') ? (
                  <img src={file.url} alt="" />
                ) : (
                  <FileText size={icon.sm} strokeWidth={icon.stroke} aria-hidden />
                )}
                <span>{file.name}</span>
              </a>
            );
          })}
        </span>
      );
    case 'relation':
    case 'parent':
    case 'dependency':
      return (
        <span className="app-tb-chips">
          {list(value).map((id) => {
            const title = lookups.linked[id]?.title ?? '';
            return onOpenRecord ? (
              <button
                key={id}
                type="button"
                className="app-tb-record-chip"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenRecord(id);
                }}
              >
                {title || '—'}
              </button>
            ) : (
              <span key={id} className="app-tb-record-chip">
                {title || '—'}
              </span>
            );
          })}
        </span>
      );
    default:
      return <span className="app-tb-text">{String(value)}</span>;
  }
}

/** Members as picker options, with their faces. */
export function memberOptions(members: readonly MemberSummary[]): SelectOption[] {
  return members.map((member) => ({
    value: member.id,
    label: member.name,
    description: member.email,
    icon: <MemberAvatar name={member.name} url={member.avatar_url} size={18} />,
  }));
}

const optionList = (field: Field): SelectOption[] =>
  (field.config.options ?? []).map((option) => ({
    value: option.id,
    label: option.label,
    icon: <span className={cx('app-tb-swatch', `is-${option.color}`)} aria-hidden />,
  }));

function LinkPicker({
  field,
  value,
  onChange,
  label,
  inline,
  onDone,
  recordId,
  linked,
}: {
  field: Field;
  value: string[];
  onChange: (value: string[]) => void;
  label: string;
  inline: boolean;
  onDone?: () => void;
  recordId?: string;
  /** Titles the view already has, so the chosen records read right before the list loads. */
  linked: CellLookups['linked'];
}) {
  const titles = useTitles(linkTable(field));
  const single = field.type === 'parent' || (field.type === 'relation' && !field.config.multiple);
  const listed = new Set(titles.data?.items.map((item) => item.id));
  const options = [
    ...value.filter((id) => !listed.has(id)).map((id) => ({ value: id, label: linked[id]?.title || '—' })),
    ...(titles.data?.items ?? [])
      .filter((item) => field.type === 'relation' || item.id !== recordId)
      .map((item) => ({ value: item.id, label: item.title || '—' })),
  ];
  if (single) {
    return (
      <Select
        label={label}
        size={inline ? 'sm' : 'md'}
        value={value[0] ?? ''}
        options={[{ value: '', label: '—' }, ...options]}
        searchable
        defaultOpen={inline}
        onClose={onDone}
        onChange={(next) => onChange(next ? [next] : [])}
      />
    );
  }
  return (
    <MultiSelect
      label={label}
      value={value}
      options={options}
      defaultOpen={inline}
      onClose={onDone}
      onChange={onChange}
    />
  );
}

function Attachments({
  value,
  onChange,
  lookups,
  baseId,
  onFiles,
  label,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  lookups: CellLookups;
  baseId: string;
  onFiles: (files: RecordFile[]) => void;
  label: string;
}) {
  const { t } = useI18n();
  const notify = useNotify();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (picked: FileList | null) => {
    if (!picked?.length) return;
    setBusy(true);
    try {
      const stored = await Promise.all([...picked].map((file) => api.tables.bases.upload(baseId, file)));
      onFiles(stored);
      onChange([...value, ...stored.map((file) => file.id)]);
    } catch (error) {
      notify(tablesError(error, t));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="app-tb-attachments">
      {value.map((id) => {
        const file = lookups.files[id];
        return (
          <span key={id} className="app-chip">
            <Paperclip size={icon.sm} strokeWidth={icon.stroke} aria-hidden />
            <span className="app-chip-text">{file?.name ?? id}</span>
            <IconButton
              size="sm"
              label={t('tables.record.removeFile', { name: file?.name ?? '' })}
              onClick={() => onChange(value.filter((entry) => entry !== id))}
            >
              <X size={icon.sm} strokeWidth={icon.stroke} />
            </IconButton>
          </span>
        );
      })}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label={label}
        onChange={(event) => void upload(event.target.files)}
      />
      <Button size="sm" loading={busy} onClick={() => input.current?.click()}>
        <Plus size={icon.sm} strokeWidth={icon.stroke} />
        {t('tables.record.upload')}
      </Button>
    </div>
  );
}

/** The time of day of a date-time value in the reader's zone, as HH:mm. */
const timeOf = (value: unknown, timeZone: string) => {
  const parts = typeof value === 'string' ? zonedParts(value, timeZone) : null;
  return parts ? `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}` : '09:00';
};

/**
 * A control for a field's value. `inline` is the grid's editor: compact, pickers open at once,
 * and `onDone` ends the edit when a picker closes. Text kinds report every keystroke; the caller
 * decides when to save.
 */
export function FieldInput({
  field,
  value,
  onChange,
  lookups,
  baseId,
  inline = false,
  onDone,
  onFiles,
  recordId,
  label,
  autoFocus,
  onKeyDown,
}: {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  lookups: CellLookups;
  baseId: string;
  inline?: boolean;
  onDone?: () => void;
  onFiles?: (files: RecordFile[]) => void;
  recordId?: string;
  label?: string;
  autoFocus?: boolean;
  onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
}): ReactNode {
  const { t } = useI18n();
  const { members } = usePeople();
  const name = label ?? field.name;
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  if (isComputedType(field.type)) return <CellValue field={field} value={value} lookups={lookups} />;
  switch (field.type) {
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return (
        <Input
          aria-label={name}
          className={cx(inline && 'app-tb-inline-input')}
          type={
            field.type === 'url' ? 'url' : field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'
          }
          value={text}
          autoFocus={autoFocus}
          onKeyDown={onKeyDown}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'long_text':
      return (
        <TextArea
          aria-label={name}
          className={cx(inline && 'app-tb-inline-textarea')}
          rows={inline ? 4 : 3}
          value={text}
          autoFocus={autoFocus}
          onKeyDown={onKeyDown}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'number':
      return (
        <Input
          aria-label={name}
          className={cx(inline && 'app-tb-inline-input', 'app-tb-number-input')}
          inputMode="decimal"
          value={text}
          autoFocus={autoFocus}
          onKeyDown={onKeyDown}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'checkbox':
      return <Checkbox aria-label={name} checked={value === true} onChange={(checked) => onChange(checked)} />;
    case 'date':
      return (
        <DatePicker
          label={name}
          value={typeof value === 'string' ? value : ''}
          defaultOpen={inline}
          onClose={onDone}
          onChange={(day) => onChange(day || null)}
        />
      );
    case 'datetime': {
      const day = dayOfValue(value, lookups.timeZone) ?? '';
      return (
        <span className="app-tb-datetime">
          <DatePicker
            label={name}
            value={day}
            defaultOpen={inline}
            onClose={onDone}
            onChange={(next) =>
              onChange(next ? zonedInstant(next, timeOf(value, lookups.timeZone), lookups.timeZone) : null)
            }
          />
          {!inline && day && (
            <Input
              aria-label={t('tables.record.time')}
              className="app-tb-time"
              type="time"
              value={timeOf(value, lookups.timeZone)}
              onChange={(event) =>
                event.target.value && onChange(zonedInstant(day, event.target.value, lookups.timeZone))
              }
            />
          )}
        </span>
      );
    }
    case 'single_select':
      return (
        <Select
          label={name}
          size={inline ? 'sm' : 'md'}
          value={typeof value === 'string' ? value : ''}
          options={[{ value: '', label: '—' }, ...optionList(field)]}
          defaultOpen={inline}
          onClose={onDone}
          onChange={(next) => onChange(next || null)}
        />
      );
    case 'multi_select':
      return (
        <MultiSelect
          label={name}
          value={list(value)}
          options={optionList(field)}
          defaultOpen={inline}
          onClose={onDone}
          onChange={(next) => onChange(next)}
        />
      );
    case 'member':
      return field.config.multiple ? (
        <MultiSelect
          label={name}
          value={list(value)}
          options={memberOptions(members)}
          defaultOpen={inline}
          onClose={onDone}
          onChange={(next) => onChange(next)}
        />
      ) : (
        <Select
          label={name}
          size={inline ? 'sm' : 'md'}
          value={list(value)[0] ?? ''}
          options={[{ value: '', label: '—' }, ...memberOptions(members)]}
          defaultOpen={inline}
          onClose={onDone}
          onChange={(next) => onChange(next ? [next] : [])}
        />
      );
    case 'relation':
    case 'parent':
    case 'dependency':
      return (
        <LinkPicker
          field={field}
          value={list(value)}
          label={name}
          inline={inline}
          onDone={onDone}
          recordId={recordId}
          linked={lookups.linked}
          onChange={(next) => onChange(next)}
        />
      );
    case 'attachment':
      return (
        <Attachments
          value={list(value)}
          lookups={lookups}
          baseId={baseId}
          label={name}
          onFiles={(stored) => onFiles?.(stored)}
          onChange={(next) => onChange(next)}
        />
      );
  }
}

/** What a text control's text means for its field: a number, or null for nothing. */
export function fromText(field: Field, value: unknown): unknown {
  if (field.type === 'number') {
    if (typeof value === 'number') return value;
    const text = String(value ?? '').replace(/[,\s，]/g, '');
    if (!text) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : value;
  }
  if (typeof value === 'string' && !value.trim() && field.type !== 'long_text') return null;
  return value;
}
