/**
 * An app (spec 20261011-mobile-tables-apps §2–§3): the published version
 * trimmed to my role (`GET /api/apps/:id`, declaring the card kinds this build
 * draws), one page at a time — the page menu in the navigation bar switches
 * between the pages my role may see — with the page's filter chips and its
 * cards in reading order (src/apps/cards/registry.tsx; a kind this build does
 * not draw says "open on the web"). Cards write through the app's executor
 * (src/apps/actions.ts); every write refetches the page's cards. A link button
 * opens this app's own screens for in-app links (src/apps/links.ts). A
 * manager's view is named "Full access" here, not by the server's word.
 *
 * Params: `appId`, `page?`, `record?` + `table?` (a push / inbox row: the
 * record opens over the page, through the first card on that page — else any
 * page — that shows that table with a detail view), `name?` (the title before
 * the view loads).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { getAppRecord } from '../../src/api/apps';
import type { AppCard, AppRecordRow } from '../../src/shared/apps';
import { useT } from '../../src/lib/i18n';
import { useAuth } from '../../src/store/auth';
import { useAppActions } from '../../src/apps/actions';
import { AppCardView } from '../../src/apps/cards/registry';
import type { AppPageUi } from '../../src/apps/cards/types';
import { openAppLink } from '../../src/apps/links';
import { appIcon } from '../../src/apps/meta';
import {
  cardsInOrder,
  MANAGER_ROLE,
  pageFor,
  recordCardCandidates,
  type AppWriteMode,
} from '../../src/apps/model';
import { useApps } from '../../src/apps/store';
import { FilterBar, type FilterValues } from '../../src/tables/cards/filter-bar';
import type { FieldLike } from '../../src/tables/model/fields';
import { TablesRouteGate } from '../../src/tables/route-gate';
import { makeStyles, space, typo, useTheme, weight } from '../../src/theme';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { useHeaderInset } from '../../src/ui/header-inset';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

export default function AppScreen() {
  return (
    <TablesRouteGate area="apps">
      <AppPageScreen />
    </TablesRouteGate>
  );
}

function AppPageScreen() {
  const t = useT();
  const router = useRouter();
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const headerHeight = useHeaderInset();
  const me = useAuth((s) => s.user?.id);
  const params = useLocalSearchParams<{
    appId: string;
    page?: string;
    record?: string;
    table?: string;
    name?: string;
  }>();
  const appId = Number(params.appId);
  const view = useApps((s) => s.views[appId]);
  const failure = useApps((s) => s.viewFailed[appId]);
  const loadApp = useApps((s) => s.loadApp);
  const [pageId, setPageId] = useState<string | null>(params.page ?? null);
  const [filters, setFilters] = useState<Record<string, FilterValues>>({});
  const [refreshing, setRefreshing] = useState(false);
  const actions = useAppActions(appId);

  useEffect(() => {
    void loadApp(appId);
  }, [appId, loadApp]);

  const page = view ? pageFor(view.spec, pageId) : undefined;
  const values = useMemo(() => (page ? (filters[page.id] ?? {}) : {}), [filters, page]);

  // fields for the page filters' select options
  const fieldsById = useMemo(() => {
    const map = new Map<number, FieldLike>();
    for (const table of view?.tables ?? []) for (const field of table.fields) map.set(field.id, field as FieldLike);
    return map;
  }, [view]);

  const ui = useMemo<AppPageUi>(
    () => ({
      openRecord: (card: AppCard, record: AppRecordRow) =>
        router.push({
          pathname: '/apps/record',
          params: { appId: String(appId), pageId: page?.id ?? '', cardId: card.id, recordId: String(record.id) },
        }),
      openWrite: (card: AppCard, mode: AppWriteMode, extra?: { buttonId?: string }) =>
        router.push({
          pathname: '/apps/form',
          params: {
            appId: String(appId),
            pageId: page?.id ?? '',
            cardId: card.id,
            mode,
            ...(extra?.buttonId ? { buttonId: extra.buttonId } : {}),
          },
        }),
      openPage: (next: string) => setPageId(next),
      openUrl: (url: string) => openAppLink(router, url, { appId, openPage: setPageId }, hex.accent),
      actions,
    }),
    [router, appId, page?.id, hex.accent, actions],
  );

  // a push / inbox row named a record: open it through the best card that shows it
  const opened = useRef(false);
  useEffect(() => {
    if (!view || opened.current || !params.record) return;
    opened.current = true;
    const recordId = Number(params.record);
    if (!Number.isInteger(recordId) || recordId <= 0) return;
    void (async () => {
      for (const target of recordCardCandidates(view.spec, params.page, Number(params.table) || null)) {
        const result = await getAppRecord(appId, { pageId: target.pageId, cardId: target.cardId, recordId });
        if (!result.ok) continue;
        setPageId(target.pageId);
        router.push({
          pathname: '/apps/record',
          params: { appId: String(appId), pageId: target.pageId, cardId: target.cardId, recordId: String(recordId) },
        });
        return;
      }
      alertError(t('tables.recordMissing'), t('tables.recordMissingHint'));
    })();
  }, [view, params.record, params.page, params.table, appId, router, t]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await loadApp(appId);
    useApps.getState().written(appId);
    setRefreshing(false);
  }, [appId, loadApp]);

  const title = view?.app.name ?? params.name ?? '';
  if (!view) {
    return (
      <>
        <Stack.Screen options={{ title }} />
        {failure ? (
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
          >
            <EmptyState
              icon="apps"
              title={t('apps.missing')}
              message={failure === 'gone' ? t('apps.missingHint') : undefined}
              onRetry={() => void loadApp(appId)}
            />
          </ScrollView>
        ) : (
          <LoadingState style={{ paddingTop: headerHeight }} />
        )}
      </>
    );
  }

  const pages = view.spec.pages;
  const roleLine =
    view.draft || view.version === 0
      ? t('apps.previewDraft')
      : t('apps.roleLine', {
          role: view.role.key === MANAGER_ROLE ? t('apps.managerRole') : view.role.name,
          version: t('apps.version', { n: view.version }),
        });
  const issues = view.issues.filter((issue) => !page || issue.pageId === page.id);

  return (
    <>
      <Stack.Screen options={{ title }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon={toolbarIcon(page ? appIcon(page.icon) : 'apps')}
          hidden={pages.length < 2}
          title={t('apps.pages')}
          accessibilityLabel={t('apps.switchPage')}
        >
          {pages.map((entry) => (
            <Stack.Toolbar.MenuAction
              key={entry.id}
              icon={toolbarIcon(appIcon(entry.icon))}
              isOn={entry.id === page?.id}
              onPress={() => setPageId(entry.id)}
            >
              {entry.title}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={hex.accent} />
        }
      >
        <View style={styles.head}>
          {page ? (
            <Text style={styles.pageTitle} accessibilityRole="header">
              {page.title}
            </Text>
          ) : null}
          <Text style={styles.role}>{roleLine}</Text>
        </View>
        {issues.length && view.app.canManage ? (
          <Text style={styles.issues}>
            {t('apps.issues', { list: issues.map((issue) => issue.message).join('; ') })}
          </Text>
        ) : null}
        {!page ? (
          <EmptyState icon="apps" title={t('apps.noPages')} message={t('apps.noPagesHint')} />
        ) : (
          <>
            <FilterBar
              controls={page.filters ?? []}
              values={values}
              onChange={(id, value) =>
                setFilters((prev) => ({ ...prev, [page.id]: { ...(prev[page.id] ?? {}), [id]: value } }))
              }
              fieldsById={fieldsById}
              me={me}
            />
            {cardsInOrder(page).map((card) => (
              <AppCardView
                key={`${page.id}:${card.id}`}
                appId={appId}
                view={view}
                page={page}
                card={card}
                filterValues={values}
                ui={ui}
              />
            ))}
          </>
        )}
        <View style={{ height: space.xxl }} />
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  head: { paddingHorizontal: space.margin + space.xs, paddingTop: space.sm, paddingBottom: space.sm, gap: 2 },
  pageTitle: { ...typo.title2, fontWeight: weight.bold, color: c.label },
  role: { ...typo.subheadline, color: c.secondaryLabel },
  issues: { ...typo.footnote, color: c.orange, paddingHorizontal: space.margin + space.xs, paddingBottom: space.sm },
}));
