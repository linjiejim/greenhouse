/**
 * The rule editor of one custom role (`TableAccessRules`): per table no access /
 * read / edit; the rows it reads and the rows it may change (all, related to
 * the person, or matching conditions in the shared `FilterEditor`); create /
 * delete; and per field hidden / read / edit, with a "show all fields" switch
 * that sets `fieldDefault`.
 *
 * Effective access comes from the same `computeFieldAccess` the server compiles
 * with, over the server's own schema facts — so "hidden because it depends on a
 * hidden field" here is exactly what the role will get.
 */

import { useMemo } from 'react';
import {
  computeFieldAccess,
  fieldAccessFor,
  ruleForTable,
  type TableAccessRule,
  type TableAccessRules,
  type TableAccessSchemaFacts,
  type TableFieldAccess,
  type TableRowScope,
} from '@greenhouse/types/table-access';
import type { TableFilterGroup } from '@greenhouse/types/tables';
import { Badge, Card, Checkbox, FilterPills, Select, Toggle } from '../../components/ui';
import { FilterEditor } from '../../components/tables/filter-editor';
import { completedFilterGroup } from '../../components/tables/filter-model';
import { FIELD_TYPE_LABEL_KEYS, isComputedField } from '../../components/tables/field-types';
import { EyeOff, Info, Table2 } from '../../lib/icons';
import type { TableField, TableUserOption } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';

export interface RoleEditorProps {
  rules: TableAccessRules;
  onChange: (next: TableAccessRules) => void;
  /** Tables, fields and dependency edges from `listTableBaseRoles` (the server's facts). */
  facts: TableAccessSchemaFacts;
  /** Full field rows per table — the condition editor needs select options and types. */
  fieldsByTable: ReadonlyMap<number, TableField[]>;
  users: TableUserOption[];
  disabled?: boolean;
  /**
   * The "dashboards" switch (`rules.dashboards`). Off for an app role (the
   * app builder reuses this editor): an app's pages are its dashboards.
   */
  showDashboards?: boolean;
}

type ScopeKind = 'all' | 'related' | 'where';

function scopeKind(scope: TableRowScope | undefined): ScopeKind {
  return scope?.type === 'related' || scope?.type === 'where' ? scope.type : 'all';
}

function defaultScope(kind: ScopeKind): TableRowScope {
  if (kind === 'related') return { type: 'related', creator: true, fieldIds: [] };
  if (kind === 'where') return { type: 'where', where: { combinator: 'and', clauses: [] } };
  return { type: 'all' };
}

/** A new rule starts closed: nothing of the table is visible until the owner opens fields (spec §1). */
function newRule(tableId: number, access: 'read' | 'edit'): TableAccessRule {
  return { tableId, access, fields: [], fieldDefault: 'hidden' };
}

/** An unfinished row scope: condition `index` (1-based) of a "matching conditions" scope, or a "related" one naming nobody. */
export type IncompleteRowScope = { tableId: number; index: number } | { tableId: number; related: true };

/**
 * The first row scope that is not finished — the dialog blocks Save on it (an
 * empty or half-typed predicate would be stored and then match nothing, which
 * reads like a bug; a "related" scope with neither the creator nor a person
 * field is refused by the server).
 */
export function incompleteRowScope(
  rules: TableAccessRules,
  fieldsByTable: ReadonlyMap<number, TableField[]>,
): IncompleteRowScope | null {
  for (const rule of rules.tables) {
    for (const scope of [rule.rows, rule.editRows]) {
      if (scope?.type === 'related' && !scope.creator && scope.fieldIds.length === 0) {
        return { tableId: rule.tableId, related: true };
      }
      if (scope?.type !== 'where') continue;
      if (scope.where.clauses.length === 0) return { tableId: rule.tableId, index: 1 };
      const { incompleteIndex } = completedFilterGroup(scope.where, fieldsByTable.get(rule.tableId) ?? []);
      if (incompleteIndex !== null) return { tableId: rule.tableId, index: incompleteIndex + 1 };
    }
  }
  return null;
}

