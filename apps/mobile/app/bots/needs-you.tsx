/**
 * `/bots/needs-you` — every card waiting on the member, across conversations,
 * decided right here (spec docs/specs/20261008-mobile-bots.md §2.5.6, D12):
 * opened from the "needs you" capsule over another conversation, the home
 * bridge row, or `greenhouse://bots/needs-you`. Sheet `[0.6, 1]`.
 *
 * Reads `GET /api/bots/requests?status=pending` through the store on open (the
 * WS `bots:attention` reloads it while the sheet is up — no socket needed for
 * the list or the decisions) and groups the cards by conversation, most urgent
 * first; a group's header opens that thread. Each card is the thread's own
 * `RequestCard`, deciding through `useBots.decide` — the result lands in the
 * store, so the thread underneath flips too. A card decided here stays as its
 * receipt (the list never jumps); once nothing is left: "All caught up", and
 * the sheet closes itself a second later. A sign-in card's "Sign In…" stacks
 * the sign-in sheet on top.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { RequestCard } from '../../src/bots/cards/request-card';
import { openThread } from '../../src/bots/nav';
import { useBots } from '../../src/bots/store';
import { AvatarStack } from '../../src/bots/ui/avatar-stack';
import { BotAvatar } from '../../src/bots/ui/bot-avatar';
import { botsById, conversationBotIds, conversationTitle } from '../../src/bots/vendor/web-helpers';
import type { BotConversationSummary, BotRequestDecision, BotRequestView } from '../../src/shared/bots';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, typo, useTheme, weight } from '../../src/theme';
import { Icon } from '../../src/ui/core';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { SheetClose } from '../../src/ui/sheet-chrome';

/** How long "All caught up" stays before the sheet closes itself. */
const CAUGHT_UP_MS = 1000;

/** Most urgent first: the soonest `expires_at` (none last), then the oldest. */
function urgency(a: BotRequestView, b: BotRequestView): number {
  const at = (r: BotRequestView) => {
    const ms = r.expires_at ? Date.parse(r.expires_at) : NaN;
    return Number.isFinite(ms) ? ms : Infinity;
  };
  const [x, y] = [at(a), at(b)];
  if (x !== y) return x < y ? -1 : 1;
  return Date.parse(a.created_at) - Date.parse(b.created_at);
}

