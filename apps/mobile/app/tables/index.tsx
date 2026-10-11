/**
 * Tables — the hub page (spec 20261011-mobile-tables-apps §2): every Base I can
 * open (mine, shared with me in person, through a group, or team-wide), with a
 * collapsing large title and the native search bar (filters the loaded list by
 * name and description). A row shows the Base and my role; a tap opens it.
 * Refetches on focus and on pull; a failed first load is a retry state, never a
 * fake "no Bases". Bases are created on the web.
 *
 * Gate: iOS + an internal account + `features.tables` (src/tables/route-gate.tsx).
 * The bell opens the notification list (app/inbox.tsx).
 */

import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useT } from '../../src/lib/i18n';
import { TablesRouteGate } from '../../src/tables/route-gate';
import { useTables } from '../../src/tables/store';
import { space, useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, type RowPosition } from '../../src/ui/list';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

export default function TablesScreen() {
  return (
    <TablesRouteGate area="tables">
      <TablesHome />
    </TablesRouteGate>
  );
}

function position(index: number, count: number): RowPosition {
  if (count === 1) return 'only';
  if (index === 0) return 'first';
  return index === count - 1 ? 'last' : 'middle';
}

function TablesHome() {
  const t = useT();
  const router = useRouter();
  const { hex } = useTheme();
  const bases = useTables((s) => s.bases);
  const failed = useTables((s) => s.basesFailed);
  const load = useTables((s) => s.loadBases);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!bases || !q) return bases ?? [];
    return bases.filter(
      (base) => base.name.toLocaleLowerCase().includes(q) || (base.description ?? '').toLocaleLowerCase().includes(q),
    );
  }, [bases, query]);

  return (
    <>
      <Stack.Screen options={{ title: t('tables.title') }} />
      <Stack.SearchBar
        placeholder={t('tables.searchBases')}
        onChangeText={(e) => setQuery(e.nativeEvent.text)}
        onCancelButtonPress={() => setQuery('')}
        tintColor={hex.accent}
        autoCapitalize="none"
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('bell')}
          accessibilityLabel={t('inbox.title')}
          onPress={() => router.push('/inbox')}
        />
      </Stack.Toolbar>
      <FlatList
        data={shown}
        keyExtractor={(base) => String(base.id)}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingTop: space.sm, flexGrow: 1 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load({ fresh: true });
              setRefreshing(false);
            }}
            tintColor={hex.accent}
          />
        }
        renderItem={({ item, index }) => (
          <ListRow
            title={item.name}
            subtitle={item.description || (item.visibility === 'team' ? t('tables.team') : undefined)}
            subtitleLines={1}
            icon="table"
            value={t(`tables.role.${item.role}`)}
            accessory="chevron"
            position={position(index, shown.length)}
            onPress={() =>
              router.push({ pathname: '/tables/[baseId]', params: { baseId: String(item.id), name: item.name } })
            }
          />
        )}
        ListEmptyComponent={
          bases === null && !failed ? (
            <LoadingState />
          ) : failed && !bases?.length ? (
            <EmptyState icon="alert" title={t('tables.loadFailed')} onRetry={() => void load({ fresh: true })} />
          ) : query.trim() ? (
            <EmptyState icon="search" title={t('tables.noResults')} />
          ) : (
            <EmptyState icon="table" title={t('tables.noBases')} message={t('tables.noBasesHint')} />
          )
        }
        ListFooterComponent={<View style={{ height: space.xxl }} />}
      />
    </>
  );
}
