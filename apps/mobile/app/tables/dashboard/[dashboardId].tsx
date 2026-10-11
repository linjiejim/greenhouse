/**
 * A Tables dashboard, read on the phone: its filters as a chip bar, then each
 * widget in layout order (top to bottom, left to right) drawn by the same card
 * bodies as an app page (src/tables/cards/*): KPI, chart, pivot, a few records,
 * text. Every widget is evaluated on the server for me (`POST
 * /dashboard-widgets/:id/query`, my role's rows and fields only); a widget I
 * cannot see says so. Building widgets stays on the web.
 *
 * Params: `dashboardId`, `name?`.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getDashboard,
  queryWidget,
  type TableDashboard,
  type TableDashboardWidget,
  type TableRecord,
} from '../../../src/api/tables';
import type { TableDashboardWidgetResult, TableRecordPage, TableSchema } from '../../../src/shared/tables-wire';
import { useT } from '../../../src/lib/i18n';
import { useAuth } from '../../../src/store/auth';
import { ChartBody, KpiBody, PivotBody, TextBody, useCardLabelContext } from '../../../src/tables/cards/aggregate';
import { CardFrame, CardNote } from '../../../src/tables/cards/card-frame';
import { FilterBar, type FilterValues } from '../../../src/tables/cards/filter-bar';
import { recordSummary } from '../../../src/tables/field-value';
import { useValueLabels } from '../../../src/tables/labels';
import { recordTitle, type FieldLike } from '../../../src/tables/model/fields';
import { TablesRouteGate } from '../../../src/tables/route-gate';
import { useTableUsers, useTables } from '../../../src/tables/store';
import { space, useTheme } from '../../../src/theme';
import { EmptyState, LoadingState } from '../../../src/ui/empty';
import { useHeaderInset } from '../../../src/ui/header-inset';
import { ListRow } from '../../../src/ui/list';

export default function DashboardScreen() {
  return (
    <TablesRouteGate area="tables">
      <DashboardPage />
    </TablesRouteGate>
  );
}

function layoutOf(widget: TableDashboardWidget): { x: number; y: number } {
  try {
    const layout = JSON.parse(widget.layout) as { x?: number; y?: number };
    return { x: Number(layout.x) || 0, y: Number(layout.y) || 0 };
  } catch {
    return { x: 0, y: widget.position };
  }
}

function DashboardPage() {
  const t = useT();
  const router = useRouter();
  const { hex } = useTheme();
  const headerHeight = useHeaderInset();
  const me = useAuth((s) => s.user?.id);
  const params = useLocalSearchParams<{ dashboardId: string; name?: string }>();
  const dashboardId = Number(params.dashboardId);
  const [dashboard, setDashboard] = useState<TableDashboard | null>(null);
  const [widgets, setWidgets] = useState<TableDashboardWidget[]>([]);
  const [state, setState] = useState<'loading' | 'ok' | 'gone' | 'failed'>('loading');
  const [results, setResults] = useState<Record<number, TableDashboardWidgetResult | 'failed' | undefined>>({});
  const [values, setValues] = useState<FilterValues>({});
  const [refreshing, setRefreshing] = useState(false);
  const users = useTableUsers();
  const labels = useValueLabels({ users });
  const schemas = useTables((s) => s.schemas);
  const loadSchema = useTables((s) => s.loadSchema);

  const load = useCallback(async () => {
    const result = await getDashboard(dashboardId);
    if (!result.ok) return setState(result.definitive ? 'gone' : 'failed');
    setDashboard(result.value.dashboard);
    setWidgets(
      [...result.value.widgets].sort((a, b) => {
        const la = layoutOf(a);
        const lb = layoutOf(b);
        return la.y - lb.y || la.x - lb.x;
      }),
    );
    setState('ok');
  }, [dashboardId]);
  useEffect(() => {
    void load();
  }, [load]);

  // every widget, evaluated for me with the current filter values
  const evaluate = useCallback(async () => {
    const answers = await Promise.all(widgets.map((widget) => queryWidget(widget.id, values)));
    setResults(
      Object.fromEntries(
        widgets.map((widget, index) => [
          widget.id,
          answers[index]!.ok ? (answers[index] as { value: TableDashboardWidgetResult }).value : 'failed',
        ]),
      ),
    );
  }, [widgets, values]);
  useEffect(() => {
    if (widgets.length) void evaluate();
  }, [widgets, evaluate]);

  // field names for labels: the schemas of the tables the widgets read
  const tableIds = useMemo(
    () => [...new Set(widgets.map((widget) => widget.table_id).filter((id): id is number => !!id))],
    [widgets],
  );
  useEffect(() => {
    for (const id of tableIds) void loadSchema(id);
  }, [tableIds, loadSchema]);
  const fields = useMemo<FieldLike[]>(
    () => tableIds.flatMap((id) => (schemas[id]?.fields ?? []).filter((field) => !field.archived_at)),
    [tableIds, schemas],
  );
  const ctx = useCardLabelContext(fields, labels.user);
  const fieldsById = useMemo(() => new Map(fields.map((field) => [field.id, field])), [fields]);
  const controls = dashboard?.config?.filters ?? [];

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    await evaluate();
    setRefreshing(false);
  }, [load, evaluate]);

  const title = dashboard?.name ?? params.name ?? '';
  if (state !== 'ok') {
    return (
      <>
        <Stack.Screen options={{ title }} />
        {state === 'loading' ? (
          <LoadingState style={{ paddingTop: headerHeight }} />
        ) : (
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
          >
            <EmptyState
              icon="alert"
              title={t('tables.dashboard.missing')}
              onRetry={state === 'failed' ? () => void load() : undefined}
            />
          </ScrollView>
        )}
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={hex.accent} />
        }
      >
        <FilterBar
          controls={controls}
          values={values}
          onChange={(id, value) => setValues((prev) => ({ ...prev, [id]: value }))}
          fieldsById={fieldsById}
          me={me}
          people={users.map((user) => ({ id: user.id, name: user.nickname || user.email }))}
        />
        {widgets.length === 0 ? <EmptyState icon="bar" title={t('tables.dashboard.empty')} /> : null}
        {widgets.map((widget) => {
          const answer = results[widget.id];
          return (
            <CardFrame key={widget.id} title={widget.title}>
              {widget.access === 'no_access' ? (
                <CardNote icon="lock" text={t('tables.dashboard.noAccess')} />
              ) : answer === undefined ? (
                <LoadingState style={{ flexGrow: 0, paddingVertical: space.md }} />
              ) : answer === 'failed' ? (
                <CardNote text={t('tables.dashboard.failed')} />
              ) : answer.result.kind === 'no_access' || !answer.card ? (
                <CardNote icon="lock" text={t('tables.dashboard.noAccess')} />
              ) : answer.result.kind === 'kpi' ? (
                <KpiBody spec={answer.card} value={answer.result.value} ctx={ctx} />
              ) : answer.result.kind === 'chart' || answer.result.kind === 'pivot' ? (
                answer.result.kind === 'chart' ? (
                  <ChartBody spec={answer.card} rows={answer.result.rows} ctx={ctx} />
                ) : (
                  <PivotBody spec={answer.card} rows={answer.result.rows} ctx={ctx} />
                )
              ) : answer.result.kind === 'text' ? (
                <TextBody markdown={answer.result.markdown} />
              ) : answer.result.kind === 'records' ? (
                <RecordsBody
                  page={answer.result.page}
                  schema={widget.table_id ? schemas[widget.table_id] : undefined}
                  labels={labels}
                  onOpen={(record) =>
                    router.push({
                      pathname: '/tables/record/[recordId]',
                      params: {
                        recordId: String(record.id),
                        tableId: String(record.table_id),
                        baseId: String(dashboard?.base_id ?? ''),
                      },
                    })
                  }
                />
              ) : null}
            </CardFrame>
          );
        })}
        <View style={{ height: space.xxl }} />
      </ScrollView>
    </>
  );
}

function RecordsBody({
  page,
  schema,
  labels,
  onOpen,
}: {
  page: TableRecordPage;
  schema: TableSchema | undefined;
  labels: ReturnType<typeof useValueLabels>;
  onOpen: (record: TableRecord) => void;
}) {
  const t = useT();
  const fields = (schema?.fields ?? []).filter((field) => !field.archived_at);
  if (!page.records.length) return <CardNote icon="table" text={t('apps.noRecords')} />;
  return (
    <View style={{ marginHorizontal: -space.md }}>
      {page.records.slice(0, 10).map((record, index, list) => (
        <ListRow
          key={record.id}
          title={recordTitle(record, fields, labels)}
          subtitle={
            recordSummary(
              record,
              fields.filter((field) => !field.is_primary),
              labels,
            ) || undefined
          }
          subtitleLines={1}
          accessory="chevron"
          last={index === list.length - 1}
          onPress={() => onOpen(record)}
        />
      ))}
    </View>
  );
}
