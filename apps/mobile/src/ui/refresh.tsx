/**
 * Refreshing without moving the list. A refresh the app starts itself (focus, a write, the first
 * load) never sets a RefreshControl's `refreshing`: on iOS that pulls the list down and springs it
 * back. Only a pull shows the pull spinner; any other refresh with rows on screen shows a small
 * activity indicator in the navigation bar (`refreshItem`), and a first load shows Skeleton.
 *
 *   const pull = usePullRefresh(resource.refresh);
 *   <FlatList refreshing={pull.refreshing} onRefresh={pull.onRefresh} … />
 *   <Stack.Toolbar placement="right">{refreshItem(resource.loading && !!resource.data && !pull.refreshing, t('common.loading'))}…</Stack.Toolbar>
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';

/** `refreshing` is true only while a refresh the member pulled for is running. */
export function usePullRefresh(refresh: () => unknown) {
  const [refreshing, setRefreshing] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void Promise.resolve(refresh()).finally(() => {
      if (alive.current) setRefreshing(false);
    });
  }, [refresh]);
  return { refreshing, onRefresh };
}

/**
 * The navigation bar's quiet "refreshing" mark: a toolbar item, so call it as a direct child of
 * `Stack.Toolbar` (expo-router reads items by element type, a wrapping component is ignored).
 */
export function refreshItem(busy: boolean, label: string) {
  return (
    <Stack.Toolbar.View key="refreshing" hidden={!busy} hidesSharedBackground>
      <ActivityIndicator size="small" accessibilityLabel={label} />
    </Stack.Toolbar.View>
  );
}
