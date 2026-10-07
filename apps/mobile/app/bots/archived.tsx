/**
 * `/bots/archived` — the Bots conversations nobody can reply in any more: a
 * DM whose Bot was archived, a group with no active Bot left (spec
 * docs/specs/20261008-mobile-bots.md §2.5.7). Reached from the drawer's
 * "Archived (N)" row. Each row is the conversation's sleeping plant, its title
 * (marked archived), the last message and the time; a tap closes the sheet and
 * opens the thread on home, read-only.
 *
 * The list is the store's (the drawer's source); opening the sheet and
 * pulling down re-read it. A failed first read is a retry state, never a fake
 * "nothing archived".
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useRowCopy } from '../../src/bots/drawer/conversation-row';
import { rowPreview, rowTitle } from '../../src/bots/drawer/row-text';
import { openThread } from '../../src/bots/nav';
import { BotsRouteGate } from '../../src/bots/route-gate';
import { drawerRows, useBots } from '../../src/bots/store';
import { AvatarStack } from '../../src/bots/ui/avatar-stack';
import { BotAvatar } from '../../src/bots/ui/bot-avatar';
import type { BotConversationSummary } from '../../src/shared/bots';
import { relativeTime } from '../../src/lib/format';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ListRow, ListSection } from '../../src/ui/list';
import { SheetClose } from '../../src/ui/sheet-chrome';

/** Leading column: a 32-pt plant, or a group's first two 22-pt plants overlapped. */
const LEAD_W = 44;

/** Closed Bots (Android, switched off, refused) → home: src/bots/route-gate.tsx. */
export default function ArchivedRoute() {
  return (
    <BotsRouteGate kind="threads">
      <ArchivedSheet />
    </BotsRouteGate>
  );
}

function ArchivedSheet() {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const copy = useRowCopy();

  const bots = useBots((s) => s.bots);
  const byId = useBots((s) => s.byId);
  const botsLoaded = useBots((s) => s.botsLoaded);
  const conversations = useBots((s) => s.conversations);
  const loaded = useBots((s) => s.conversationsLoaded && s.botsLoaded);
  const failed = useBots((s) => s.error === 'failed');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    await useBots.getState().loadBots();
    await useBots.getState().loadConversations();
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const rows = useMemo(
    () => drawerRows({ bots, byId, botsLoaded, conversations }, { query: '', expanded: true }).archived,
    [bots, byId, botsLoaded, conversations],
  );
  const dir = useMemo(() => ({ byId, botsLoaded }), [byId, botsLoaded]);

  const open = useCallback(
    (row: BotConversationSummary) =>
      openThread(router, { c: row.session_id, title: rowTitle(row, dir, copy) }, 'dismissTo'),
    [router, dir, copy],
  );

  return (
    <>
      <Stack.Screen options={{ title: t('bots.nav.archivedTitle') }} />
      <SheetClose />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={hex.accent} />
        }
      >
        {!loaded ? (
          failed ? (
            <EmptyState
              icon="alert"
              title={t('bots.nav.loadFailedTitle')}
              onRetry={() => void load()}
              style={styles.centered}
            />
          ) : (
            <LoadingState />
          )
        ) : rows.length === 0 ? (
          <EmptyState
            icon="archive"
            title={t('bots.nav.archivedEmpty')}
            message={t('bots.nav.archivedEmptyHint')}
            style={styles.centered}
          />
        ) : (
          <ListSection footer={t('bots.nav.archivedFooter')}>
            {rows.map((row) => {
              const title = rowTitle(row, dir, copy);
              const preview = rowPreview(row, dir, copy);
              const time = relativeTime(row.last_activity_at);
              const owner = row.owner_bot_id ? (byId[row.owner_bot_id] ?? null) : null;
              const members = [...row.members].sort((a, b) => a.position - b.position).slice(0, 2);
              return (
                <ListRow
                  key={row.session_id}
                  title={title}
                  subtitle={preview}
                  subtitleLines={1}
                  value={time}
                  leading={
                    // asleep and dimmed: nobody here replies any more
                    <View style={styles.lead}>
                      {row.kind === 'direct' ? (
                        <BotAvatar bot={owner} size={32} state="sleep" animate={false} />
                      ) : (
                        <AvatarStack
                          bots={members.map((m) => byId[m.bot_id] ?? null)}
                          size={22}
                          max={2}
                          ring={c.secondaryGroupedBackground}
                        />
                      )}
                    </View>
                  }
                  leadingWidth={LEAD_W}
                  accessory="chevron"
                  accessibilityLabel={[title, t('bots.nav.lastMessage', { text: preview }), time]
                    .filter(Boolean)
                    .join(t('bots.nav.listSep'))}
                  onPress={() => open(row)}
                />
              );
            })}
          </ListSection>
        )}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles(() => ({
  content: { paddingTop: space.sm, paddingBottom: space.xxxl, flexGrow: 1 },
  centered: { flexGrow: 1, justifyContent: 'center' },
  lead: { width: LEAD_W, alignItems: 'center', opacity: 0.6 },
}));
