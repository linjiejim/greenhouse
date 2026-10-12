/**
 * A table on one of its views (spec 20261011-mobile-tables-apps §2): list,
 * kanban, calendar or gallery (src/tables/views/*); a view type this build
 * does not draw (a newer server) says "open this on the web" instead of
 * crashing. The navigation bar carries the view menu (every view I can see,
 * the current one checked), the view options (sort / filter / group / fields —
 * session overrides on this phone, `app/tables/view-options.tsx`) and `+` (a
 * new record, when my role may create). The native search bar searches the
 * view's readable text fields on the server.
 *
 * What I may do comes from my Base workspace (`getBase.access`); the server
 * re-checks every write. Records refetch on focus and after any write on the
 * table (the record sheet, a lane move).
 *
 * Params: `tableId`, `viewId?`, `baseId?` (else the schema's), `name?`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { updateRecordWithReplay, type TableRecord, type TableView } from '../../../src/api/tables';
import { putHandoff } from '../../../src/lib/handoff';
import { useT } from '../../../src/lib/i18n';
import { useValueLabels } from '../../../src/tables/labels';
import { tableAbilities } from '../../../src/tables/model/access';
import { primaryField } from '../../../src/tables/model/fields';
import {
  hasOverrides,
  isMobileViewType,
  listGroupFieldId,
  viewConfig,
  viewQuery,
  visibleFieldIds,
  VIEW_PAGE_SIZE,
  VIEW_RECORD_LIMIT,
} from '../../../src/tables/model/views';
import { TablesRouteGate } from '../../../src/tables/route-gate';
import { useSchema, useTableUsers, useTables, useWorkspace, viewKey } from '../../../src/tables/store';
import { useRecords } from '../../../src/tables/use-records';
import { CalendarView } from '../../../src/tables/views/calendar';
import { GalleryView } from '../../../src/tables/views/gallery';
import { KanbanView } from '../../../src/tables/views/kanban';
import { ListView } from '../../../src/tables/views/list';
import type { ViewContext } from '../../../src/tables/views/types';
import { makeStyles, space, typo, useTheme } from '../../../src/theme';
import type { IconName } from '../../../src/ui/core';
import { alertError } from '../../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../../src/ui/empty';
import { useHeaderInset } from '../../../src/ui/header-inset';
import { toolbarIcon } from '../../../src/ui/toolbar-icon';

const VIEW_ICON: Record<string, IconName> = { grid: 'list', kanban: 'board', calendar: 'calendar', gallery: 'photos' };

export default function TableScreen() {
  return (
    <TablesRouteGate area="tables">
      <TablePage />
    </TablesRouteGate>
  );
}

function TablePage() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderInset();
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const params = useLocalSearchParams<{ tableId: string; viewId?: string; baseId?: string; name?: string }>();
  const tableId = Number(params.tableId);
  const { schema, failed, reload } = useSchema(tableId);
  const baseId = Number(params.baseId) || schema?.table.base_id || 0;
  const { workspace } = useWorkspace(baseId);
  const users = useTableUsers();
  const labels = useValueLabels({ users });
  const recordsChanged = useTables((s) => s.recordsChanged);

  const views = useMemo<TableView[]>(
    () => [...(schema?.views ?? [])].sort((a, b) => a.position - b.position || a.id - b.id),
    [schema],
  );
  const [viewId, setViewId] = useState<number | null>(Number(params.viewId) || null);
  const view = views.find((entry) => entry.id === viewId) ?? views[0];
  const config = useMemo(() => viewConfig(view), [view]);
  const overrides = useTables((s) => s.overrides[viewKey(tableId, view?.id)]);
  const fields = useMemo(
    () => [...(schema?.fields ?? [])].filter((field) => !field.archived_at).sort((a, b) => a.position - b.position),
    [schema],
  );
  const shownIds = useMemo(() => visibleFieldIds(config, fields, overrides), [config, fields, overrides]);
  const shown = useMemo(
    () => shownIds.map((id) => fields.find((field) => field.id === id)).filter((field) => !!field),
    [shownIds, fields],
  );
  const abilities = useMemo(() => tableAbilities(workspace, tableId, fields), [workspace, tableId, fields]);

  // native search: debounced, on the server
  const [search, setSearch] = useState('');
  const [typed, setTyped] = useState('');
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearch = useCallback((text: string) => {
    setTyped(text);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setSearch(text.trim()), 300);
  }, []);
  useEffect(() => () => (debounce.current ? clearTimeout(debounce.current) : undefined), []);

  const type = view?.type ?? 'grid';
  const drawable = !!view && isMobileViewType(type);
  const query = useMemo(
    () => (view && drawable ? viewQuery(type, config, { overrides, search }) : null),
    [view, drawable, type, config, overrides, search],
  );
  const data = useRecords(tableId, type === 'calendar' ? null : query, {
    pageSize: type === 'kanban' ? VIEW_RECORD_LIMIT : VIEW_PAGE_SIZE,
  });

  const ctx = useMemo<ViewContext>(
    () => ({
      tableId,
      fields,
      shown,
      primary: primaryField(fields),
      labels,
      abilities,
      bottomInset: insets.bottom,
      open: (record: TableRecord) =>
        router.push({
          pathname: '/tables/record/[recordId]',
          params: { recordId: String(record.id), tableId: String(tableId), baseId: String(baseId) },
        }),
      create: (defaults?: Record<string, unknown>) =>
        router.push({
          pathname: '/tables/record-form',
          params: {
            tableId: String(tableId),
            baseId: String(baseId),
            ...(defaults && Object.keys(defaults).length ? { k: putHandoff('record-defaults', defaults) } : {}),
          },
        }),
    }),
    [tableId, fields, shown, labels, abilities, insets.bottom, router, baseId],
  );

  const move = useCallback(
    async (record: TableRecord, value: string | null) => {
      const fieldId = config.kanban?.groupFieldId;
      if (!fieldId) return;
      const values = { [String(fieldId)]: value };
      data.patch(record.id, { values: { ...record.values, ...values } });
      const result = await updateRecordWithReplay(tableId, record, values);
      if (!result.ok) alertError(t('tables.moveFailed'), result.message || undefined);
      recordsChanged(tableId);
    },
    [config.kanban?.groupFieldId, data, tableId, recordsChanged, t],
  );

  const title = schema?.table.name ?? params.name ?? '';
  if (!schema) {
    return (
      <>
        <Stack.Screen options={{ title }} />
        {failed ? (
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
          >
            <EmptyState
              icon="alert"
              title={t('tables.tableMissing')}
              message={t('tables.baseMissingHint')}
              onRetry={() => void reload({ fresh: true })}
            />
          </ScrollView>
        ) : (
          <LoadingState style={{ paddingTop: headerHeight }} />
        )}
      </>
    );
  }

  const changed = hasOverrides(overrides);
  const banner = view ? (
    <Text style={styles.banner}>
      {view.name}
      {changed ? ` · ${t('tables.overridden')}` : ''}
    </Text>
  ) : null;

  return (
    <>
      <Stack.Screen options={{ title }} />
      <Stack.SearchBar
        placeholder={t('tables.searchRecords')}
        onChangeText={(e) => onSearch(e.nativeEvent.text)}
        onCancelButtonPress={() => onSearch('')}
        tintColor={hex.accent}
        autoCapitalize="none"
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon={toolbarIcon(VIEW_ICON[type] ?? 'list')}
          accessibilityLabel={t('tables.viewMenu')}
          title={t('tables.views')}
        >
          {views.map((entry) => (
            <Stack.Toolbar.MenuAction
              key={entry.id}
              icon={toolbarIcon(VIEW_ICON[entry.type] ?? 'list')}
              isOn={entry.id === view?.id}
              subtitle={entry.scope === 'personal' ? t('tables.personal') : undefined}
              onPress={() => setViewId(entry.id)}
            >
              {entry.name}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button
          icon={toolbarIcon(changed ? 'filterOn' : 'filter')}
          hidden={!drawable}
          accessibilityLabel={t('tables.viewOptions')}
          onPress={() =>
            router.push({
              pathname: '/tables/view-options',
              params: { tableId: String(tableId), viewId: String(view?.id ?? '') },
            })
          }
        />
        <Stack.Toolbar.Button
          icon={toolbarIcon('plus')}
          hidden={!abilities.canCreate}
          accessibilityLabel={t('tables.newRecord')}
          onPress={() => ctx.create()}
        />
      </Stack.Toolbar>

      {!view || !drawable ? (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
        >
          <EmptyState icon="open" title={t('tables.openOnWeb')} message={t('tables.openOnWebHint')} />
        </ScrollView>
      ) : type === 'kanban' ? (
        <View style={{ flex: 1, paddingTop: headerHeight }}>
          {banner}
          <KanbanView
            ctx={ctx}
            data={data}
            config={config.kanban}
            onMove={(record, value) => void move(record, value)}
          />
        </View>
      ) : type === 'calendar' ? (
        <CalendarView ctx={ctx} config={config.calendar} baseQuery={query ?? {}} header={banner} />
      ) : type === 'gallery' ? (
        <GalleryView ctx={ctx} data={data} config={config.gallery} searching={!!typed.trim()} header={banner} />
      ) : (
        <ListView
          ctx={ctx}
          data={data}
          groupFieldId={listGroupFieldId(config, overrides)}
          searching={!!typed.trim()}
          header={banner}
        />
      )}
    </>
  );
}

const useStyles = makeStyles((c) => ({
  banner: {
    ...typo.footnote,
    color: c.secondaryLabel,
    paddingHorizontal: space.margin + space.xs,
    paddingTop: space.xs,
    paddingBottom: space.sm,
  },
}));
