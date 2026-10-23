/**
 * One notification (`/notification?id=`) — opened from a Home row or a push tap. Shows what it is,
 * when, and its whole text (selectable); opening it marks it read (optimistic — the row turns
 * read at once) and clears its banner. While it is on screen its own pushes stay quiet
 * (src/shell/surface.ts). A notification not in the list yet (a push for something newer) is
 * fetched by marking it read — the server answers with it. If the read cannot reach the server,
 * the member is told and the banner stays. When it points somewhere (a document, a file, a
 * run in the Activity log), a button opens it — natively, or in the web app.
 */

import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useT, type TranslationKey } from '../src/lib/i18n';
import { plainText } from '../src/lib/plain-text';
import { relativeTimeNow } from '../src/lib/time-words';
import { readOnOpen } from '../src/data/read-on-open';
import { notificationTarget, type AppTarget } from '../src/lib/deep-links';
import { openTarget } from '../src/shell/open-target';
import { getApiBase } from '../src/store/stations';
import { NativeButton } from '../src/ui/button';
import { clearReadBanners } from '../src/push/handler';
import type { PlatformNotification } from '../src/shared/greenhouse-types';
import { useSurface } from '../src/shell/surface';
import { useNotifications } from '../src/store/notifications';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../src/theme';
import { alertError } from '../src/ui/dialogs';
import { EmptyState, LoadingState } from '../src/ui/empty';
import { IconTile } from '../src/ui/list';
import type { IconName } from '../src/ui/core';

const OPEN_LABEL: Record<AppTarget['kind'], TranslationKey> = {
  doc: 'notifications.openDoc',
  files: 'notifications.openFile',
  project: 'notifications.openProject',
  tables: 'notifications.openTables',
  chat: 'notifications.openChat',
  agent: 'notifications.openAgent',
  web: 'notifications.openWeb',
  external: 'notifications.openWeb',
};

const KIND: Record<string, { icon: IconName; label: TranslationKey }> = {
  runtime_attention: { icon: 'hand', label: 'notifications.kindNeedsYou' },
  budget_attention: { icon: 'bar', label: 'notifications.kindBudget' },
  runtime_completed: { icon: 'checkCircle', label: 'notifications.kindDone' },
  runtime_failed: { icon: 'alert', label: 'notifications.kindFailed' },
};

export default function NotificationPage() {
  const { colors: c, hex } = useTheme();
  const router = useRouter();
  const styles = useStyles(c);
  const t = useT();
  const { id: raw } = useLocalSearchParams<{ id?: string }>();
  const id = typeof raw === 'string' ? raw : '';
  const listed = useNotifications((s) => s.items.find((item) => item.id === id) ?? null);
  const [fetched, setFetched] = useState<PlatformNotification | null>(null);
  const [failed, setFailed] = useState(false);
  const item = listed ?? fetched;

  // on screen: its pushes stay quiet
  useEffect(() => {
    if (!id) return;
    useSurface.setState({ notification: id });
    return () => {
      if (useSurface.getState().notification === id) useSurface.setState({ notification: null });
    };
  }, [id]);

  // opening it reads it (or fetches it, for one the list does not have yet); the banner goes only
  // once the server has it read (src/data/read-on-open.ts)
  useEffect(() => {
    if (!id) return;
    let alive = true;
    const store = useNotifications.getState();
    void readOnOpen(id, {
      known: store.items.find((entry) => entry.id === id),
      markRead: (target) => store.markRead(target),
      fetchByReading: (target) => store.open(target),
      clearBanner: (target) => clearReadBanners({ readIds: [target] }),
      reportFailure: () => {
        if (alive) alertError(t('notifications.markFailed'));
      },
    }).then(({ notification }) => {
      if (!alive || listed) return;
      if (notification) setFetched(notification);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opened notification
  }, [id]);

  const kind = item ? (KIND[item.kind] ?? { icon: 'bell' as const, label: 'notifications.kindOther' as const }) : null;
  const tint = item?.kind === 'runtime_failed' ? c.redTile : item?.kind.endsWith('_attention') ? c.orangeTile : undefined;
  const body = item ? plainText(item.body) : '';
  const target = item ? notificationTarget(item, getApiBase()) : null;
  const openLabel = target ? t(OPEN_LABEL[target.kind]) : null;

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: t('notifications.detailTitle') }} />
      {!item ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.grow}>
          {failed || !id ? (
            <EmptyState icon="alert" title={t('notifications.notFound')} style={styles.state} />
          ) : (
            <LoadingState style={styles.state} />
          )}
        </ScrollView>
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
          <View style={styles.card}>
            <View style={styles.meta} accessible accessibilityLabel={`${t(kind!.label)}, ${relativeTimeNow(item.created_at)}`}>
              <IconTile icon={kind!.icon} tint={tint} />
              <Text style={styles.kind}>{t(kind!.label)}</Text>
              <Text style={styles.time}>{relativeTimeNow(item.created_at)}</Text>
            </View>
            <Text style={styles.title} accessibilityRole="header" selectable>
              {item.title}
            </Text>
            {body ? (
              <Text style={styles.body} selectable>
                {body}
              </Text>
            ) : null}
          </View>
          {target && openLabel ? (
            <NativeButton
              label={openLabel}
              icon={target.kind === 'web' || target.kind === 'external' ? 'open' : 'chevR'}
              variant="prominent"
              fullWidth
              onPress={() => openTarget(router, target, hex.accent)}
              style={styles.action}
            />
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  grow: { flexGrow: 1 },
  state: { paddingTop: space.xxxl },
  content: { padding: space.margin, paddingBottom: space.xxxl },
  card: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.group,
    backgroundColor: c.secondaryGroupedBackground,
    ...squircle,
  },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  kind: { ...typo.subheadline, fontWeight: weight.semibold, color: c.secondaryLabel, flex: 1 },
  time: { ...typo.footnote, color: c.secondaryLabel },
  title: { ...typo.title3, fontWeight: weight.semibold, color: c.label },
  body: { ...typo.body, color: c.label },
  action: { marginTop: space.lg },
}));
