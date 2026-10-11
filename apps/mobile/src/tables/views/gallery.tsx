/**
 * The gallery view: two cards a row, each the first image of the view's cover
 * attachment field (loaded with the station token — ../auth-image.tsx), the
 * record's title and two more fields. Paged as you scroll; a tap opens it.
 */

import React, { useMemo } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View, useWindowDimensions } from 'react-native';
import type { TableRecord } from '../../api/tables';
import { tablesFilePath } from '../../api/tables';
import type { TableViewConfig } from '../../shared/tables';
import { useT } from '../../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../theme';
import { EmptyState, LoadingState } from '../../ui/empty';
import { AuthImage } from '../auth-image';
import { RecordLines } from '../field-value';
import { attachmentIds, recordTitle, recordValue } from '../model/fields';
import type { RecordsData, ViewContext } from './types';

const GAP = space.md;

export function GalleryView({
  ctx,
  data,
  config,
  searching,
}: {
  ctx: ViewContext;
  data: RecordsData;
  config: NonNullable<TableViewConfig['gallery']> | undefined;
  searching: boolean;
}) {
  const t = useT();
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const { width } = useWindowDimensions();
  const cardW = Math.floor((width - space.margin * 2 - GAP) / 2);
  const cover = config?.coverFieldId ? ctx.fields.find((field) => field.id === config.coverFieldId) : undefined;
  const rest = useMemo(() => ctx.shown.filter((field) => field.id !== ctx.primary?.id), [ctx.shown, ctx.primary]);

  const render = ({ item }: { item: TableRecord }) => {
    const fileId = cover ? attachmentIds(recordValue(item, cover.id))[0] : undefined;
    const title = recordTitle(item, ctx.fields, ctx.labels);
    return (
      <Pressable
        onPress={() => ctx.open(item)}
        accessibilityRole="button"
        accessibilityLabel={title}
        style={({ pressed }) => [styles.card, { width: cardW }, pressed && { opacity: 0.7 }]}
      >
        <AuthImage
          path={fileId ? tablesFilePath(fileId) : null}
          fit={config?.fit === 'contain' ? 'contain' : 'cover'}
          style={[styles.cover, { height: Math.round(cardW * 0.75) }]}
        />
        <View style={styles.body}>
          <Text numberOfLines={2} style={styles.title}>
            {title}
          </Text>
          <RecordLines record={item} fields={rest} labels={ctx.labels} max={2} />
        </View>
      </Pressable>
    );
  };

  return (
    <FlatList
      data={data.records ?? []}
      keyExtractor={(record) => String(record.id)}
      numColumns={2}
      columnWrapperStyle={{ gap: GAP, paddingHorizontal: space.margin }}
      contentContainerStyle={{ gap: GAP, paddingTop: space.sm }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      refreshControl={
        <RefreshControl refreshing={data.refreshing} onRefresh={() => void data.refresh()} tintColor={hex.accent} />
      }
      onEndReached={() => void data.loadMore()}
      onEndReachedThreshold={0.5}
      renderItem={render}
      ListEmptyComponent={
        data.records === null ? (
          <LoadingState style={{ paddingTop: space.xxl }} />
        ) : data.failed ? (
          <EmptyState icon="alert" title={t('tables.recordsFailed')} onRetry={() => void data.reload()} />
        ) : (
          <EmptyState
            icon={searching ? 'search' : 'photos'}
            title={searching ? t('tables.noMatches') : t('tables.noRecords')}
          />
        )
      }
      ListFooterComponent={<View style={{ height: space.xxl + ctx.bottomInset }} />}
    />
  );
}

const useStyles = makeStyles((c) => ({
  card: {
    backgroundColor: c.secondaryGroupedBackground,
    borderRadius: radius.lg,
    ...squircle,
    overflow: 'hidden',
  },
  cover: { width: '100%' },
  body: { padding: space.sm + 2, gap: space.xs },
  title: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
}));
