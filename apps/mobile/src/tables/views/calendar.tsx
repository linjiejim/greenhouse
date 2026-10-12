/**
 * The calendar view, v1 (spec D1: no native month grid with events — the
 * system's graphical date picker + an agenda, pure JS, OTA-able): pick a day in
 * the picker, see that day's records under it (a record spans every day from
 * its start field to its end field). The visible month is loaded at once — the
 * records overlapping it (web `calendarWindowFilters`, ≤ 500) — and moving to a
 * day in another month loads that month. `+` creates a record on the chosen day.
 */

import React, { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { DatePicker, Host } from '@expo/ui/swift-ui';
import { datePickerStyle } from '@expo/ui/swift-ui/modifiers';
import type { TableQuery, TableViewConfig } from '../../shared/tables';
import { useLocale, useT } from '../../lib/i18n';
import { dateSubtitle, dateToStamp, stampToDate, todayStamp } from '../../projects/meta';
import { makeStyles, space, typo, useTheme, weight } from '../../theme';
import { NativeButton } from '../../ui/button';
import { EmptyState, LoadingState } from '../../ui/empty';
import { ListRow, ListSection } from '../../ui/list';
import { useLocaleEnv } from '../../ui/native-form';
import { recordSummary } from '../field-value';
import { recordTitle } from '../model/fields';
import { busyDays, calendarWindowFilters, monthBounds, onDay, VIEW_RECORD_LIMIT } from '../model/views';
import { useRecords } from '../use-records';
import type { ViewContext } from './types';

export function CalendarView({
  ctx,
  config,
  baseQuery,
  header,
}: {
  ctx: ViewContext;
  config: NonNullable<TableViewConfig['calendar']> | undefined;
  /** The view's query with the phone's overrides (the month window is ANDed on). */
  baseQuery: Omit<TableQuery, 'cursor' | 'limit'>;
  header?: React.ReactElement | null;
}) {
  const t = useT();
  const locale = useLocale();
  const localeEnv = useLocaleEnv();
  const { colors: c, hex, isDark } = useTheme();
  const styles = useStyles(c);
  const [day, setDay] = useState(todayStamp());
  const start = config ? ctx.fields.find((field) => field.id === config.startFieldId) : undefined;
  const end = config?.endFieldId ? ctx.fields.find((field) => field.id === config.endFieldId) : undefined;
  const { first, last } = monthBounds(day);

  const query = useMemo(() => {
    if (!start) return null;
    const window = calendarWindowFilters(start, end, first, last);
    return { ...baseQuery, filters: [...(baseQuery.filters ?? []), ...window].slice(0, 5) };
  }, [start, end, first, last, baseQuery]);
  const data = useRecords(ctx.tableId, query, { pageSize: VIEW_RECORD_LIMIT });

  const records = data.records;
  const today = useMemo(
    () => (records && start ? records.filter((record) => onDay(record, start, end, day)) : []),
    [records, start, end, day],
  );
  const busy = useMemo(
    () => (records && start ? busyDays(records, start, end, first, last).size : 0),
    [records, start, end, first, last],
  );
  const rest = useMemo(() => ctx.shown.filter((field) => field.id !== ctx.primary?.id), [ctx.shown, ctx.primary]);
  const canCreateHere = !!start && ctx.abilities.canCreate && ctx.abilities.editable.has(start.id);

  if (!start) {
    return <EmptyState icon="calendar" title={t('tables.noCalendarField')} message={t('tables.openOnWebHint')} />;
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl + ctx.bottomInset }}
      refreshControl={
        <RefreshControl refreshing={data.refreshing} onRefresh={() => void data.refresh()} tintColor={hex.accent} />
      }
    >
      {header}
      <Host
        matchContents={{ vertical: true }}
        colorScheme={isDark ? 'dark' : 'light'}
        modifiers={[localeEnv]}
        style={styles.picker}
      >
        <DatePicker
          selection={stampToDate(day)}
          displayedComponents={['date']}
          onDateChange={(date) => setDay(dateToStamp(date))}
          modifiers={[datePickerStyle('graphical')]}
        />
      </Host>
      {busy ? <Text style={styles.busy}>{t('tables.busyDays', { n: busy })}</Text> : null}
      <View style={styles.agendaHead}>
        <Text style={styles.agendaTitle} accessibilityRole="header">
          {dateSubtitle(day, locale, t('tables.today'))}
        </Text>
        {canCreateHere ? (
          <NativeButton
            label={t('tables.newRecord')}
            icon="plus"
            size="small"
            onPress={() =>
              ctx.create({
                [String(start.id)]: start.type === 'date' ? day : stampToDate(day).toISOString(),
              })
            }
          />
        ) : null}
      </View>
      {records === null ? (
        <LoadingState style={{ flexGrow: 0, paddingVertical: space.xl }} />
      ) : data.failed && !records.length ? (
        <EmptyState icon="alert" title={t('tables.recordsFailed')} onRetry={() => void data.reload()} />
      ) : today.length === 0 ? (
        <Text style={styles.none}>{t('tables.agendaEmpty')}</Text>
      ) : (
        <ListSection>
          {today.map((record) => (
            <ListRow
              key={record.id}
              title={recordTitle(record, ctx.fields, ctx.labels)}
              subtitle={recordSummary(record, rest, ctx.labels) || undefined}
              subtitleLines={1}
              accessory="chevron"
              onPress={() => ctx.open(record)}
            />
          ))}
        </ListSection>
      )}
      {data.total > VIEW_RECORD_LIMIT ? (
        <Text style={styles.cap}>{t('tables.kanbanCap', { n: VIEW_RECORD_LIMIT })}</Text>
      ) : null}
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  picker: { marginHorizontal: space.margin },
  agendaHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.margin + space.xs,
    paddingTop: space.md,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  agendaTitle: { ...typo.title3, fontWeight: weight.semibold, color: c.label, flexShrink: 1 },
  none: {
    ...typo.subheadline,
    color: c.tertiaryLabel,
    paddingHorizontal: space.margin + space.xs,
    paddingVertical: space.md,
  },
  cap: { ...typo.footnote, color: c.secondaryLabel, paddingHorizontal: space.margin + space.xs },
  busy: { ...typo.footnote, color: c.secondaryLabel, paddingHorizontal: space.margin + space.xs, paddingTop: space.xs },
}));
