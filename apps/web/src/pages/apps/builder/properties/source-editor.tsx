/**
 * Where a records-like card reads from (`AppDataSource`): the table, which
 * records (`query.where` through the shared condition editor — `$me`, date
 * tokens and record info included), conditions that follow a page filter
 * (`$page.<filterId>`, kept as one extra ANDed group in `query.filters`) and
 * the order. What each role reads is still cut by the role's rule on the
 * server; this only narrows the card.
 */

import type { AppDataSource } from '@greenhouse/types/apps';
import {
  TABLE_SYSTEM_FIELDS,
  type TableFilterClause,
  type TableFilterControl,
  type TableFilterGroup,
  type TableFilterOperator,
  type TableQuery,
  type TableSort,
} from '@greenhouse/types/tables';
import { Button, IconButton, Select } from '../../../../components/ui';
import { FormField, FormGrid } from '../../../../components/form';
import { SYSTEM_FIELD_LABEL_KEYS } from '../../../../components/tables/field-types';
import { filterOperatorsFor, OPERATOR_LABEL_KEYS } from '../../../../components/tables/filter-model';
import type { TableDefinition, TableField, TableUserOption } from '../../../../lib/api/tables';
import { useT } from '../../../../lib/i18n';
import { Plus, X } from '../../../../lib/icons';
import { isPageRef, pageRef, PAGE_REF_PREFIX } from '../spec-model';
import { ConditionEditor, PanelSection } from './common';

type Query = NonNullable<AppDataSource['query']>;

/** A group that is nothing but page-filter conditions (the builder writes them as one ANDed group). */
function isPageRefGroup(group: TableFilterGroup): boolean {
  return (
    group.combinator === 'and' && group.clauses.length > 0 && group.clauses.every((clause) => isPageRef(clause.value))
  );
}

export function pageRefClauses(query: Query | undefined): TableFilterClause[] {
  return (query?.filters ?? []).filter(isPageRefGroup).flatMap((group) => group.clauses);
}

/** Write the parts of a query back, dropping what is empty (an empty `query` is no query). */
export function withQuery(
  source: AppDataSource,
  patch: { where?: TableFilterGroup | null; pageRefs?: TableFilterClause[]; sort?: TableSort[] | null },
): AppDataSource {
  const query: Omit<TableQuery, 'cursor' | 'limit'> = { ...(source.query ?? {}) };
  if (patch.where !== undefined) {
    if (patch.where) query.where = patch.where;
    else delete query.where;
  }
  if (patch.pageRefs !== undefined) {
    const others = (query.filters ?? []).filter((group) => !isPageRefGroup(group));
    const filters =
      patch.pageRefs.length > 0 ? [...others, { combinator: 'and' as const, clauses: patch.pageRefs }] : others;
    if (filters.length > 0) query.filters = filters;
    else delete query.filters;
  }
  if (patch.sort !== undefined) {
    if (patch.sort && patch.sort.length > 0) query.sort = patch.sort;
    else delete query.sort;
  }
  return Object.keys(query).length > 0 ? { tableId: source.tableId, query } : { tableId: source.tableId };
}

export function PageRefsEditor({
  clauses,
  onChange,
  fields,
  filters,
}: {
  clauses: TableFilterClause[];
  onChange: (next: TableFilterClause[]) => void;
  fields: TableField[];
  filters: readonly TableFilterControl[];
}) {
  const t = useT();
  if (filters.length === 0) return <p className="text-xs text-fg-faint">{t('apps.builder.props.pageRefsNone')}</p>;
  const update = (index: number, next: TableFilterClause) =>
    onChange(clauses.map((clause, at) => (at === index ? next : clause)));
  const operatorsOf = (fieldId: number | undefined): TableFilterOperator[] => {
    const field = fields.find((entry) => entry.id === fieldId);
    return field
      ? filterOperatorsFor({ kind: 'field', field }).filter((op) => op !== 'is_empty' && op !== 'is_not_empty')
      : [];
  };
  return (
    <div className="space-y-2">
      {clauses.map((clause, index) => {
        const operators = operatorsOf(clause.fieldId);
        const filterId = typeof clause.value === 'string' ? clause.value.slice(PAGE_REF_PREFIX.length) : '';
        return (
          <div
            key={index}
            className="grid grid-cols-1 gap-2 rounded-md border border-edge p-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
          >
            <Select
              size="sm"
              aria-label={t('apps.builder.props.pageRefField')}
              value={clause.fieldId ?? ''}
              onChange={(event) => {
                const fieldId = Number(event.target.value);
                update(index, { fieldId, operator: operatorsOf(fieldId)[0] ?? 'eq', value: clause.value });
              }}
            >
              {fields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
            </Select>
            <Select
              size="sm"
              aria-label={t('apps.builder.props.pageRefOperator')}
              value={clause.operator}
              onChange={(event) => update(index, { ...clause, operator: event.target.value as TableFilterOperator })}
            >
              {operators.map((operator) => (
                <option key={operator} value={operator}>
                  {t(OPERATOR_LABEL_KEYS[operator])}
                </option>
              ))}
            </Select>
            <Select
              size="sm"
              aria-label={t('apps.builder.props.pageRefFilter')}
              value={filterId}
              onChange={(event) => update(index, { ...clause, value: pageRef(event.target.value) })}
            >
              {!filters.some((control) => control.id === filterId) && <option value={filterId}>{filterId}</option>}
              {filters.map((control) => (
                <option key={control.id} value={control.id}>
                  {control.label}
                </option>
              ))}
            </Select>
            <IconButton
              variant="destructive"
              label={t('apps.builder.props.pageRefRemove')}
              onClick={() => onChange(clauses.filter((_, at) => at !== index))}
            >
              <X size={12} />
            </IconButton>
          </div>
        );
      })}
      {fields.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const field = fields[0]!;
            onChange([
              ...clauses,
              {
                fieldId: field.id,
                operator: operatorsOf(field.id)[0] ?? 'eq',
                value: pageRef(filters[0]!.id),
              },
            ]);
          }}
        >
          <Plus size={13} className="mr-1.5" />
          {t('apps.builder.props.pageRefAdd')}
        </Button>
      )}
    </div>
  );
}

