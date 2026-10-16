import { cellText } from './display';
import { FlatList, ScrollView, View, useWindowDimensions } from 'react-native';
import type { BaseTable, RecordPage, TableRecord, View as TableView } from '../shared/contract';
import { useT } from '../lib/i18n';
import { calendarDateLabel } from '../lib/time-words';
import { ListRow, ListSectionHeader, ListCard } from '../ui/list';
import { parseMs } from '../data/time';
import { makeStyles, radius, space, useTheme } from '../theme';
import { groups, titleOf } from './model';
const DAY = 86400000;
export function dayLabel(value: unknown): string {
  return typeof value === 'string' ? calendarDateLabel(value) : '';
}
export function Board({
  page,
  table,
  view,
  onOpen,
  more,
  names = {},
}: {
  names?: Record<string, string>;
  page: RecordPage;
  table: BaseTable;
  view: TableView;
  onOpen: (record: TableRecord) => void;
  more?: React.ReactElement | null;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const s = useStyles(c);
  const { width } = useWindowDimensions();
  const field = table.fields.find((f) => f.id === view.config.kanban?.field);
  const rows = groups(page.items, field?.id);
  const existing = new Set(rows.map((row) => row.key));
  if (!view.config.kanban?.hide_empty)
    for (const option of field?.config.options ?? [])
      if (!existing.has(option.id)) rows.push({ key: option.id, items: [] });
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic">
      <FlatList
        horizontal
        data={rows}
        keyExtractor={(row) => row.key}
        contentContainerStyle={{ paddingVertical: space.md }}
        renderItem={({ item }) => (
          <View style={{ width: Math.min(width - 32, 320) }}>
            <ListSectionHeader
              title={
                item.key
                  ? field
                    ? cellText(field, item.key, page, names) || t('work.unassigned')
                    : t('work.unassigned')
                  : t('work.unassigned')
              }
            />
            {item.items.map((record) => (
              <ListCard key={record.id} style={s.card}>
                <ListRow
                  title={titleOf(record, table)}
                  titleLines={3}
                  subtitle={table.fields
                    .filter((f) => !f.is_primary && f.id !== field?.id)
                    .slice(0, 2)
                    .map((f) => cellText(f, record.values[f.id], page, names))
                    .filter(Boolean)
                    .join(' · ')}
                  onPress={() => onOpen(record)}
                  accessory="chevron"
                />
              </ListCard>
            ))}
          </View>
        )}
      />
      {more}
    </ScrollView>
  );
}
export function Timeline({
  page,
  table,
  view,
  onOpen,
  more,
}: {
  page: RecordPage;
  table: BaseTable;
  view: TableView;
  onOpen: (record: TableRecord) => void;
  more?: React.ReactElement | null;
}) {
  const config = view.config.timeline;
  const t = useT();
  const { colors: c } = useTheme();
  const s = useStyles(c);
  const spans = page.items.map((record) => ({
    record,
    start: config ? parseMs(String(record.values[config.start] ?? '')) : NaN,
    end: config?.end ? parseMs(String(record.values[config.end] ?? '')) : NaN,
  }));
  const timed = spans.filter((row) => Number.isFinite(row.start));
  const start = timed.length ? Math.min(...timed.map((row) => row.start)) : 0;
  const end = timed.length
    ? Math.max(...timed.map((row) => (Number.isFinite(row.end) ? Math.max(row.start, row.end) : row.start))) + DAY
    : DAY;
  const range = Math.max(DAY, end - start);
  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxxl }}
      data={spans}
      keyExtractor={(row) => row.record.id}
      ListHeaderComponent={
        timed.length ? (
          <ListRow
            title={dayLabel(new Date(start).toISOString())}
            value={dayLabel(new Date(end - DAY).toISOString())}
          />
        ) : null
      }
      renderItem={({ item }) => (
        <ListCard style={s.card}>
          <ListRow
            title={titleOf(item.record, table)}
            subtitle={
              Number.isFinite(item.start)
                ? [
                    dayLabel(new Date(item.start).toISOString()),
                    Number.isFinite(item.end) ? dayLabel(new Date(item.end).toISOString()) : '',
                  ]
                    .filter(Boolean)
                    .join(' → ')
                : t('work.unscheduled')
            }
            onPress={() => onOpen(item.record)}
            accessory="chevron"
          />
          {Number.isFinite(item.start) ? (
            <View
              accessible
              accessibilityLabel={[titleOf(item.record, table), dayLabel(new Date(item.start).toISOString())].join(
                ', ',
              )}
              style={s.track}
            >
              <View
                style={[
                  s.bar,
                  {
                    marginLeft: `${Math.min(95, Math.max(0, ((item.start - start) / range) * 100))}%`,
                    width: `${Math.max(3, Math.min(100, (((Number.isFinite(item.end) ? Math.max(item.start, item.end) : item.start) - item.start + DAY) / range) * 100))}%`,
                  },
                ]}
              />
            </View>
          ) : null}
        </ListCard>
      )}
      ListFooterComponent={more}
    />
  );
}
const useStyles = makeStyles((c) => ({
  card: { marginBottom: space.md },
  track: { height: 12, margin: space.md, backgroundColor: c.tertiaryFill, borderRadius: radius.sm, overflow: 'hidden' },
  bar: { height: 12, backgroundColor: c.accent, borderRadius: radius.sm },
}));
