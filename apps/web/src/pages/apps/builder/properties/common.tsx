/**
 * Small pieces every card's properties use: a titled section, the server's
 * problems for one setting, a condition (the shared `FilterEditor`, applied
 * only once complete), an ordered field picker, a roles picker and the
 * value rows (the shared `FieldValuesEditor`, kept as drafts while typing).
 *
 * The spec only ever receives finished values: a half-typed condition or a
 * number still being typed lives in local state and is written once it means
 * something, so autosave never stores (or the server never rejects) a value
 * that is mid-edit.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppRole, AppSpecError } from '@greenhouse/types/apps';
import {
  TABLE_SYSTEM_FIELDS,
  type TableFieldValueEntry,
  type TableFilterGroup,
  type TableSystemField,
} from '@greenhouse/types/tables';
import { Checkbox, FilterPills, IconButton, Input, Select, Textarea } from '../../../../components/ui';
import { FormField } from '../../../../components/form';
import { FilterEditor, completedFilterGroup } from '../../../../components/tables';
import { SYSTEM_FIELD_LABEL_KEYS } from '../../../../components/tables/field-types';
import {
  FieldValuesEditor,
  fieldValueEntries,
  fieldValueRows,
  type FieldValueRow,
} from '../../../../components/tables/field-values-editor';
import type { TableField, TableUserOption } from '../../../../lib/api/tables';
import { useT } from '../../../../lib/i18n';
import { ArrowDown, ArrowUp, X } from '../../../../lib/icons';
import { stableJson } from '../spec-diff';
import { relativePath } from '../spec-errors';

export function PanelSection({
  title,
  hint,
  children,
  testId,
  defaultOpen,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  testId?: string;
  /** Optional settings can be disclosed without unmounting their unfinished input. */
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen ?? true);
  if (defaultOpen !== undefined) {
    return (
      <details
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
        className="border-t border-edge pt-3 first:border-t-0 first:pt-0"
        data-testid={testId}
      >
        <summary className="cursor-pointer rounded py-1 text-xs font-semibold text-fg-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500">
          {title}
        </summary>
        <div className="mt-2 space-y-3">
          {hint && <p className="text-xs leading-5 text-fg-muted">{hint}</p>}
          {children}
        </div>
      </details>
    );
  }
  return (
    <section className="space-y-2 border-t border-edge pt-4 first:border-t-0 first:pt-0" data-testid={testId}>
      <div>
        <h4 className="text-xs font-semibold text-fg-secondary">{title}</h4>
        {hint && <p className="mt-0.5 text-[11px] leading-4 text-fg-faint">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** The server's problems for one setting, in a danger tone, right where the setting is. */
export function SpecErrorList({ errors }: { errors: readonly AppSpecError[] }) {
  if (errors.length === 0) return null;
  return (
    <ul
      className="space-y-1 rounded-md border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger"
      role="alert"
    >
      {errors.map((error, index) => (
        <li key={`${error.path}-${index}`} className="break-words">
          {error.message}
          {relativePath(error) && (
            <span className="ml-1 font-mono text-[10px] opacity-75">({relativePath(error)})</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Local editing state for something the spec holds: re-read when the spec
 * changes from elsewhere (another card selected, a restore), never because of
 * our own write.
 */
export function useSyncedDraft<T, D>(value: T, toDraft: (value: T) => D) {
  const key = stableJson(value ?? null);
  const [draft, setDraft] = useState<D>(() => toDraft(value));
  const emitted = useRef(key);
  const toDraftRef = useRef(toDraft);
  toDraftRef.current = toDraft;
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    if (key === emitted.current) return;
    emitted.current = key;
    setDraft(toDraftRef.current(valueRef.current));
  }, [key]);
  return {
    draft,
    setDraft,
    /** Record that the spec now holds `next` because we wrote it. */
    wrote: (next: unknown) => {
      emitted.current = stableJson(next ?? null);
    },
  };
}

/**
 * A condition (`TableFilterGroup`) through the shared `FilterEditor`. Written
 * to the spec only when every clause has a value; until then the builder sees
 * which one is missing.
 */
export function ConditionEditor({
  value,
  onChange,
  fields,
  users,
  systemFields = TABLE_SYSTEM_FIELDS,
  testId,
}: {
  value: TableFilterGroup | undefined;
  onChange: (next: TableFilterGroup | undefined) => void;
  fields: TableField[];
  users: TableUserOption[];
  systemFields?: readonly TableSystemField[];
  testId?: string;
}) {
  const t = useT();
  const { draft, setDraft, wrote } = useSyncedDraft(value, (current) => current ?? null);
  const { incompleteIndex } = completedFilterGroup(draft, fields);
  return (
    <div className="space-y-2" data-testid={testId}>
      <FilterEditor
        value={draft}
        onChange={(next) => {
          setDraft(next);
          const done = completedFilterGroup(next, fields);
          if (done.incompleteIndex !== null) return;
          wrote(done.group);
          onChange(done.group);
        }}
        fields={fields}
        users={users}
        systemFields={systemFields}
      />
      {incompleteIndex !== null && (
        <p className="text-xs text-warning">
          {t('apps.builder.props.incompleteCondition', { index: incompleteIndex + 1 })}
        </p>
      )}
    </div>
  );
}

/** Field ids in display order: the chosen ones (reorder / remove) and a picker for the rest. */
export function FieldListPicker({
  label,
  fields,
  value,
  onChange,
  systemFields,
  onSystemFieldsChange,
  minimum = 0,
  testId,
}: {
  label: string;
  /** The fields that may be chosen. */
  fields: readonly TableField[];
  value: readonly number[];
  onChange: (next: number[]) => void;
  /** Record info columns (created by, …) when the card can show them. */
  systemFields?: readonly TableSystemField[];
  onSystemFieldsChange?: (next: TableSystemField[]) => void;
  /** Fields that must stay chosen (a form shows at least one). */
  minimum?: number;
  testId?: string;
}) {
  const t = useT();
  const byId = useMemo(() => new Map(fields.map((field) => [field.id, field])), [fields]);
  const chosen = value.filter((id) => byId.has(id));
  const rest = fields.filter((field) => !chosen.includes(field.id));
  const move = (index: number, by: -1 | 1) => {
    const next = [...chosen];
    const [id] = next.splice(index, 1);
    next.splice(index + by, 0, id!);
    onChange(next);
  };
  return (
    <div className="space-y-2" data-testid={testId}>
      <ul className="divide-y divide-edge rounded-md border border-edge" aria-label={label}>
        {chosen.length === 0 && (
          <li className="px-3 py-2 text-xs text-fg-faint">{t('apps.builder.props.noFieldsChosen')}</li>
        )}
        {chosen.map((id, index) => {
          const field = byId.get(id)!;
          return (
            <li key={id} className="flex items-center gap-1 py-0.5 pl-3 pr-1">
              <span className="min-w-0 flex-1 truncate text-sm text-fg" title={field.name}>
                {field.name}
              </span>
              <IconButton
                label={t('apps.builder.props.moveFieldUp', { name: field.name })}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={12} />
              </IconButton>
              <IconButton
                label={t('apps.builder.props.moveFieldDown', { name: field.name })}
                disabled={index === chosen.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={12} />
              </IconButton>
              <IconButton
                variant="destructive"
                label={t('apps.builder.props.removeField', { name: field.name })}
                disabled={chosen.length <= minimum}
                onClick={() => onChange(chosen.filter((entry) => entry !== id))}
              >
                <X size={12} />
              </IconButton>
            </li>
          );
        })}
      </ul>
      {rest.length > 0 && (
        <Select
          size="sm"
          value=""
          aria-label={t('apps.builder.props.addField', { list: label })}
          onChange={(event) => {
            const id = Number(event.target.value);
            if (id) onChange([...chosen, id]);
          }}
        >
          <option value="">{t('apps.builder.props.addFieldOption')}</option>
          {rest.map((field) => (
            <option key={field.id} value={field.id}>
              {field.name}
            </option>
          ))}
        </Select>
      )}
      {systemFields && onSystemFieldsChange && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {TABLE_SYSTEM_FIELDS.map((field) => (
            <Checkbox
              key={field}
              label={t(SYSTEM_FIELD_LABEL_KEYS[field])}
              checked={systemFields.includes(field)}
              onChange={(event) =>
                onSystemFieldsChange(
                  event.target.checked ? [...systemFields, field] : systemFields.filter((entry) => entry !== field),
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Who may use something (an action, a button, a form, adding records, dragging
 * lanes): every role that sees the page (no list), or only the roles ticked.
 * An empty list means nobody — stated, never silently widened.
 */
export function RolesPicker({
  label,
  roles,
  value,
  onChange,
}: {
  label: string;
  roles: readonly AppRole[];
  value: readonly string[] | undefined;
  onChange: (next: string[] | undefined) => void;
}) {
  const t = useT();
  const mode = value === undefined ? 'page' : 'some';
  return (
    <div className="space-y-2" role="group" aria-label={label}>
      <FilterPills
        variant="segment"
        wrap
        items={[
          { key: 'page', label: t('apps.builder.rolesPicker.page') },
          { key: 'some', label: t('apps.builder.rolesPicker.some') },
        ]}
        activeKey={mode}
        onChange={(next) => {
          if (!next || next === mode) return;
          onChange(next === 'page' ? undefined : roles.map((role) => role.key));
        }}
      />
      {value !== undefined && (
        <div className="space-y-1 rounded-md border border-edge px-3 py-2">
          {roles.map((role) => (
            <Checkbox
              key={role.key}
              label={role.name}
              checked={value.includes(role.key)}
              onChange={(event) =>
                onChange(event.target.checked ? [...value, role.key] : value.filter((key) => key !== role.key))
              }
            />
          ))}
          {value.length === 0 && <p className="text-xs text-warning">{t('apps.builder.rolesPicker.nobody')}</p>}
        </div>
      )}
    </div>
  );
}

export interface ValuesCopyKind {
  /** Who the tokens mean: the person submitting a form / adding a record, or the person running an action. */
  kind: 'submit' | 'action';
}

/**
 * `TableFieldValueEntry[]` through the shared `FieldValuesEditor`. Rows stay
 * drafts while typed; an empty fixed value is written as `null` (the field is
 * left empty / cleared) and said so.
 */
export function SpecValuesEditor({
  entries,
  onChange,
  fields,
  users,
  kind,
  testId,
}: {
  entries: readonly TableFieldValueEntry[] | undefined;
  onChange: (next: TableFieldValueEntry[]) => void;
  /** The fields a row may target. */
  fields: readonly TableField[];
  users: TableUserOption[];
  testId?: string;
} & ValuesCopyKind) {
  const t = useT();
  const byId = useMemo(() => new Map(fields.map((field) => [field.id, field])), [fields]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const {
    draft: rows,
    setDraft: setRows,
    wrote,
  } = useSyncedDraft(entries ?? [], (current) => fieldValueRows(current, byIdRef.current));
  const change = (next: FieldValueRow[]) => {
    setRows(next);
    const written = fieldValueEntries(next, byId, { requireValue: false }) ?? [];
    wrote(written);
    onChange(written);
  };
  const someEmpty = (fieldValueEntries(rows, byId, { requireValue: false }) ?? []).some(
    (entry) => entry.value === null,
  );
  const tokens =
    kind === 'action'
      ? {
          $me: t('apps.builder.values.action.me'),
          $today: t('apps.builder.values.action.today'),
          $now: t('apps.builder.values.action.now'),
        }
      : {
          $me: t('apps.builder.values.submit.me'),
          $today: t('apps.builder.values.submit.today'),
          $now: t('apps.builder.values.submit.now'),
        };
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <FieldValuesEditor
        rows={rows}
        onChange={change}
        fields={[...fields]}
        users={users}
        copy={{
          field: t('apps.builder.values.field'),
          value: t('apps.builder.values.value'),
          fixed: t('apps.builder.values.fixed'),
          tokens,
          add: t('apps.builder.values.add'),
          remove: t('apps.builder.values.remove'),
          none: t('apps.builder.values.none'),
          noFields: t('apps.builder.values.noFields'),
        }}
        emptyLabel={t('apps.builder.values.empty')}
        stacked
      />
      {someEmpty && <p className="text-[11px] text-fg-faint">{t('apps.builder.values.emptyClears')}</p>}
    </div>
  );
}

/**
 * A text setting. What is typed stays on screen; the spec gets it trimmed (the
 * server trims too, so its copy never fights the cursor). `required`: an
 * empty value is not written (the spec keeps the last one) and the field says
 * so; otherwise empty writes `undefined`.
 */
export function TextSetting({
  label,
  value,
  onChange,
  required = false,
  maxLength,
  placeholder,
  help,
  multiline = false,
  rows = 4,
  testId,
}: {
  label: string;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
  help?: string;
  multiline?: boolean;
  rows?: number;
  testId?: string;
}) {
  const t = useT();
  const [text, setText] = useState(value ?? '');
  const emitted = useRef(value ?? '');
  useEffect(() => {
    if ((value ?? '') === emitted.current) return;
    emitted.current = value ?? '';
    setText(value ?? '');
  }, [value]);
  const missing = required && !text.trim();
  const change = (raw: string) => {
    setText(raw);
    const next = raw.trim();
    if (required && !next) return;
    emitted.current = next;
    onChange(next || undefined);
  };
  return (
    <FormField
      label={label}
      required={required}
      help={help}
      error={missing ? t('apps.builder.props.required') : undefined}
    >
      {multiline ? (
        <Textarea
          rows={rows}
          value={text}
          maxLength={maxLength}
          placeholder={placeholder}
          data-testid={testId}
          onChange={(event) => change(event.target.value)}
        />
      ) : (
        <Input
          value={text}
          maxLength={maxLength}
          placeholder={placeholder}
          data-testid={testId}
          onChange={(event) => change(event.target.value)}
        />
      )}
    </FormField>
  );
}