function RowScopeEditor({
  label,
  value,
  onChange,
  fields,
  users,
  allowSame,
  disabled,
}: {
  label: string;
  /** Undefined = all rows (or, with `allowSame`, the same as the read rows). */
  value: TableRowScope | undefined;
  onChange: (next: TableRowScope | undefined) => void;
  fields: TableField[];
  users: TableUserOption[];
  allowSame?: boolean;
  disabled?: boolean;
}) {
  const t = useT();
  const kind = value === undefined && allowSame ? 'same' : scopeKind(value);
  const personFields = fields.filter((field) => field.type === 'user' || field.type === 'multi_user');
  const items = [
    ...(allowSame ? [{ key: 'same', label: t('tables.access.rows.same') }] : []),
    { key: 'all', label: t('tables.access.rows.all') },
    { key: 'related', label: t('tables.access.rows.related') },
    { key: 'where', label: t('tables.access.rows.where') },
  ];
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <FilterPills
        variant="segment"
        wrap
        items={items}
        activeKey={kind}
        onChange={(next) => {
          if (disabled || !next || next === kind) return;
          if (next === 'same') onChange(undefined);
          else onChange(next === 'all' && !allowSame ? undefined : defaultScope(next as ScopeKind));
        }}
      />
      {value?.type === 'related' && (
        <div className="space-y-1.5 rounded-md border border-edge bg-surface-sunken px-3 py-2">
          <Checkbox
            label={t('tables.access.relatedCreator')}
            checked={value.creator}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, creator: event.target.checked })}
          />
          {personFields.map((field) => (
            <Checkbox
              key={field.id}
              label={t('tables.access.relatedField', { name: field.name })}
              checked={value.fieldIds.includes(field.id)}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...value,
                  fieldIds: event.target.checked
                    ? [...value.fieldIds, field.id]
                    : value.fieldIds.filter((id) => id !== field.id),
                })
              }
            />
          ))}
          {personFields.length === 0 && <p className="text-xs text-fg-faint">{t('tables.access.noPersonFields')}</p>}
        </div>
      )}
      {value?.type === 'where' && (
        <FilterEditor
          value={value.where}
          onChange={(where: TableFilterGroup) => onChange({ type: 'where', where })}
          fields={fields}
          users={users}
        />
      )}
    </div>
  );
}

