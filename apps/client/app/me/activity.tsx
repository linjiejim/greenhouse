/**
 * 我的动态 (「我」 → 我的动态): my own activity log (`GET /api/activity`; the station returns a
 * member's own rows only): what I, my agents and my automations changed, newest first, filtered
 * by who and how far back, paged with Load More. A row opens its object or its run the shared way
 * (src/notifications/activity.ts). Export sends the same filters to `/api/activity/export`: the
 * browser downloads the CSV, the phone hands it to the share sheet (src/activity/export.ts).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { exportMyActivity } from '../../src/activity/export';
import { listMyActivity } from '../../src/api/activity';
import { captureIdentity } from '../../src/data/identity';
import {
  DEFAULT_MY_ACTIVITY,
  joinActivityPage,
  MY_ACTIVITY_PERIODS,
  MY_ACTIVITY_SOURCES,
  myActivityQuery,
  type MyActivityFilter,
  type MyActivityItem,
} from '../../src/data/my-activity';
import { useT, type TranslationKey } from '../../src/lib/i18n';
import { relativeTimeNow } from '../../src/lib/time-words';
import { activityLine, activityOpening, activityTitle } from '../../src/notifications/activity';
import { useStationManifest } from '../../src/plugins/store';
import { localize } from '../../src/shared/plugins';
import { useOpenHref, useOpenObject } from '../../src/shell/open-object';
import { useAuth } from '../../src/store/auth';
import { usePrefs } from '../../src/store/prefs';
import { makeStyles, space, useTheme } from '../../src/theme';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { Badge, Row, Section, type BadgeTone } from '../../src/ui/list';
import { usePullRefresh } from '../../src/ui/refresh';
import { Screen } from '../../src/ui/screen';
import { Segmented } from '../../src/ui/segmented';
import { toast } from '../../src/ui/toast';

const SOURCE_ICON = { person: 'person', agent: 'sparkle', automation: 'clock', admin: 'shieldCheck' } as const;
const STATUS_TONE: Record<string, BadgeTone> = {
  succeeded: 'green',
  failed: 'red',
  running: 'blue',
  outcome_unknown: 'orange',
};

type Load = 'loading' | 'more' | 'ready' | { message: string };

export default function MyActivity() {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const manifest = useStationManifest((s) => s.data);
  const openObject = useOpenObject();
  const openHref = useOpenHref();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [filter, setFilter] = useState<MyActivityFilter>(DEFAULT_MY_ACTIVITY);
  const [items, setItems] = useState<MyActivityItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<Load>('loading');
  const [exporting, setExporting] = useState(false);
  const generation = useRef(0);
  // The window is fixed when the filter is chosen, so Load More pages the same window.
  const me = useAuth((s) => s.user?.id ?? null);
  const query = useMemo(() => myActivityQuery(filter, Date.now(), me), [filter, me]);

  const load = useCallback(
    async (after: string | null) => {
      const n = ++generation.current;
      const same = captureIdentity();
      setState(after ? 'more' : 'loading');
      const page = await listMyActivity(query, after);
      if (n !== generation.current || !same()) return;
      if (!page.ok) {
        setState({ message: page.message });
        return;
      }
      setItems((list) => joinActivityPage(list, page.data, !!after));
      setCursor(page.data.next_cursor);
      setState('ready');
    },
    [query],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  const pull = usePullRefresh(() => load(null));

  const exportCsv = async () => {
    setExporting(true);
    const failed = await exportMyActivity(query);
    setExporting(false);
    if (failed) alertError(t('myActivity.exportFailed'), undefined, failed);
    else toast(t('myActivity.exported'), 'download');
  };

  const moduleLabel = (key: string) => {
    const known = `admin.activity.module.${key}`;
    const word = t(known as TranslationKey);
    if (word !== known) return word;
    const plugin = manifest.kind === 'v2' ? manifest.manifest.plugins.find((p) => p.id === key) : undefined;
    return plugin ? localize(plugin.name, lang) : key;
  };
  const words = {
    someone: t('notifications.someone'),
    verb: (verb: string) => {
      const key = `notifications.verb.${verb}`;
      const value = t(key as TranslationKey);
      return value === key ? null : value;
    },
  };
  const failed = typeof state === 'object' ? state : null;

  return (
    <>
      <Screen
        title={t('myActivity.title')}
        busy={state === 'loading' && items.length > 0 && !pull.refreshing}
        actions={[
          { icon: 'download', label: t('myActivity.export'), onPress: () => void exportCsv(), disabled: exporting },
        ]}
      />
      <ScrollView
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        <View style={styles.filters}>
          <Segmented
            value={filter.source}
            options={MY_ACTIVITY_SOURCES.map((source) => ({ value: source, label: t(`myActivity.source.${source}`) }))}
            onChange={(source) => setFilter((f) => ({ ...f, source }))}
          />
          <Segmented
            value={String(filter.days) as `${MyActivityFilter['days']}`}
            options={MY_ACTIVITY_PERIODS.map((days) => ({
              value: String(days) as `${MyActivityFilter['days']}`,
              label: t(`myActivity.period.d${days}`),
            }))}
            onChange={(days) => setFilter((f) => ({ ...f, days: Number(days) as MyActivityFilter['days'] }))}
          />
        </View>
        {items.length ? (
          <Section footer={t('myActivity.footer')}>
            {[
              ...items.map((item) => {
                const opening = activityOpening(item);
                return (
                  <Row
                    key={item.id}
                    title={activityTitle(item)}
                    subtitle={[activityLine(item, words), moduleLabel(item.module), relativeTimeNow(item.at)].join(
                      ' · ',
                    )}
                    icon={SOURCE_ICON[item.source] ?? 'person'}
                    accessory={
                      item.status ? (
                        <Badge
                          label={t(`admin.activity.status.${item.status}` as TranslationKey)}
                          tone={STATUS_TONE[item.status] ?? 'neutral'}
                        />
                      ) : opening ? (
                        'chevron'
                      ) : (
                        'none'
                      )
                    }
                    onPress={
                      opening ? () => ('ref' in opening ? openObject(opening.ref) : openHref(opening.href)) : undefined
                    }
                  />
                );
              }),
              ...(cursor
                ? [
                    <Row
                      key="more"
                      title={state === 'more' ? t('common.loading') : t('myActivity.loadMore')}
                      icon="chevD"
                      accessory="none"
                      disabled={state === 'more'}
                      onPress={() => void load(cursor)}
                    />,
                  ]
                : []),
            ]}
          </Section>
        ) : state === 'loading' ? (
          <LoadingState style={styles.state} />
        ) : failed ? (
          <EmptyState
            icon="alert"
            title={t('myActivity.loadFailed')}
            message={failed.message || undefined}
            onRetry={() => void load(null)}
            style={styles.state}
          />
        ) : (
          <EmptyState
            icon="runs"
            title={t('myActivity.empty')}
            message={t('myActivity.emptyHint')}
            style={styles.state}
          />
        )}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl * 2 },
  filters: { marginHorizontal: space.margin, marginTop: space.md, gap: space.sm },
  state: { paddingTop: space.xxxl },
}));
