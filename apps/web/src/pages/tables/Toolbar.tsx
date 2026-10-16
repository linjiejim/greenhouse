/**
 * A view's toolbar (patterns.md, 数据视图): search, filter, sort, group, fields and the view's
 * own settings, each a panel under its button. A button shows when what it controls is on.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownUp,
  ArrowDown,
  ArrowUp,
  Filter as FilterIcon,
  Layers,
  Plus,
  Settings2,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import {
  Button,
  Checkbox,
  DatePicker,
  FieldGroup,
  IconButton,
  Input,
  Popover,
  SearchInput,
  Segmented,
  Select,
  type SelectOption,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import {
  FILTER_TOKENS,
  SYSTEM_FIELDS,
  canGroupBy,
  canSortBy,
  isSystemField,
  operatorsFor,
  valueTypeOf,
  type Field,
  type FieldType,
  type Filter,
  type FilterClause,
  type FilterOperator,
  type SystemField,
  type View,
  type ViewConfig,
} from '@greenhouse/contract';
import { usePeople } from '../../data/people';
import { useTitles } from '../../data/tables';
import { useI18n } from '../../lib/i18n';
import { FieldIcon, memberOptions } from './cells';
import { linkTable, moveField, orderedFields } from './model';

type Kind = FieldType | SystemField;
const kindOf = (fields: readonly Field[], ref: string): Kind | undefined => {
  if (isSystemField(ref)) return ref;
  const field = fields.find((entry) => entry.id === ref);
  return field ? valueTypeOf(field) : undefined;
};

/** Fields and the system fields as picker options. */
function useFieldOptions(fields: readonly Field[], keep: (kind: Kind) => boolean): SelectOption[] {
  const { t } = useI18n();
  return [
    ...fields
      .filter((field) => keep(valueTypeOf(field)))
      .map((field) => ({ value: field.id, label: field.name, icon: <FieldIcon type={field.type} /> })),
    ...SYSTEM_FIELDS.filter(keep).map((field) => ({ value: field, label: t(`tables.system.${field}`) })),
  ];
}

const DATE_KINDS: readonly Kind[] = ['date', 'datetime', 'created_at', 'updated_at'];
const needsValue = (op: FilterOperator) => op !== 'is_empty' && op !== 'is_not_empty';

function opLabel(t: ReturnType<typeof useI18n>['t'], kind: Kind | undefined, op: FilterOperator) {
  if (kind && DATE_KINDS.includes(kind) && ['gt', 'gte', 'lt', 'lte'].includes(op)) {
    return t(`tables.op.date.${op as 'gt' | 'gte' | 'lt' | 'lte'}`);
  }
  return t(`tables.op.${op}`);
}