export function RoleEditor({
  rules,
  onChange,
  facts,
  fieldsByTable,
  users,
  disabled = false,
  showDashboards = true,
}: RoleEditorProps) {
  const t = useT();
  const effective = useMemo(() => computeFieldAccess(rules, facts), [facts, rules]);

  const setRule = (tableId: number, next: TableAccessRule | null) => {
    const others = rules.tables.filter((rule) => rule.tableId !== tableId);
    onChange({ ...rules, tables: next ? [...others, next] : others });
  };

  return (
    <div className="space-y-4" data-testid="role-editor">
      {showDashboards && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-edge px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">{t('tables.access.dashboards')}</p>
            <p className="text-xs text-fg-muted">{t('tables.access.dashboardsHint')}</p>
          </div>
          <Toggle
            checked={rules.dashboards === 'all'}
            disabled={disabled}
            label={t('tables.access.dashboards')}
            onChange={(checked) => onChange({ ...rules, dashboards: checked ? 'all' : 'none' })}
          />
        </div>
      )}

      {facts.tables.map((table) => {
        const rule = ruleForTable(rules, table.id);
        const fields = fieldsByTable.get(table.id) ?? [];
        const access = rule?.access ?? 'none';
        return (
          <Card key={table.id} className="space-y-4 p-4" data-testid={`role-table-${table.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg">
                <Table2 size={14} className="flex-shrink-0 text-fg-muted" />
                <span className="truncate">{table.name}</span>
              </h4>
              <FilterPills
                variant="segment"
                items={(['none', 'read', 'edit'] as const).map((key) => ({
                  key,
                  label: t(`tables.access.tableAccess.${key}`),
                }))}
                activeKey={access}
                onChange={(next) => {
                  if (disabled || !next || next === access) return;
                  if (next === 'none') return setRule(table.id, null);
                  const nextAccess = next as 'read' | 'edit';
                  setRule(table.id, rule ? { ...rule, access: nextAccess } : newRule(table.id, nextAccess));
                }}
              />
            </div>

            {!rule ? (
              <p className="flex items-center gap-1.5 text-xs text-fg-faint">
                <EyeOff size={12} />
                {t('tables.access.tableHidden')}
              </p>
            ) : (
              <>
                <div className="grid gap-4 lg:grid-cols-2">
                  <RowScopeEditor
                    label={t('tables.access.rowsRead')}
                    value={rule.rows}
                    onChange={(rows) => setRule(table.id, { ...rule, rows })}
                    fields={fields}
                    users={users}
                    disabled={disabled}
                  />
                  {rule.access === 'edit' && (
                    <div className="space-y-3">
                      <RowScopeEditor
                        label={t('tables.access.rowsEdit')}
                        value={rule.editRows}
                        onChange={(editRows) => setRule(table.id, { ...rule, editRows })}
                        fields={fields}
                        users={users}
                        allowSame
                        disabled={disabled}
                      />
                      <div className="flex flex-wrap gap-4">
                        <Checkbox
                          label={t('tables.access.canCreate')}
                          checked={rule.create !== false}
                          disabled={disabled}
                          onChange={(event) => setRule(table.id, { ...rule, create: event.target.checked })}
                        />
                        <Checkbox
                          label={t('tables.access.canDelete')}
                          checked={rule.delete === true}
                          disabled={disabled}
                          onChange={(event) => setRule(table.id, { ...rule, delete: event.target.checked })}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-fg-muted">{t('tables.access.fields')}</p>
                      <p className="text-[11px] text-fg-faint">{t('tables.access.showAllFieldsHint')}</p>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2 text-xs text-fg-secondary">
                      {t('tables.access.showAllFields')}
                      <Toggle
                        size="sm"
                        checked={rule.fieldDefault === 'visible'}
                        disabled={disabled}
                        label={t('tables.access.showAllFields')}
                        onChange={(checked) =>
                          setRule(table.id, { ...rule, fieldDefault: checked ? 'visible' : 'hidden' })
                        }
                      />
                    </div>
                  </div>
                  <ul className="divide-y divide-edge rounded-lg border border-edge">
                    {fields.map((field) => {
                      const computed = isComputedField(field);
                      const declared = fieldAccessFor(rule, field.id);
                      const result = effective.get(field.id);
                      const options: TableFieldAccess[] =
                        rule.access === 'edit' && !computed ? ['hidden', 'read', 'edit'] : ['hidden', 'read'];
                      const note =
                        result?.reason === 'dependency_hidden'
                          ? t('tables.access.dependencyHidden')
                          : result?.reason === 'relation_target_hidden'
                            ? t('tables.access.relationTargetHidden')
                            : computed && rule.access === 'edit' && declared !== 'hidden'
                              ? t('tables.access.computedReadOnly')
                              : null;
                      return (
                        <li key={field.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-fg">{field.name}</p>
                            <p className="truncate text-[11px] text-fg-faint">{t(FIELD_TYPE_LABEL_KEYS[field.type])}</p>
                          </div>
                          {note && (
                            <Badge variant="secondary" className="gap-1" title={note}>
                              <Info size={10} />
                              {note}
                            </Badge>
                          )}
                          <Select
                            size="sm"
                            inline
                            aria-label={t('tables.access.fieldAccessOf', { name: field.name })}
                            value={options.includes(declared) ? declared : 'read'}
                            disabled={disabled}
                            onChange={(event) => {
                              const next = event.target.value as TableFieldAccess;
                              const others = rule.fields.filter((entry) => entry.fieldId !== field.id);
                              setRule(table.id, { ...rule, fields: [...others, { fieldId: field.id, access: next }] });
                            }}
                          >
                            {options.map((option) => (
                              <option key={option} value={option}>
                                {t(`tables.access.fieldAccess.${option}`)}
                              </option>
                            ))}
                          </Select>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </>
            )}
          </Card>
        );
      })}
    </div>
  );
}

/** Message for `incompleteRowScope` — kept next to the editor that produces it. */
export function useIncompleteScopeMessage() {
  const t = useT();
  return (issue: IncompleteRowScope, facts: TableAccessSchemaFacts) => {
    const table = facts.tables.find((entry) => entry.id === issue.tableId)?.name ?? `#${issue.tableId}`;
    return 'related' in issue
      ? t('tables.access.relatedNeedsPerson', { table })
      : t('tables.access.incompleteCondition', { index: issue.index, table });
  };
}
