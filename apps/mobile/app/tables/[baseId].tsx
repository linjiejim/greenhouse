/**
 * A Base (spec 20261011-mobile-tables-apps §2): its tables (a tap opens the
 * table on its first view), dashboards (read on the phone with the same card
 * renderers as app pages) and the apps built on it that I can open. My role is
 * in the header line. Refetches on focus; a 403 / 404 (deleted, unshared) is a
 * "not available" state.
 *
 * Params: `baseId`, `name` (the title before the workspace loads).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useT } from '../../src/lib/i18n';
import { appAccent, appIcon } from '../../src/apps/meta';
import { catalogApps, useApps } from '../../src/apps/store';
import { useAppsEnabled } from '../../src/tables/availability';
import { roleOf } from '../../src/tables/model/access';
import { TablesRouteGate } from '../../src/tables/route-gate';
import { useWorkspace } from '../../src/tables/store';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { useHeaderInset } from '../../src/ui/header-inset';
import { ListRow, ListSection } from '../../src/ui/list';

export default function BaseScreen() {
  return (
    <TablesRouteGate area="tables">
      <BasePage />
    </TablesRouteGate>
  );
}

function BasePage() {
  const t = useT();
  const router = useRouter();
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const headerHeight = useHeaderInset();
  const params = useLocalSearchParams<{ baseId: string; name?: string }>();
  const baseId = Number(params.baseId);
  const { workspace, failed, reload } = useWorkspace(baseId, { refetchOnFocus: true });
  const appsOn = useAppsEnabled();
  const catalog = useApps((s) => s.catalog);
  const loadCatalog = useApps((s) => s.loadCatalog);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (appsOn) void loadCatalog();
  }, [appsOn, loadCatalog]);

  const apps = useMemo(
    () => catalogApps(catalog).filter((app) => app.baseId === baseId && app.status !== 'archived'),
    [catalog, baseId],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([reload({ fresh: true }), appsOn ? loadCatalog() : Promise.resolve()]);
    setRefreshing(false);
  }, [reload, appsOn, loadCatalog]);

  const title = workspace?.base.name ?? params.name ?? '';
  if (!workspace) {
    return (
      <>
        <Stack.Screen options={{ title }} />
        {failed ? (
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
          >
            <EmptyState
              icon="alert"
              title={t('tables.baseMissing')}
              message={t('tables.baseMissingHint')}
              onRetry={() => void reload({ fresh: true })}
            />
          </ScrollView>
        ) : (
          <LoadingState style={{ paddingTop: headerHeight }} />
        )}
      </>
    );
  }

  const role = roleOf(workspace);
  return (
    <>
      <Stack.Screen options={{ title }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={hex.accent} />
        }
      >
        <View style={styles.head}>
          <Text style={styles.role}>
            {role === 'custom' && workspace.access.customRole
              ? workspace.access.customRole.name
              : t(`tables.role.${role}`)}
          </Text>
          {workspace.base.description ? <Text style={styles.description}>{workspace.base.description}</Text> : null}
        </View>

        <ListSection header={t('tables.sectionTables')}>
          {workspace.tables.length ? (
            workspace.tables.map((table) => (
              <ListRow
                key={table.id}
                title={table.name}
                subtitle={table.description ?? undefined}
                subtitleLines={1}
                icon="table"
                accessory="chevron"
                onPress={() =>
                  router.push({
                    pathname: '/tables/table/[tableId]',
                    params: { tableId: String(table.id), baseId: String(baseId), name: table.name },
                  })
                }
              />
            ))
          ) : (
            <ListRow title={t('tables.noTables')} />
          )}
        </ListSection>

        {workspace.dashboards.length ? (
          <ListSection header={t('tables.sectionDashboards')}>
            {workspace.dashboards.map((dashboard) => (
              <ListRow
                key={dashboard.id}
                title={dashboard.name}
                subtitle={dashboard.description ?? undefined}
                subtitleLines={1}
                icon="bar"
                iconTint={c.indigo}
                accessory="chevron"
                onPress={() =>
                  router.push({
                    pathname: '/tables/dashboard/[dashboardId]',
                    params: { dashboardId: String(dashboard.id), name: dashboard.name },
                  })
                }
              />
            ))}
          </ListSection>
        ) : null}

        {appsOn && apps.length ? (
          <ListSection header={t('tables.sectionApps')}>
            {apps.map((app) => (
              <ListRow
                key={app.id}
                title={app.name}
                subtitle={app.status === 'draft' ? t('apps.draft') : (app.description ?? undefined)}
                subtitleLines={1}
                icon={appIcon(app.icon)}
                iconTint={appAccent(app.accent, c)}
                accessory="chevron"
                onPress={() =>
                  router.push({ pathname: '/apps/[appId]', params: { appId: String(app.id), name: app.name } })
                }
              />
            ))}
          </ListSection>
        ) : null}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  head: { paddingHorizontal: space.margin + space.xs, paddingTop: space.sm, paddingBottom: space.lg, gap: space.xs },
  role: { ...typo.subheadline, color: c.secondaryLabel },
  description: { ...typo.body, color: c.label },
}));
