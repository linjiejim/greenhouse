/**
 * View options (a form sheet over the table page; spec §2 "筛选 / 排序 / 分组 /
 * 字段面板"): sort by one field (or a system column), group a list by a select /
 * person field, add filters (field · condition · value — the conditions the
 * phone offers per type, `filterOperators`), and choose which fields show.
 * These are session overrides for this phone (the store keeps them per view
 * until the account / station changes); saving a view stays a builder's web
 * job, and the footer says so. ✓ applies, ✕ discards (asks first when edited),
 * "Reset to the View" drops every override.
 *
 * Params: `tableId`, `viewId`. Android: ./view-options.android.tsx.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  DatePicker,
  Menu,
  Picker,
  ProgressView,
  Section,
  Text,
  TextField,
  Toggle,
  useNativeState,
} from '@expo/ui/swift-ui';
import { datePickerStyle, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { TableField } from '../../src/api/tables';
import type { TableFilterClause, TableFilterOperator, TableSort } from '../../src/shared/tables';
import { useT } from '../../src/lib/i18n';
import { dateToStamp, stampToDate, todayStamp } from '../../src/projects/meta';
import { effectiveType, selectOptions } from '../../src/tables/model/fields';
import {
  completeClause,
  filterOperators,
  groupableField,
  operatorTakesValue,
  sortableField,
  viewConfig,
  visibleFieldIds,
  type ViewOverrides,
} from '../../src/tables/model/views';
import { TablesRouteGate } from '../../src/tables/route-gate';
import { useSchema, useTableUsers, useTables, viewKey } from '../../src/tables/store';
import { NativeForm } from '../../src/ui/native-form';
import { FormChrome } from '../../src/ui/sheet-chrome';

export default function ViewOptionsScreen() {
  return (
    <TablesRouteGate area="tables" latched>
      <ViewOptions />
    </TablesRouteGate>
  );
}

type Draft = {
  clauses: Array<TableFilterClause & { key: number }>;
  sort: TableSort | null;
  group: number | null | undefined;
  fieldIds: number[];
};

let clauseSeq = 0;

function ViewOptions() {
  const t = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{ tableId: string; viewId: string }>();
  const tableId = Number(params.tableId);
  const viewId = Number(params.viewId) || null;
  const { schema } = useSchema(tableId);
  const users = useTableUsers();
  const key = viewKey(tableId, viewId);
  const current = useTables((s) => s.overrides[key]);
  const setOverrides = useTables((s) => s.setOverrides);
  const view = schema?.views.find((entry) => entry.id === viewId);
  const config = useMemo(() => viewConfig(view), [view]);
  const fields = useMemo(
    () => [...(schema?.fields ?? [])].filter((field) => !field.archived_at).sort((a, b) => a.position - b.position),
    [schema],
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);

  // the draft starts from what applies now (overrides over the view)
  useEffect(() => {
    if (draft || !schema) return;
    setDraft({
      clauses: (current?.clauses ?? []).map((clause) => ({ ...clause, key: ++clauseSeq })),
      sort: (current?.sort ?? config.query?.sort)?.[0] ?? null,
      group: current?.groupFieldId,
      fieldIds: visibleFieldIds(config, fields, current),
    });
  }, [draft, schema, current, config, fields]);

  const update = (patch: Partial<Draft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  };
  const updateClause = (clauseKey: number, patch: Partial<TableFilterClause>) =>
    update({
      clauses: (draft?.clauses ?? []).map((clause) =>
        clause.key === clauseKey ? ({ ...clause, ...patch } as Draft['clauses'][number]) : clause,
      ),
    });

  const apply = () => {
    if (!draft) return;
    const viewSort = config.query?.sort?.[0] ?? null;
    const sortChanged = JSON.stringify(draft.sort) !== JSON.stringify(viewSort);
    const fieldsChanged = JSON.stringify(draft.fieldIds) !== JSON.stringify(visibleFieldIds(config, fields));
    const clauses = draft.clauses.map(({ key: _key, ...clause }) => completeClause(clause)).filter((c) => !!c);
    const next: ViewOverrides = {
      ...(sortChanged ? { sort: draft.sort ? [draft.sort] : [] } : {}),
      ...(clauses.length ? { clauses } : {}),
      ...(fieldsChanged ? { fieldIds: draft.fieldIds } : {}),
      ...(draft.group !== undefined ? { groupFieldId: draft.group } : {}),
    };
    setOverrides(key, Object.keys(next).length ? next : undefined);
    router.back();
  };

  const isList = (view?.type ?? 'grid') === 'grid';
  const sortable = fields.filter(sortableField);
  const groupable = fields.filter(groupableField);
  const fieldById = (id: number | undefined) => fields.find((field) => field.id === id);
  const sortValue = draft?.sort
    ? draft.sort.systemField
      ? `s:${draft.sort.systemField}`
      : `f:${draft.sort.fieldId}`
    : '';

  return (
    <>
      <FormChrome title={t('tables.options.title')} dirty={dirty} canSave={!!draft} onSave={apply} />
      <NativeForm>
        {!draft ? (
          <Section>
            <ProgressView />
          </Section>
        ) : (
          <>
            <Section title={t('tables.options.sort')} footer={<Text>{t('tables.options.footer')}</Text>}>
              <Picker
                label={t('tables.options.sort')}
                selection={sortValue}
                onSelectionChange={(value) => {
                  const text = String(value ?? '');
                  if (!text) return update({ sort: null });
                  const direction = draft.sort?.direction ?? 'asc';
                  update({
                    sort: text.startsWith('s:')
                      ? { systemField: text.slice(2) as TableSort['systemField'], direction }
                      : { fieldId: Number(text.slice(2)), direction },
                  });
                }}
                modifiers={[pickerStyle('menu')]}
              >
                <Text modifiers={[tag('')]}>{t('tables.options.sortNone')}</Text>
                {sortable.map((field) => (
                  <Text key={field.id} modifiers={[tag(`f:${field.id}`)]}>
                    {field.name}
                  </Text>
                ))}
                <Text modifiers={[tag('s:created_at')]}>{t('tables.system.created_at')}</Text>
                <Text modifiers={[tag('s:updated_at')]}>{t('tables.system.updated_at')}</Text>
              </Picker>
              {draft.sort ? (
                <Picker
                  selection={draft.sort.direction}
                  onSelectionChange={(value) =>
                    update({ sort: { ...draft.sort!, direction: value === 'desc' ? 'desc' : 'asc' } })
                  }
                  modifiers={[pickerStyle('segmented')]}
                >
                  <Text modifiers={[tag('asc')]}>{t('tables.options.ascending')}</Text>
                  <Text modifiers={[tag('desc')]}>{t('tables.options.descending')}</Text>
                </Picker>
              ) : null}
            </Section>

            {isList && groupable.length ? (
              <Section title={t('tables.options.group')}>
                <Picker
                  label={t('tables.options.group')}
                  selection={draft.group === undefined ? (config.groupBy?.fieldId ?? 0) : (draft.group ?? 0)}
                  onSelectionChange={(value) => update({ group: Number(value) || null })}
                  modifiers={[pickerStyle('menu')]}
                >
                  <Text modifiers={[tag(0)]}>{t('tables.options.groupNone')}</Text>
                  {groupable.map((field) => (
                    <Text key={field.id} modifiers={[tag(field.id)]}>
                      {field.name}
                    </Text>
                  ))}
                </Picker>
              </Section>
            ) : null}

            {draft.clauses.map((clause) => {
              const field = fieldById(clause.fieldId);
              if (!field) return null;
              return (
                <Section key={clause.key} title={field.name}>
                  <Picker
                    label={t('tables.options.operator')}
                    selection={clause.operator}
                    onSelectionChange={(value) =>
                      updateClause(clause.key, {
                        operator: value as TableFilterOperator,
                        value: startValue(field, value as TableFilterOperator),
                      })
                    }
                    modifiers={[pickerStyle('menu')]}
                  >
                    {filterOperators(field).map((operator) => (
                      <Text key={operator} modifiers={[tag(operator)]}>
                        {t(`tables.op.${operator}`)}
                      </Text>
                    ))}
                  </Picker>
                  {operatorTakesValue(clause.operator) ? (
                    <ClauseValue
                      field={field}
                      value={clause.value}
                      users={users}
                      onChange={(value) => updateClause(clause.key, { value })}
                    />
                  ) : null}
                  <Button
                    label={t('tables.options.remove')}
                    role="destructive"
                    onPress={() => update({ clauses: draft.clauses.filter((entry) => entry.key !== clause.key) })}
                  />
                </Section>
              );
            })}

            <Section title={draft.clauses.length ? undefined : t('tables.options.filters')}>
              <Menu label={t('tables.options.addFilter')} systemImage="line.3.horizontal.decrease.circle">
                {fields.map((field) => (
                  <Button
                    key={field.id}
                    label={field.name}
                    onPress={() =>
                      update({
                        clauses: [
                          ...draft.clauses,
                          {
                            key: ++clauseSeq,
                            fieldId: field.id,
                            operator: filterOperators(field)[0]!,
                            value: startValue(field, filterOperators(field)[0]!),
                          },
                        ],
                      })
                    }
                  />
                ))}
              </Menu>
            </Section>

            <Section title={t('tables.options.fields')}>
              {fields.map((field) => (
                <Toggle
                  key={field.id}
                  label={field.name}
                  isOn={draft.fieldIds.includes(field.id)}
                  onIsOnChange={(on) =>
                    update({
                      fieldIds: on
                        ? fields.map((entry) => entry.id).filter((id) => id === field.id || draft.fieldIds.includes(id))
                        : draft.fieldIds.filter((id) => id !== field.id),
                    })
                  }
                />
              ))}
            </Section>

            {current ? (
              <Section>
                <Button
                  label={t('tables.options.reset')}
                  role="destructive"
                  onPress={() => {
                    setOverrides(key, undefined);
                    router.back();
                  }}
                />
              </Section>
            ) : null}
          </>
        )}
      </NativeForm>
    </>
  );
}

/** A new clause's value: a day for dates (the picker always shows one), "yes" for a boolean, else empty. */
function startValue(field: TableField, operator: TableFilterOperator): unknown {
  if (!operatorTakesValue(operator)) return undefined;
  const type = effectiveType(field);
  if (type === 'date' || type === 'datetime') return todayStamp();
  if (type === 'boolean') return true;
  return undefined;
}