function LinkValue({
  field,
  value,
  onChange,
  label,
}: {
  field: Field;
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const titles = useTitles(linkTable(field));
  return (
    <Select
      label={label}
      size="sm"
      value={value}
      searchable
      options={(titles.data?.items ?? []).map((item) => ({ value: item.id, label: item.title || '—' }))}
      onChange={onChange}
    />
  );
}

/** The value part of a clause, by what the field holds; text commits a moment after typing stops. */
function ClauseValue({
  fields,
  clause,
  onChange,
}: {
  fields: readonly Field[];
  clause: FilterClause;
  onChange: (value: FilterClause['value']) => void;
}) {
  const { t } = useI18n();
  const { members } = usePeople();
  const kind = kindOf(fields, clause.field);
  const field = fields.find((entry) => entry.id === clause.field);
  const label = t('tables.filter.value');
  const [text, setText] = useState(
    typeof clause.value === 'string' || typeof clause.value === 'number' ? String(clause.value) : '',
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  if (!needsValue(clause.op) || !kind) return null;
  const typed = (next: string) => {
    setText(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => onChange(kind === 'number' ? (next.trim() ? Number(next) : undefined) : next),
      400,
    );
  };
  if (DATE_KINDS.includes(kind)) {
    const token = typeof clause.value === 'string' && clause.value.startsWith('$') ? clause.value : 'date';
    return (
      <span className="app-tb-clause-date">
        <Select
          label={label}
          size="sm"
          value={token}
          options={[
            ...FILTER_TOKENS.filter((entry) => entry !== '$me').map((entry) => ({
              value: entry,
              label: t(`tables.token.${entry}`),
            })),
            { value: 'date', label: t('tables.token.date') },
          ]}
          onChange={(next) => onChange(next === 'date' ? '' : next)}
        />
        {token === 'date' && (
          <DatePicker
            label={label}
            value={typeof clause.value === 'string' ? clause.value : ''}
            onChange={(day) => onChange(day)}
          />
        )}
      </span>
    );
  }
  switch (kind) {
    case 'checkbox':
      return (
        <Select
          label={label}
          size="sm"
          value={clause.value === false ? 'false' : 'true'}
          options={[
            { value: 'true', label: t('tables.checked') },
            { value: 'false', label: t('tables.unchecked') },
          ]}
          onChange={(next) => onChange(next === 'true')}
        />
      );
    case 'single_select':
    case 'multi_select':
      return (
        <Select
          label={label}
          size="sm"
          value={typeof clause.value === 'string' ? clause.value : ''}
          options={(field?.config.options ?? []).map((option) => ({ value: option.id, label: option.label }))}
          onChange={onChange}
        />
      );
    case 'member':
    case 'created_by':
    case 'updated_by':
      return (
        <Select
          label={label}
          size="sm"
          value={typeof clause.value === 'string' ? clause.value : ''}
          options={[{ value: '$me', label: t('tables.token.$me') }, ...memberOptions(members)]}
          onChange={onChange}
        />
      );
    case 'relation':
    case 'parent':
    case 'dependency':
      return field ? (
        <LinkValue
          field={field}
          label={label}
          value={typeof clause.value === 'string' ? clause.value : ''}
          onChange={onChange}
        />
      ) : null;
    default:
      return (
        <Input
          aria-label={label}
          className="app-tb-clause-input"
          inputMode={kind === 'number' ? 'decimal' : undefined}
          value={text}
          onChange={(event) => typed(event.target.value)}
        />
      );
  }
}

function FilterPanel({
  fields,
  config,
  onConfig,
}: {
  fields: readonly Field[];
  config: ViewConfig;
  onConfig: (next: ViewConfig) => void;
}) {
  const { t } = useI18n();
  const filter: Filter = config.filter ?? { mode: 'and', clauses: [] };
  const options = useFieldOptions(fields, (kind) => operatorsFor(kind).length > 0);
  const save = (next: Filter) => onConfig({ ...config, filter: next.clauses.length ? next : undefined });
  const set = (index: number, change: Partial<FilterClause>) =>
    save({
      ...filter,
      clauses: filter.clauses.map((clause, at) => (at === index ? { ...clause, ...change } : clause)),
    });
  return (
    <div className="app-tb-panel">
      {filter.clauses.length > 1 && (
        <FieldGroup label={t('tables.filter.mode')}>
          <Segmented
            label={t('tables.filter.mode')}
            items={[
              { value: 'and', label: t('tables.filter.and') },
              { value: 'or', label: t('tables.filter.or') },
            ]}
            value={filter.mode}
            onChange={(mode) => save({ ...filter, mode: mode as Filter['mode'] })}
          />
        </FieldGroup>
      )}
      {!filter.clauses.length && <p className="app-muted app-tb-panel-note">{t('tables.filter.none')}</p>}
      {filter.clauses.map((clause, index) => {
        const kind = kindOf(fields, clause.field);
        const ops = kind ? operatorsFor(kind) : [];
        return (
          <div key={index} className="app-tb-clause">
            <Select
              label={t('tables.filter.field')}
              size="sm"
              value={clause.field}
              options={options}
              onChange={(next) => {
                const nextKind = kindOf(fields, next)!;
                set(index, { field: next, op: operatorsFor(nextKind)[0]!, value: undefined });
              }}
            />
            <Select
              label={t('tables.filter.op')}
              size="sm"
              value={clause.op}
              options={ops.map((op) => ({ value: op, label: opLabel(t, kind, op) }))}
              onChange={(op) =>
                set(index, {
                  op: op as FilterOperator,
                  ...(needsValue(op as FilterOperator) ? {} : { value: undefined }),
                })
              }
            />
            <ClauseValue
              key={`${clause.field}:${clause.op}`}
              fields={fields}
              clause={clause}
              onChange={(value) => set(index, { value })}
            />
            <IconButton
              size="sm"
              label={t('tables.filter.remove')}
              onClick={() => save({ ...filter, clauses: filter.clauses.filter((_, at) => at !== index) })}
            >
              <Trash2 size={icon.sm} strokeWidth={icon.stroke} />
            </IconButton>
          </div>
        );
      })}
      <div className="app-tb-panel-actions">
        <Button
          size="sm"
          kind="ghost"
          onClick={() => {
            const first = fields[0];
            if (!first) return;
            save({
              ...filter,
              clauses: [...filter.clauses, { field: first.id, op: operatorsFor(valueTypeOf(first))[0]! }],
            });
          }}
        >
          <Plus size={icon.sm} strokeWidth={icon.stroke} />
          {t('tables.filter.add')}
        </Button>
        {filter.clauses.length > 0 && (
          <Button size="sm" kind="ghost" onClick={() => save({ mode: 'and', clauses: [] })}>
            {t('tables.filter.clear')}
          </Button>
        )}
      </div>
    </div>
  );
}

function SortPanel({
  fields,
  config,
  onConfig,
}: {
  fields: readonly Field[];
  config: ViewConfig;
  onConfig: (next: ViewConfig) => void;
}) {
  const { t } = useI18n();
  const sorts = config.sorts ?? [];
  const options = useFieldOptions(fields, canSortBy);
  const save = (next: NonNullable<ViewConfig['sorts']>) =>
    onConfig({ ...config, sorts: next.length ? next : undefined });
  return (
    <div className="app-tb-panel">
      {!sorts.length && <p className="app-muted app-tb-panel-note">{t('tables.sort.none')}</p>}
      {sorts.map((sort, index) => (
        <div key={index} className="app-tb-clause">
          <Select
            label={t('tables.filter.field')}
            size="sm"
            value={sort.field}
            options={options}
            onChange={(field) => save(sorts.map((entry, at) => (at === index ? { ...entry, field } : entry)))}
          />
          <Segmented
            label={t('tables.sort')}
            items={[
              { value: 'asc', label: t('tables.sort.asc') },
              { value: 'desc', label: t('tables.sort.desc') },
            ]}
            value={sort.desc ? 'desc' : 'asc'}
            onChange={(next) =>
              save(
                sorts.map((entry, at) =>
                  at === index ? { field: entry.field, ...(next === 'desc' ? { desc: true } : {}) } : entry,
                ),
              )
            }
          />
          <IconButton
            size="sm"
            label={t('tables.sort.remove')}
            onClick={() => save(sorts.filter((_, at) => at !== index))}
          >
            <Trash2 size={icon.sm} strokeWidth={icon.stroke} />
          </IconButton>
        </div>
      ))}
      {sorts.length < 3 && (
        <div className="app-tb-panel-actions">
          <Button
            size="sm"
            kind="ghost"
            onClick={() => {
              const used = new Set(sorts.map((sort) => sort.field));
              const next = options.find((option) => typeof option !== 'string' && !used.has(option.value));
              if (next && typeof next !== 'string') save([...sorts, { field: next.value }]);
            }}
          >
            <Plus size={icon.sm} strokeWidth={icon.stroke} />
            {t('tables.sort.add')}
          </Button>
        </div>
      )}
    </div>
  );
}

function GroupPanel({
  fields,
  config,
  onConfig,
}: {
  fields: readonly Field[];
  config: ViewConfig;
  onConfig: (next: ViewConfig) => void;
}) {
  const { t } = useI18n();
  const options = useFieldOptions(fields, canGroupBy).filter((option) => {
    const field = typeof option === 'string' ? undefined : fields.find((entry) => entry.id === option.value);
    return !field || field.type !== 'member' || !field.config.multiple;
  });
  return (
    <div className="app-tb-panel">
      <div className="app-tb-clause">
        <Select
          label={t('tables.group.field')}
          size="sm"
          value={config.group?.field ?? ''}
          options={[{ value: '', label: t('tables.group.none') }, ...options]}
          onChange={(field) =>
            onConfig({ ...config, group: field ? { field, ...(config.group?.desc ? { desc: true } : {}) } : null })
          }
        />
        {config.group && (
          <Segmented
            label={t('tables.group.order')}
            items={[
              { value: 'asc', label: t('tables.sort.asc') },
              { value: 'desc', label: t('tables.sort.desc') },
            ]}
            value={config.group.desc ? 'desc' : 'asc'}
            onChange={(next) =>
              onConfig({ ...config, group: { field: config.group!.field, ...(next === 'desc' ? { desc: true } : {}) } })
            }
          />
        )}
      </div>
    </div>
  );
}

function FieldsPanel({
  fields,
  config,
  onConfig,
  canBuild,
  onAddField,
}: {
  fields: readonly Field[];
  config: ViewConfig;
  onConfig: (next: ViewConfig) => void;
  canBuild: boolean;
  onAddField: () => void;
}) {
  const { t } = useI18n();
  const hidden = new Set(config.hidden ?? []);
  const all = orderedFields(fields, config, true);
  const others = all.filter((field) => !field.is_primary);
  const setHidden = (next: Set<string>) => onConfig({ ...config, hidden: next.size ? [...next] : undefined });
  return (
    <div className="app-tb-panel">
      <ul className="app-tb-field-list">
        {all.map((field) => {
          const at = others.indexOf(field);
          return (
            <li key={field.id}>
              <Checkbox
                label={
                  <span className="app-tb-field-name">
                    <FieldIcon type={field.type} />
                    {field.name}
                  </span>
                }
                aria-label={t('tables.fields.toggle', { name: field.name })}
                checked={field.is_primary || !hidden.has(field.id)}
                disabled={field.is_primary}
                onChange={(checked) => {
                  const next = new Set(hidden);
                  if (checked) next.delete(field.id);
                  else next.add(field.id);
                  setHidden(next);
                }}
              />
              {!field.is_primary && (
                <span className="app-tb-field-move">
                  <IconButton
                    size="sm"
                    label={t('tables.fields.up', { name: field.name })}
                    disabled={at <= 0}
                    onClick={() => onConfig({ ...config, order: moveField(fields, config, field.id, -1) })}
                  >
                    <ArrowUp size={icon.sm} strokeWidth={icon.stroke} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={t('tables.fields.down', { name: field.name })}
                    disabled={at >= others.length - 1}
                    onClick={() => onConfig({ ...config, order: moveField(fields, config, field.id, 1) })}
                  >
                    <ArrowDown size={icon.sm} strokeWidth={icon.stroke} />
                  </IconButton>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="app-tb-panel-actions">
        <Button size="sm" kind="ghost" onClick={() => setHidden(new Set())}>
          {t('tables.fields.showAll')}
        </Button>
        <Button size="sm" kind="ghost" onClick={() => setHidden(new Set(others.map((field) => field.id)))}>
          {t('tables.fields.hideAll')}
        </Button>
        {canBuild && (
          <Button size="sm" kind="ghost" onClick={onAddField}>
            <Plus size={icon.sm} strokeWidth={icon.stroke} />
            {t('tables.fields.add')}
          </Button>
        )}
      </div>
    </div>
  );
}

function SettingsPanel({
  view,
  fields,
  config,
  onConfig,
}: {
  view: View;
  fields: readonly Field[];
  config: ViewConfig;
  onConfig: (next: ViewConfig) => void;
}) {
  const { t } = useI18n();
  const of = (...types: FieldType[]) =>
    fields
      .filter((field) => types.includes(field.type))
      .map((field) => ({ value: field.id, label: field.name, icon: <FieldIcon type={field.type} /> }));
  const none = { value: '', label: t('tables.settings.none') };
  const dates = of('date', 'datetime');
  const timeline = config.timeline;
  const milestoneField = fields.find((field) => field.id === timeline?.milestone?.field);
  return (
    <div className="app-tb-panel">
      {view.type === 'grid' && (
        <>
          <FieldGroup label={t('tables.settings.rowHeight')}>
            <Segmented
              label={t('tables.settings.rowHeight')}
              items={[
                { value: 'short', label: t('tables.settings.short') },
                { value: 'medium', label: t('tables.settings.medium') },
                { value: 'tall', label: t('tables.settings.tall') },
              ]}
              value={config.row_height ?? 'medium'}
              onChange={(next) => onConfig({ ...config, row_height: next as ViewConfig['row_height'] })}
            />
          </FieldGroup>
          <Select
            label={t('tables.settings.frozen')}
            value={String(config.frozen ?? 0)}
            options={[0, 1, 2, 3].map((n) => ({
              value: String(n),
              label: n ? t('tables.settings.frozenN', { n }) : t('tables.settings.frozenNone'),
            }))}
            onChange={(next) => onConfig({ ...config, frozen: Number(next) || undefined })}
          />
        </>
      )}
      {view.type === 'kanban' && (
        <>
          <Select
            label={t('tables.settings.kanban')}
            value={config.kanban?.field ?? ''}
            options={[
              ...of('single_select'),
              ...fields
                .filter((field) => field.type === 'member' && !field.config.multiple)
                .map((field) => ({ value: field.id, label: field.name, icon: <FieldIcon type={field.type} /> })),
            ]}
            onChange={(field) =>
              onConfig({ ...config, kanban: { field, ...(config.kanban?.hide_empty ? { hide_empty: true } : {}) } })
            }
          />
          {config.kanban && (
            <Checkbox
              label={t('tables.settings.hideEmpty')}
              checked={!!config.kanban.hide_empty}
              onChange={(checked) =>
                onConfig({
                  ...config,
                  kanban: { field: config.kanban!.field, ...(checked ? { hide_empty: true } : {}) },
                })
              }
            />
          )}
        </>
      )}
      {view.type === 'calendar' && (
        <>
          <Select
            label={t('tables.settings.start')}
            value={config.calendar?.start ?? ''}
            options={dates}
            onChange={(start) => onConfig({ ...config, calendar: { ...config.calendar, start } })}
          />
          <Select
            label={t('tables.settings.end')}
            value={config.calendar?.end ?? ''}
            options={[none, ...dates]}
            onChange={(end) =>
              config.calendar &&
              onConfig({ ...config, calendar: { start: config.calendar.start, ...(end ? { end } : {}) } })
            }
          />
        </>
      )}
      {view.type === 'gallery' && (
        <Select
          label={t('tables.settings.cover')}
          value={config.gallery?.cover ?? ''}
          options={[none, ...of('attachment')]}
          onChange={(cover) => onConfig({ ...config, gallery: cover ? { cover } : {} })}
        />
      )}
      {view.type === 'timeline' && (
        <>
          <Select
            label={t('tables.settings.start')}
            value={timeline?.start ?? ''}
            options={dates}
            onChange={(start) => onConfig({ ...config, timeline: { ...timeline, start } })}
          />
          <Select
            label={t('tables.settings.end')}
            value={timeline?.end ?? ''}
            options={[none, ...dates]}
            onChange={(end) => timeline && onConfig({ ...config, timeline: { ...timeline, end: end || undefined } })}
          />
          <Select
            label={t('tables.settings.dependency')}
            value={timeline?.dependency ?? ''}
            options={[none, ...of('dependency')]}
            onChange={(dependency) =>
              timeline && onConfig({ ...config, timeline: { ...timeline, dependency: dependency || undefined } })
            }
          />
          <Select
            label={t('tables.settings.milestone')}
            value={timeline?.milestone?.field ?? ''}
            options={[none, ...of('single_select', 'checkbox')]}
            onChange={(field) => {
              if (!timeline) return;
              const chosen = fields.find((entry) => entry.id === field);
              onConfig({
                ...config,
                timeline: {
                  ...timeline,
                  milestone: chosen
                    ? {
                        field: chosen.id,
                        ...(chosen.type === 'single_select' ? { option: chosen.config.options?.[0]?.id } : {}),
                      }
                    : undefined,
                },
              });
            }}
          />
          {milestoneField?.type === 'single_select' && timeline?.milestone && (
            <Select
              label={t('tables.settings.milestone')}
              value={timeline.milestone.option ?? ''}
              options={(milestoneField.config.options ?? []).map((option) => ({
                value: option.id,
                label: option.label,
              }))}
              onChange={(option) =>
                onConfig({ ...config, timeline: { ...timeline, milestone: { field: milestoneField.id, option } } })
              }
            />
          )}
        </>
      )}
    </div>
  );
}

/** A toolbar button's words; on a phone only the icon shows and the words stay for screen readers. */
const Label = ({ narrow, text }: { narrow: boolean; text: string }) =>
  narrow ? <span className="app-sr-only">{text}</span> : <>{text}</>;

export function Toolbar({
  fields,
  view,
  config,
  search,
  onSearch,
  onConfig,
  canBuild,
  narrow,
  onAddField,
}: {
  fields: Field[];
  view: View;
  config: ViewConfig;
  search: string;
  onSearch: (text: string) => void;
  onConfig: (next: ViewConfig) => void;
  canBuild: boolean;
  narrow: boolean;
  onAddField: () => void;
}) {
  const { t } = useI18n();
  const filters = config.filter?.clauses.length ?? 0;
  const sorts = config.sorts?.length ?? 0;
  const groupField = config.group
    ? isSystemField(config.group.field)
      ? t(`tables.system.${config.group.field}`)
      : fields.find((field) => field.id === config.group?.field)?.name
    : undefined;
  const hidden = (config.hidden ?? []).filter((id) => fields.some((field) => field.id === id)).length;
  const groups = view.type === 'grid' || view.type === 'gallery';
  return (
    <div className="app-tb-toolbar">
      <SearchInput label={t('tables.search')} placeholder={t('tables.search')} value={search} onChange={onSearch} />
      <Popover
        label={t('tables.filter')}
        wide
        kind={filters ? 'secondary' : 'ghost'}
        trigger={
          <>
            <FilterIcon size={icon.sm} strokeWidth={icon.stroke} />
            <Label narrow={narrow} text={filters ? t('tables.filterCount', { count: filters }) : t('tables.filter')} />
          </>
        }
      >
        <FilterPanel fields={fields} config={config} onConfig={onConfig} />
      </Popover>
      <Popover
        label={t('tables.sort')}
        wide
        kind={sorts ? 'secondary' : 'ghost'}
        trigger={
          <>
            <ArrowDownUp size={icon.sm} strokeWidth={icon.stroke} />
            <Label narrow={narrow} text={sorts ? t('tables.sortCount', { count: sorts }) : t('tables.sort')} />
          </>
        }
      >
        <SortPanel fields={fields} config={config} onConfig={onConfig} />
      </Popover>
      {groups && (
        <Popover
          label={t('tables.group')}
          wide
          kind={config.group ? 'secondary' : 'ghost'}
          trigger={
            <>
              <Layers size={icon.sm} strokeWidth={icon.stroke} />
              <Label
                narrow={narrow}
                text={groupField ? t('tables.groupedBy', { name: groupField }) : t('tables.group')}
              />
            </>
          }
        >
          <GroupPanel fields={fields} config={config} onConfig={onConfig} />
        </Popover>
      )}
      <Popover
        label={t('tables.fields')}
        kind={hidden ? 'secondary' : 'ghost'}
        trigger={
          <>
            <SlidersHorizontal size={icon.sm} strokeWidth={icon.stroke} />
            <Label narrow={narrow} text={hidden ? t('tables.hiddenCount', { count: hidden }) : t('tables.fields')} />
          </>
        }
      >
        <FieldsPanel fields={fields} config={config} onConfig={onConfig} canBuild={canBuild} onAddField={onAddField} />
      </Popover>
      <Popover
        label={t('tables.settings')}
        align="end"
        trigger={
          <>
            <Settings2 size={icon.sm} strokeWidth={icon.stroke} />
            <Label narrow text={t('tables.settings')} />
          </>
        }
      >
        <SettingsPanel view={view} fields={fields} config={config} onConfig={onConfig} />
      </Popover>
    </div>
  );
}
