/** One base (`/tables/base?id=`): its tables. A base I cannot open answers 404 (or 403 without the feature). */

import React, { useCallback } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { getBase } from '../../src/api/tables';
import { noAccess, notFound } from '../../src/data/access';
import { useResource } from '../../src/data/use-resource';
import { useT } from '../../src/lib/i18n';
import type { TableDef } from '../../src/shared/greenhouse-types';
import { makeStyles, space, useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, ListSectionFooter, type RowPosition } from '../../src/ui/list';

const position = (index: number, count: number): RowPosition =>
  count === 1 ? 'only' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'middle';

export default function Base() {
  const { id: raw } = useLocalSearchParams<{ id?: string }>();
  const id = raw && /^[0-9]+$/.test(raw) ? Number(raw) : null;
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const load = useCallback(() => getBase(id ?? 0), [id]);
  const resource = useResource(load);
  const tables = (resource.data?.tables ?? []).filter((table) => !table.archived_at).sort((a, b) => a.position - b.position);

  if (id == null || (!resource.data && !resource.loading && (notFound(resource.error) || noAccess(resource.error)))) {
    return (
      <View style={styles.root}>
        <Stack.Screen options={{ title: t('nav.tables') }} />
        <ScrollView contentInsetAdjustmentBehavior="automatic">
          <EmptyState
            icon="table"
            title={noAccess(resource.error) ? t('tables.noAccess') : t('tables.notFound')}
            style={styles.state}
          />
        </ScrollView>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: resource.data?.base.name ?? '' }} />
      <FlatList<TableDef>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        data={tables}
        keyExtractor={(table) => String(table.id)}
        refreshing={resource.loading && !!resource.data}
        onRefresh={() => void resource.refresh()}
        renderItem={({ item, index }) => (
          <ListRow
            title={item.name}
            subtitle={item.description || undefined}
            icon="table"
            accessory="chevron"
            position={position(index, tables.length)}
            onPress={() => router.push({ pathname: '/tables/table', params: { base: String(id), id: String(item.id) } })}
          />
        )}
        ListFooterComponent={
          resource.data?.role ? <ListSectionFooter text={t('tables.yourRole', { role: t(`tables.role.${resource.data.role}`) })} /> : null
        }
        ListEmptyComponent={
          !resource.data ? (
            resource.loading ? (
              <LoadingState style={styles.state} />
            ) : (
              <EmptyState icon="alert" title={t('tables.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
            )
          ) : (
            <EmptyState icon="table" title={t('tables.tablesEmpty')} style={styles.state} />
          )
        }
        contentContainerStyle={styles.content}
      />
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingTop: space.md, paddingBottom: space.xxxl },
  state: { paddingTop: space.xxxl },
}));
