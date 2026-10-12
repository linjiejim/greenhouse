/**
 * The app center (spec 20261011-mobile-tables-apps §2–§3; web parity:
 * `#/apps`): my pinned apps first, then the apps I manage, the ones shared with
 * me and the featured ones (`GET /api/apps`). A row is the app's icon tile, its
 * name and description (a draft I manage says so); a tap opens it; long-press
 * pins / unpins it (server-stored — the drawer's Apps section shows the pins).
 * Building, publishing and sharing apps stay on the web. Refetches on focus and
 * on pull; a failed first load is a retry state.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { RefreshControl, SectionList, View } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import type { AppSummary } from '../../src/shared/apps';
import { useT } from '../../src/lib/i18n';
import { appAccent, appIcon } from '../../src/apps/meta';
import { useApps } from '../../src/apps/store';
import { TablesRouteGate } from '../../src/tables/route-gate';
import { useTablesEnabled } from '../../src/tables/availability';
import { space, useTheme } from '../../src/theme';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, ListSectionHeader, type RowPosition } from '../../src/ui/list';
import { NativeMenu } from '../../src/ui/menu';
import { NativeButton } from '../../src/ui/button';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

export default function AppCenterScreen() {
  return (
    <TablesRouteGate area="apps">
      <AppCenter />
    </TablesRouteGate>
  );
}

function position(index: number, count: number): RowPosition {
  if (count === 1) return 'only';
  if (index === 0) return 'first';
  return index === count - 1 ? 'last' : 'middle';
}

function AppCenter() {
  const t = useT();
  const router = useRouter();
  const canCreate = useTablesEnabled();
  const { colors: c, hex } = useTheme();
  const catalog = useApps((s) => s.catalog);
  const failed = useApps((s) => s.catalogFailed);
  const pins = useApps((s) => s.pins);
  const loadCatalog = useApps((s) => s.loadCatalog);
  const loadPins = useApps((s) => s.loadPins);
  const setPinned = useApps((s) => s.setPinned);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    await Promise.all([loadCatalog(), loadPins()]);
  }, [loadCatalog, loadPins]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const sections = useMemo(() => {
    if (!catalog) return [];
    const pinnedIds = new Set((pins ?? []).map((app) => app.id));
    const shelves: Array<{ key: string; title: string; data: AppSummary[] }> = [
      { key: 'pinned', title: t('apps.pinned'), data: pins ?? [] },
      { key: 'mine', title: t('apps.mine'), data: catalog.managed.filter((app) => !pinnedIds.has(app.id)) },
      { key: 'shared', title: t('apps.shared'), data: catalog.shared.filter((app) => !pinnedIds.has(app.id)) },
      { key: 'featured', title: t('apps.featured'), data: catalog.featured.filter((app) => !pinnedIds.has(app.id)) },
    ];
    return shelves.filter((shelf) => shelf.data.length > 0);
  }, [catalog, pins, t]);

  const togglePin = useCallback(
    async (app: AppSummary, pin: boolean) => {
      if (!(await setPinned(app, pin))) alertError(t('apps.pinFailed'));
    },
    [setPinned, t],
  );

  const pinnedIds = useMemo(() => new Set((pins ?? []).map((app) => app.id)), [pins]);

  return (
    <>
      <Stack.Screen options={{ title: t('apps.center') }} />
      {canCreate ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon={toolbarIcon('plus')}
            accessibilityLabel={t('apps.templates.create')}
            onPress={() => router.push('/apps/templates')}
          />
        </Stack.Toolbar>
      ) : null}
      <SectionList
        sections={sections}
        keyExtractor={(app, index) => `${app.id}:${index}`}
        contentInsetAdjustmentBehavior="automatic"
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ flexGrow: 1, paddingTop: space.sm }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
            tintColor={hex.accent}
          />
        }
        renderSectionHeader={({ section }) => <ListSectionHeader title={section.title} />}
        renderSectionFooter={() => <View style={{ height: space.lg }} />}
        renderItem={({ item, index, section }) => {
          const pinned = pinnedIds.has(item.id);
          const subtitle =
            item.status === 'draft'
              ? t('apps.draft')
              : item.status === 'archived'
                ? t('apps.archived')
                : item.description;
          return (
            <NativeMenu
              trigger="longPress"
              items={[
                pinned
                  ? { id: 'unpin', title: t('apps.unpin'), icon: 'pinOff' }
                  : { id: 'pin', title: t('apps.pin'), icon: 'pin' },
              ]}
              onSelect={(id) => void togglePin(item, id === 'pin')}
            >
              <ListRow
                title={item.name}
                subtitle={subtitle || undefined}
                subtitleLines={1}
                icon={appIcon(item.icon)}
                iconTint={appAccent(item.accent, c)}
                accessory="chevron"
                position={position(index, section.data.length)}
                onPress={() =>
                  router.push({ pathname: '/apps/[appId]', params: { appId: String(item.id), name: item.name } })
                }
              />
            </NativeMenu>
          );
        }}
        ListEmptyComponent={
          catalog === null && !failed ? (
            <LoadingState />
          ) : failed && !catalog ? (
            <EmptyState icon="alert" title={t('apps.loadFailed')} onRetry={() => void load()} />
          ) : (
            <EmptyState
              icon="apps"
              title={t('apps.empty')}
              message={t('apps.emptyHint')}
              action={
                canCreate ? (
                  <NativeButton
                    label={t('apps.templates.create')}
                    icon="plus"
                    variant="prominent"
                    onPress={() => router.push('/apps/templates')}
                  />
                ) : undefined
              }
            />
          )
        }
      />
    </>
  );
}
