/**
 * The list view (a grid view on the web): one row per record — its title (the
 * primary field) over the first two other visible fields — paged as you
 * scroll, grouped under section headers by a select / person field when the
 * view (or the view-options sheet) groups it. Pull to refresh; a tap opens the
 * record page.
 */

import React, { useMemo } from 'react';
import { FlatList, RefreshControl, SectionList, View } from 'react-native';
import type { TableRecord } from '../../api/tables';
import { useT } from '../../lib/i18n';
import { space, useTheme } from '../../theme';
import { EmptyState, LoadingState } from '../../ui/empty';
import { ListRow, ListSectionHeader, type RowPosition } from '../../ui/list';
import { NativeButton } from '../../ui/button';
import { recordSummary } from '../field-value';
import { recordTitle } from '../model/fields';
import { groupRecords } from '../model/views';
import type { RecordsData, ViewContext } from './types';

function position(index: number, count: number): RowPosition {
  if (count === 1) return 'only';
  if (index === 0) return 'first';
  return index === count - 1 ? 'last' : 'middle';
}

export function ListView({
  ctx,
  data,
  groupFieldId,
  searching,
  header,
}: {
  ctx: ViewContext;
  data: RecordsData;
  groupFieldId: number | null;
  searching: boolean;
  header?: React.ReactElement | null;
}) {
  const t = useT();
  const { hex } = useTheme();
  const groupField = groupFieldId ? ctx.fields.find((field) => field.id === groupFieldId) : undefined;
  const rest = useMemo(() => ctx.shown.filter((field) => field.id !== ctx.primary?.id), [ctx.shown, ctx.primary]);
  const records = data.records;

  const sections = useMemo(() => {
    if (!groupField || !records) return null;
    return groupRecords(groupField, records, {
      userLabel: (id) => ctx.labels.user(id) ?? id,
      noValue: t('tables.noValue'),
      keepEmpty: false,
    }).map((lane) => ({ key: lane.key, title: `${lane.label} · ${lane.records.length}`, data: lane.records }));
  }, [groupField, records, ctx.labels, t]);

  const row = (record: TableRecord, index: number, count: number) => (
    <ListRow
      title={recordTitle(record, ctx.fields, ctx.labels)}
      subtitle={recordSummary(record, rest, ctx.labels) || undefined}
      subtitleLines={1}
      accessory="chevron"
      position={position(index, count)}
      onPress={() => ctx.open(record)}
    />
  );

  const empty =
    records === null ? (
      <LoadingState style={{ paddingTop: space.xxl }} />
    ) : data.failed ? (
      <EmptyState icon="alert" title={t('tables.recordsFailed')} onRetry={() => void data.reload()} />
    ) : searching ? (
      <EmptyState icon="search" title={t('tables.noMatches')} />
    ) : (
      <EmptyState
        icon="table"
        title={t('tables.noRecords')}
        message={t('tables.noRecordsHint')}
        action={
          ctx.abilities.canCreate ? (
            <NativeButton label={t('tables.newRecord')} icon="plus" onPress={() => ctx.create()} />
          ) : undefined
        }
      />
    );

  const footer = (
    <View style={{ height: space.xxl + ctx.bottomInset }}>
      {data.hasMore && data.loadingMore ? <LoadingState style={{ flexGrow: 0, paddingTop: space.md }} /> : null}
    </View>
  );
  const refresh = (
    <RefreshControl refreshing={data.refreshing} onRefresh={() => void data.refresh()} tintColor={hex.accent} />
  );

  if (sections) {
    return (
      <SectionList
        sections={sections}
        keyExtractor={(record) => String(record.id)}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        stickySectionHeadersEnabled={false}
        refreshControl={refresh}
        onEndReached={() => void data.loadMore()}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={header}
        renderSectionHeader={({ section }) => <ListSectionHeader title={section.title} />}
        renderItem={({ item, index, section }) => row(item, index, section.data.length)}
        renderSectionFooter={() => <View style={{ height: space.lg }} />}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
      />
    );
  }
  return (
    <FlatList
      data={records ?? []}
      keyExtractor={(record) => String(record.id)}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      refreshControl={refresh}
      onEndReached={() => void data.loadMore()}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={header}
      renderItem={({ item, index }) => row(item, index, records?.length ?? 0)}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
    />
  );
}
