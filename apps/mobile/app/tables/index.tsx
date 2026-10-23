/**
 * Tables (表格): the bases I can open. Members without the `tables` feature get a 403 (the drawer
 * hides Tables for them, but a link can still lead here) — say so instead of offering a retry.
 */

import React, { useCallback } from 'react';
import { FlatList, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { listBases } from '../../src/api/tables';
import { noAccess } from '../../src/data/access';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import type { TableBase } from '../../src/shared/greenhouse-types';
import { makeStyles, space, useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, type RowPosition } from '../../src/ui/list';

const position = (index: number, count: number): RowPosition =>
  count === 1 ? 'only' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'middle';

export default function Tables() {
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const load = useCallback(async () => {
    const result = await listBases();
    return result.ok ? { ok: true as const, data: result.data.bases.filter((base) => !base.archived_at) } : result;
  }, []);
  const resource = useResource(load);
  const bases = resource.data ?? [];

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: t('nav.tables') }} />
      <FlatList<TableBase>
        contentInsetAdjustmentBehavior="automatic"
        data={bases}
        keyExtractor={(base) => String(base.id)}
        refreshing={resource.loading && !!resource.data}
        onRefresh={() => void resource.refresh()}
        renderItem={({ item, index }) => (
          <ListRow
            title={item.name}
            subtitle={item.description || undefined}
            icon="table"
            value={item.role ? t(`tables.role.${item.role}`) : undefined}
            accessory="chevron"
            position={position(index, bases.length)}
            onPress={() => router.push({ pathname: '/tables/base', params: { id: String(item.id) } })}
          />
        )}
        ListEmptyComponent={
          !resource.data ? (
            resource.loading ? (
              <LoadingState style={styles.state} />
            ) : noAccess(resource.error) ? (
              <EmptyState icon="hand" title={t('tables.noAccess')} message={t('tables.noAccessHint')} style={styles.state} />
            ) : (
              <EmptyState icon="alert" title={t('tables.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
            )
          ) : (
            <EmptyState icon="table" title={t('tables.empty')} message={t('tables.emptyHint')} style={styles.state} />
          )
        }
        contentContainerStyle={styles.content}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
  state: { paddingTop: space.xxxl },
}));
