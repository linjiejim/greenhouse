import { useAuth } from '../../src/store/auth';
import { visiblePages } from '../../src/data/pages';
import { Board, Timeline, dayLabel } from '../../src/tables/boards';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { memberDirectory } from '../../src/api/me';
import { base, records } from '../../src/api/tables';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import { cellText, shownFields, titleOf, groups, agendaGroups } from '../../src/tables/model';
import { MAX_VIEW_RECORDS, type TableRecord } from '../../src/shared/contract';
import { ListRow, ListSectionHeader } from '../../src/ui/list';
import { NativeButton } from '../../src/ui/button';
import { EmptyState } from '../../src/ui/empty';
import { alertError } from '../../src/ui/dialogs';
import { toolbarIcon } from '../../src/ui/toolbar-icon';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
export default function TableView() {
  const {
    base: baseId = '',
    table: tableId = '',
    view: viewId,
  } = useLocalSearchParams<{ base: string; table: string; view?: string }>();
  const t = useT();
  const timeZone = useAuth((s) => s.user?.timezone ?? 'UTC');
  const router = useRouter();
  const { colors: c } = useTheme();
  const s = useStyles(c);
  const b = useResource(
    useCallback(() => base(baseId), [baseId]),
    ['base.updated'],
  );
  const table = b.data?.tables.find((v) => v.id === tableId);
  const members = useResource(useCallback(() => memberDirectory(), []));
  const names = useMemo(
    () => Object.fromEntries((members.data?.items ?? []).map((member) => [member.id, member.name])),
    [members.data],
  );
  const view = b.data?.views.find((v) => v.id === viewId);
  const [search, setSearch] = useState('');
  const [grid, setGrid] = useState(false);
  const [paging, setPaging] = useState(false);
  const config = view?.config;
  const options = useMemo(
    () => ({ filter: config?.filter, sorts: config?.sorts, group: config?.group, search, limit: 200 }),
    [config, search],
  );
  const visible = useRef(1);
  useEffect(() => {
    visible.current = 1;
    setPaging(false);
  }, [tableId, options]);
  const r = useResource(
    useCallback(
      () =>
        visiblePages(
          (cursor) => records(tableId, { ...options, cursor }),
          visible.current,
          (before, after) => ({
            ...after,
            items: [...before.items, ...after.items],
            linked: { ...before.linked, ...after.linked },
            files: { ...before.files, ...after.files },
          }),
        ),
      [tableId, options],
    ),
    ['records.changed', 'base.updated'],
  );
  const open = (record: TableRecord) => router.push({ pathname: '/tables/record', params: { id: record.id } });
  const more = async () => {
    const current = r.capture();
    if (!r.data?.next_cursor || paging || r.data.items.length >= MAX_VIEW_RECORDS) return;
    setPaging(true);
    const result = await records(tableId, { ...options, cursor: r.data.next_cursor });
    setPaging(false);
    if (!current()) return;
    if (!result.ok) {
      alertError(t('work.loadFailed'), undefined, result.message);
      return;
    }
    visible.current++;
    r.setData((old) =>
      old
        ? {
            ...result.data,
            items: [...old.items, ...result.data.items.filter((item) => !old.items.some((p) => p.id === item.id))],
            linked: { ...old.linked, ...result.data.linked },
            files: { ...old.files, ...result.data.files },
          }
        : old,
    );
  };
  const fields = table ? shownFields(table, view).slice(0, 6) : [];
  const type = view?.type ?? 'grid';
  const grouping =
    type === 'kanban'
      ? config?.kanban?.field
      : type === 'calendar'
        ? config?.calendar?.start
        : type === 'timeline'
          ? config?.timeline?.start
          : config?.group?.field;
  const rows = useMemo(
    () =>
      type === 'calendar'
        ? agendaGroups(r.data?.items ?? [], grouping, timeZone)
        : groups(r.data?.items ?? [], grouping),
    [r.data?.items, grouping, type, timeZone],
  );
  const itemRow = (record: TableRecord) => (
    <ListRow
      key={record.id}
      title={table ? titleOf(record, table) : ''}
      subtitle={fields
        .slice(1, 4)
        .map((f) => cellText(f, record.values[f.id], r.data ?? undefined, names))
        .filter(Boolean)
        .join(' · ')}
      onPress={() => open(record)}
      accessory="chevron"
    />
  );
  return (
    <>
      <Stack.Screen options={{ title: view?.name ?? table?.name ?? t('work.records') }} />
      <Stack.SearchBar
        placeholder={t('work.searchRecords')}
        onChangeText={(e) => setSearch(e.nativeEvent.text.slice(0, 200))}
      />
      {type === 'grid' ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon={toolbarIcon(grid ? 'form' : 'table')}
            accessibilityLabel={t(grid ? 'work.list' : 'work.grid')}
            onPress={() => setGrid((v) => !v)}
          />
        </Stack.Toolbar>
      ) : null}
      {!b.data || !r.data || !table ? (
        <ResourceState
          loading={b.loading || r.loading}
          retry={() => {
            void b.refresh();
            void r.refresh();
          }}
        />
      ) : type === 'dashboard' ? (
        <EmptyState icon="table" title={t('work.viewUnavailable')} />
      ) : !r.data.items.length ? (
        <EmptyState icon="table" title={t('work.noRecords')} />
      ) : type === 'kanban' && view ? (
        <Board
          names={names}
          page={r.data}
          table={table}
          view={view}
          onOpen={open}
          more={
            r.data.next_cursor && r.data.items.length < MAX_VIEW_RECORDS ? (
              <NativeButton label={t('work.more')} loading={paging} onPress={() => void more()} />
            ) : null
          }
        />
      ) : type === 'timeline' && view ? (
        <Timeline
          page={r.data}
          table={table}
          view={view}
          onOpen={open}
          more={
            r.data.next_cursor && r.data.items.length < MAX_VIEW_RECORDS ? (
              <NativeButton label={t('work.more')} loading={paging} onPress={() => void more()} />
            ) : null
          }
        />
      ) : type === 'grid' && !grid && !grouping ? (
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: 40 }}
          data={r.data.items}
          keyExtractor={(record) => record.id}
          renderItem={({ item }) => itemRow(item)}
          refreshing={r.loading}
          onRefresh={() => void r.refresh()}
          ListFooterComponent={
            r.data.next_cursor && r.data.items.length < MAX_VIEW_RECORDS ? (
              <NativeButton label={t('work.more')} loading={paging} onPress={() => void more()} />
            ) : null
          }
        />
      ) : type === 'grid' && grid ? (
        <ScrollView horizontal contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{}}>
          <FlatList
            data={r.data.items}
            keyExtractor={(record) => record.id}
            ListHeaderComponent={
              <View style={s.gridRow}>
                {fields.map((f) => (
                  <Text key={f.id} style={s.cell}>
                    {f.name}
                  </Text>
                ))}
              </View>
            }
            renderItem={({ item }) => (
              <View style={s.gridRow}>
                {fields.map((f, i) => (
                  <Text
                    key={f.id}
                    style={s.cell}
                    accessibilityRole={i === 0 ? 'button' : undefined}
                    onPress={() => open(item)}
                  >
                    {cellText(f, item.values[f.id], r.data ?? undefined, names) || '—'}
                  </Text>
                ))}
              </View>
            )}
            ListFooterComponent={
              r.data.next_cursor && r.data.items.length < MAX_VIEW_RECORDS ? (
                <NativeButton label={t('work.more')} onPress={() => void more()} />
              ) : null
            }
          />
        </ScrollView>
      ) : (
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: 40 }}
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={({ item }) => (
            <View>
              <ListSectionHeader
                title={
                  type === 'calendar' && item.key
                    ? dayLabel(item.key)
                    : item.key
                      ? (names[item.key] ??
                        r.data?.linked[item.key]?.title ??
                        table.fields.find((f) => f.id === grouping)?.config.options?.find((o) => o.id === item.key)
                          ?.label ??
                        item.key)
                      : t(type === 'calendar' || type === 'timeline' ? 'work.unscheduled' : 'work.unassigned')
                }
              />
              {item.items.map((record) =>
                type === 'timeline' ? (
                  <ListRow
                    key={record.id}
                    title={titleOf(record, table)}
                    subtitle={[
                      record.values[config!.timeline!.start],
                      config?.timeline?.end ? record.values[config.timeline.end] : null,
                    ]
                      .filter(Boolean)
                      .join(' → ')}
                    onPress={() => open(record)}
                    accessory="chevron"
                  />
                ) : (
                  itemRow(record)
                ),
              )}
            </View>
          )}
          ListFooterComponent={
            r.data.next_cursor && r.data.items.length < MAX_VIEW_RECORDS ? (
              <NativeButton label={t('work.more')} loading={paging} onPress={() => void more()} />
            ) : null
          }
        />
      )}
    </>
  );
}
const useStyles = makeStyles((c) => ({
  gridRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderColor: c.separator },
  cell: { width: 150, minHeight: 48, padding: space.md, ...typo.body, color: c.label },
}));