/** The value of one filter clause, by the field's type. */
function ClauseValue({
  field,
  value,
  users,
  onChange,
}: {
  field: TableField;
  value: unknown;
  users: ReturnType<typeof useTableUsers>;
  onChange: (value: unknown) => void;
}) {
  const t = useT();
  const type = effectiveType(field);
  if (type === 'single_select' || type === 'multi_select') {
    return (
      <Picker
        label={t('tables.options.value')}
        selection={typeof value === 'string' ? value : ''}
        onSelectionChange={(next) => onChange(next ? String(next) : undefined)}
        modifiers={[pickerStyle('menu')]}
      >
        <Text modifiers={[tag('')]}>{t('tables.options.choose')}</Text>
        {selectOptions(field).map((option) => (
          <Text key={option.id} modifiers={[tag(option.id)]}>
            {option.label}
          </Text>
        ))}
      </Picker>
    );
  }
  if (type === 'user' || type === 'multi_user') {
    return (
      <Picker
        label={t('tables.options.value')}
        selection={typeof value === 'string' ? value : ''}
        onSelectionChange={(next) => onChange(next ? String(next) : undefined)}
        modifiers={[pickerStyle('menu')]}
      >
        <Text modifiers={[tag('')]}>{t('tables.options.choose')}</Text>
        <Text modifiers={[tag('$me')]}>{t('tables.options.me')}</Text>
        {users.map((user) => (
          <Text key={user.id} modifiers={[tag(user.id)]}>
            {user.nickname || user.email}
          </Text>
        ))}
      </Picker>
    );
  }
  if (type === 'boolean') {
    return (
      <Picker
        label={t('tables.options.value')}
        selection={value === false ? 'false' : 'true'}
        onSelectionChange={(next) => onChange(next === 'true')}
        modifiers={[pickerStyle('segmented')]}
      >
        <Text modifiers={[tag('true')]}>{t('common.yes')}</Text>
        <Text modifiers={[tag('false')]}>{t('common.no')}</Text>
      </Picker>
    );
  }
  if (type === 'date' || type === 'datetime') {
    const day = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
    return (
      <DatePicker
        title={t('tables.options.value')}
        selection={stampToDate(day ?? todayStamp())}
        displayedComponents={['date']}
        onDateChange={(next) => onChange(dateToStamp(next))}
        modifiers={[datePickerStyle('compact')]}
      />
    );
  }
  return (
    <TextValue
      initial={value == null ? '' : String(value)}
      number={type === 'number' || type === 'rollup'}
      onChange={onChange}
    />
  );
}

function TextValue({
  initial,
  number,
  onChange,
}: {
  initial: string;
  number: boolean;
  onChange: (value: unknown) => void;
}) {
  const t = useT();
  const text = useNativeState(initial);
  return (
    <TextField
      text={text}
      placeholder={t('tables.options.value')}
      onTextChange={(next) => {
        if (!number) return onChange(next);
        const parsed = Number(next.replace(/,/g, ''));
        onChange(next.trim() && Number.isFinite(parsed) ? parsed : undefined);
      }}
    />
  );
}
