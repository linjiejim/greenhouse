/**
 * The drawer's Apps section (spec 20261011-mobile-tables-apps §3 "「应用」作为
 * 抽屉列表里的分区（置顶 + 推荐）"): my pinned apps (server-stored, in my order),
 * then featured apps I have not pinned (at most five), each a row with its icon
 * tile; the header opens the app center. Long-press a row to pin / unpin.
 * Refreshes whenever the drawer opens; renders nothing when Apps are off here
 * (Android, the switch off) or there is nothing to show.
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useDrawerStatus } from 'expo-router/drawer';
import type { AppSummary } from '../shared/apps';
import { useT } from '../lib/i18n';
import { useAppsEnabled } from '../tables/availability';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Icon } from '../ui/core';
import { alertError } from '../ui/dialogs';
import { DRAWER_W } from '../ui/drawer';
import { IconTile } from '../ui/list';
import { NativeMenu } from '../ui/menu';
import { appAccent, appIcon } from './meta';
import { useApps } from './store';

const ROW_INSET = space.sm;
const ROW_W = DRAWER_W - ROW_INSET * 2;
const AFTER_CLOSE_MS = 160;
const MAX_FEATURED = 5;

export function AppsSection({ query, onClose }: { query: string; onClose(): void }) {
  return useAppsEnabled() ? <Section query={query} onClose={onClose} /> : null;
}

function Section({ query, onClose }: { query: string; onClose(): void }) {
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const pins = useApps((s) => s.pins);
  const catalog = useApps((s) => s.catalog);
  const loadPins = useApps((s) => s.loadPins);
  const loadCatalog = useApps((s) => s.loadCatalog);
  const setPinned = useApps((s) => s.setPinned);

  const status = useDrawerStatus();
  useEffect(() => {
    if (status !== 'open') return;
    void loadPins();
    void loadCatalog();
  }, [status, loadPins, loadCatalog]);

  const rows = useMemo(() => {
    const pinned = pins ?? [];
    const ids = new Set(pinned.map((app) => app.id));
    const featured = (catalog?.featured ?? []).filter((app) => !ids.has(app.id)).slice(0, MAX_FEATURED);
    const q = query.trim().toLocaleLowerCase();
    const all = [...pinned.map((app) => ({ app, pinned: true })), ...featured.map((app) => ({ app, pinned: false }))];
    return q ? all.filter(({ app }) => app.name.toLocaleLowerCase().includes(q)) : all;
  }, [pins, catalog, query]);

  const later = useCallback(
    (go: () => void) => {
      onClose();
      setTimeout(go, AFTER_CLOSE_MS);
    },
    [onClose],
  );

  const toggle = useCallback(
    async (app: AppSummary, pin: boolean) => {
      if (!(await setPinned(app, pin))) alertError(t('apps.pinFailed'));
    },
    [setPinned, t],
  );

  if (!rows.length && !query.trim()) {
    // nothing pinned or featured: one quiet row into the center
    return (
      <View style={styles.block}>
        <Pressable
          onPress={() => later(() => router.push('/apps'))}
          accessibilityRole="button"
          style={({ pressed }) => [styles.head, pressed && { opacity: 0.5 }]}
        >
          <Text style={styles.headText}>{t('apps.drawerSection')}</Text>
          <Text style={styles.headAll}>{t('apps.drawerAll')}</Text>
          <Icon name="chevR" size={11} weight="semibold" color={c.tertiaryLabel} />
        </Pressable>
      </View>
    );
  }
  if (!rows.length) return null;

  return (
    <View style={styles.block}>
      <Pressable
        onPress={() => later(() => router.push('/apps'))}
        accessibilityRole="button"
        accessibilityLabel={`${t('apps.drawerSection')}, ${t('apps.drawerAll')}`}
        style={({ pressed }) => [styles.head, pressed && { opacity: 0.5 }]}
      >
        <Text style={styles.headText}>{t('apps.drawerSection')}</Text>
        <Text style={styles.headAll}>{t('apps.drawerAll')}</Text>
        <Icon name="chevR" size={11} weight="semibold" color={c.tertiaryLabel} />
      </Pressable>
      {rows.map(({ app, pinned }) => (
        <NativeMenu
          key={app.id}
          trigger="longPress"
          width={ROW_W}
          style={styles.rowSlot}
          items={[
            pinned
              ? { id: 'unpin', title: t('apps.unpin'), icon: 'pinOff' }
              : { id: 'pin', title: t('apps.pin'), icon: 'pin' },
          ]}
          onSelect={(id) => void toggle(app, id === 'pin')}
        >
          <Pressable
            onPress={() =>
              later(() => router.push({ pathname: '/apps/[appId]', params: { appId: String(app.id), name: app.name } }))
            }
            accessibilityRole="button"
            accessibilityLabel={app.name}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.fill }]}
          >
            <IconTile icon={appIcon(app.icon)} tint={appAccent(app.accent, c)} size={26} />
            <Text numberOfLines={1} style={styles.rowText}>
              {app.name}
            </Text>
            {pinned ? <Icon name="pin" size={11} color={c.tertiaryLabel} /> : null}
          </Pressable>
        </NativeMenu>
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  block: { paddingBottom: space.sm },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg + 2,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  headText: { ...typo.footnote, fontWeight: weight.semibold, color: c.secondaryLabel, flex: 1 },
  headAll: { ...typo.footnote, color: c.tertiaryLabel },
  rowSlot: { marginHorizontal: ROW_INSET },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    minHeight: 40,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    ...squircle,
  },
  rowText: { flex: 1, ...typo.body, color: c.label },
}));