export default function NeedsYouSheet() {
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const pendingRequests = useBots((s) => s.pendingRequests);
  const overrides = useBots((s) => s.requestOverrides);
  const pendingTotal = useBots((s) => s.pendingTotal);
  const conversations = useBots((s) => s.conversations);
  const conversationsLoaded = useBots((s) => s.conversationsLoaded);
  const loadPending = useBots((s) => s.loadPending);
  const loadConversations = useBots((s) => s.loadConversations);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void loadPending().finally(() => {
      if (live) setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [loadPending]);
  // Group headers name their conversation; the list may not have been read yet this session.
  useEffect(() => {
    if (!conversationsLoaded) void loadConversations();
  }, [conversationsLoaded, loadConversations]);

  // Every card shown while the sheet is up: one decided here stays (as its receipt).
  const seen = useRef(new Map<string, BotRequestView>());
  const cards = useMemo(() => {
    for (const request of pendingRequests) seen.current.set(request.id, request);
    const listed = new Set(pendingRequests.map((request) => request.id));
    const shown: BotRequestView[] = [];
    for (const [id, request] of seen.current) {
      const mine = overrides[id];
      // Decided here → its receipt; still listed → pending; gone from the list otherwise → dropped.
      if (mine) shown.push(mine);
      else if (listed.has(id)) shown.push(request);
    }
    return shown.sort(urgency);
  }, [pendingRequests, overrides]);
  const waiting = cards.filter((request) => request.status === 'pending').length;
  // An empty list while the counters still say otherwise is a failed read, not "all caught up".
  const caughtUp = loaded && waiting === 0 && pendingTotal === 0;
  const failed = loaded && cards.length === 0 && pendingTotal > 0;

  useEffect(() => {
    if (!caughtUp) return undefined;
    const timer = setTimeout(() => router.back(), CAUGHT_UP_MS);
    return () => clearTimeout(timer);
  }, [caughtUp, router]);

  const groups = useMemo(() => {
    const bySession = new Map<string, BotRequestView[]>();
    for (const request of cards) {
      const list = bySession.get(request.session_id) ?? [];
      list.push(request);
      bySession.set(request.session_id, list);
    }
    return [...bySession.entries()];
  }, [cards]);

  let content: React.ReactNode;
  if (caughtUp) content = <EmptyState icon="checkCircle" title={t('bots.needs.empty')} style={styles.fill} />;
  else if (!loaded && cards.length === 0) content = <LoadingState style={styles.fill} />;
  else if (failed) {
    content = (
      <EmptyState
        icon="alertCircle"
        title={t('bots.needs.loadFailed')}
        message={t('bots.card.err.network')}
        onRetry={() => void loadPending()}
        style={styles.fill}
      />
    );
  } else {
    content = groups.map(([sessionId, requests]) => (
      <View key={sessionId} style={styles.group}>
        <GroupHeader
          sessionId={sessionId}
          row={conversations.find((row) => row.session_id === sessionId) ?? null}
          fallbackBotId={requests[0]?.bot_id ?? null}
        />
        {requests.map((request) => (
          <NeedsCard key={request.id} request={request} />
        ))}
      </View>
    ));
  }

  return (
    <>
      <Stack.Screen options={{ title: t('bots.needs.title') }} />
      <SheetClose />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {content}
      </ScrollView>
    </>
  );
}

/** One card, deciding through the store (no "Ask Again" here: this sheet sends no messages). */
function NeedsCard({ request }: { request: BotRequestView }) {
  const decide = useBots((s) => s.decide);
  const onDecide = useCallback((body: BotRequestDecision) => decide(request, body), [decide, request]);
  return <RequestCard request={request} sessionId={request.session_id} readOnly={false} onDecide={onDecide} />;
}

/** The conversation a group of cards came from — a compact row that opens its thread. */
function GroupHeader({
  sessionId,
  row,
  fallbackBotId,
}: {
  sessionId: string;
  row: BotConversationSummary | null;
  fallbackBotId: string | null;
}) {
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const byId = useBots((s) => s.byId);
  const botsLoaded = useBots((s) => s.botsLoaded);
  const lookup = useMemo(() => botsById(Object.values(byId)), [byId]);

  const fallbackName = (fallbackBotId && byId[fallbackBotId]?.name) || '';
  const title = row
    ? conversationTitle(row, lookup, {
        // Before the directory answers, an unknown id is not a deleted Bot.
        unknownBot: botsLoaded ? t('bots.common.deletedBot') : '',
        group: t('bots.needs.group'),
        archived: (name) => t('bots.needs.archivedName', { name }),
      })
    : fallbackName;
  const memberIds = row ? (row.kind === 'direct' ? [row.owner_bot_id] : conversationBotIds(row)) : [fallbackBotId];
  const faces = memberIds.map((id) => (id ? (byId[id] ?? null) : null));

  return (
    <Pressable
      onPress={() => openThread(router, { c: sessionId, title }, 'dismissTo')}
      accessibilityRole="button"
      accessibilityLabel={title || t('bots.needs.group')}
      accessibilityHint={t('bots.needs.openHint')}
      style={({ pressed }) => [styles.header, pressed ? { opacity: 0.55 } : null]}
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {faces.length > 1 ? (
          <AvatarStack bots={faces} size={22} ring={null} />
        ) : (
          <BotAvatar bot={faces[0] ?? null} size={26} animate={false} />
        )}
      </View>
      <Text style={styles.headerTitle} numberOfLines={1}>
        {title}
      </Text>
      <Icon name="chevR" size={12} weight="semibold" color={c.tertiaryLabel} />
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  content: { flexGrow: 1, paddingHorizontal: space.margin, paddingBottom: space.xxxl, gap: space.xl },
  fill: { flex: 1 },
  group: { gap: space.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 44, paddingHorizontal: space.xs },
  headerTitle: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label, flexShrink: 1 },
}));