function sortKey(sort: TableSort | undefined): string {
  if (!sort) return '';
  return sort.systemField ? `s:${sort.systemField}` : sort.fieldId ? `f:${sort.fieldId}` : '';
}

export function SourceEditor({
  source,
  onChange,
  onTableChange,
  tables,
  fields,
  users,
  pageFilters,
}: {
  source: AppDataSource;
  onChange: (next: AppDataSource) => void;
  /** Another table: the host resets the card's field-bound settings. */
  onTableChange: (tableId: number) => void;
  /** Tables that can host this kind of card. */
  tables: readonly TableDefinition[];
  /** Fields of `source.tableId`. */
  fields: TableField[];
  users: TableUserOption[];
  pageFilters: readonly TableFilterControl[];
}) {
  const t = useT();
  const sort = source.query?.sort?.[0];
  const sortChoice = sortKey(sort);
  const sortable = fields.filter((field) => field.type !== 'attachment' && field.type !== 'lookup');
  return (
    <>
      <PanelSection title={t('apps.builder.props.source')}>
        <FormField label={t('apps.builder.props.table')}>
          <Select value={source.tableId} onChange={(event) => onTableChange(Number(event.target.value))}>
            {tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.name}
              </option>
            ))}
          </Select>
        </FormField>
      </PanelSection>
      <PanelSection title={t('apps.builder.props.conditions')} hint={t('apps.builder.props.conditionsHint')}>
        <ConditionEditor
          value={source.query?.where}
          onChange={(where) => onChange(withQuery(source, { where: where ?? null }))}
          fields={fields}
          users={users}
          testId="app-card-conditions"
        />
      </PanelSection>
      <PanelSection title={t('apps.builder.props.pageRefs')} hint={t('apps.builder.props.pageRefsHint')}>
        <PageRefsEditor
          clauses={pageRefClauses(source.query)}
          onChange={(pageRefs) => onChange(withQuery(source, { pageRefs }))}
          fields={fields}
          filters={pageFilters}
        />
      </PanelSection>
      <PanelSection title={t('apps.builder.props.sort')}>
        <FormGrid>
          <FormField label={t('apps.builder.props.sortField')}>
            <Select
              size="sm"
              value={sortChoice}
              onChange={(event) => {
                const key = event.target.value;
                if (!key) return onChange(withQuery(source, { sort: null }));
                const direction = sort?.direction ?? 'asc';
                const next: TableSort = key.startsWith('s:')
                  ? { systemField: key.slice(2) as TableSort['systemField'], direction }
                  : { fieldId: Number(key.slice(2)), direction };
                onChange(withQuery(source, { sort: [next] }));
              }}
            >
              <option value="">{t('apps.builder.props.sortNone')}</option>
              {sortable.map((field) => (
                <option key={field.id} value={`f:${field.id}`}>
                  {field.name}
                </option>
              ))}
              {TABLE_SYSTEM_FIELDS.map((field) => (
                <option key={field} value={`s:${field}`}>
                  {t(SYSTEM_FIELD_LABEL_KEYS[field])}
                </option>
              ))}
            </Select>
          </FormField>
          {sort && (
            <FormField label={t('apps.builder.props.sortDirection')}>
              <Select
                size="sm"
                value={sort.direction}
                onChange={(event) =>
                  onChange(withQuery(source, { sort: [{ ...sort, direction: event.target.value as 'asc' | 'desc' }] }))
                }
              >
                <option value="asc">{t('apps.builder.props.sortAsc')}</option>
                <option value="desc">{t('apps.builder.props.sortDesc')}</option>
              </Select>
            </FormField>
          )}
        </FormGrid>
      </PanelSection>
    </>
  );
}
