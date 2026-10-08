/**
 * The new chat's ties to the member's Bots (spec docs/specs/20261008-mobile-bots.md
 * §2.5.2, D4/D12) — used by the home conversation screen (app/(drawer)/(main)/index.tsx):
 *
 *  - `HomeBridge` — one tappable footnote line under the hero that points back
 *    into the Bots: someone waiting for the member (orange — one card opens its
 *    thread at the card, several open the needs-you sheet) > a background task
 *    that reported back > something unread > "Continue with Sprouty" (the
 *    priority is ./bridge-item.ts) — that last, idle line only with `idleLine`
 *    (the hero passes it when the shelf of faces is hidden; otherwise the
 *    faces already lead to every Bot). Hidden while the keyboard is up — the
 *    hero is squeezed then, and the member is typing a fresh question anyway.
 *  - `useProfileBot` — the Bot behind a `?profile=` new chat ("Ask Dandy in a
 *    New Chat"): its directory entry and its ongoing DM, for the hero's name
 *    and the "Back to Dandy" button.
 *  - `useBotsWarm` — the home reads the Bots lists for the ☰ badge, the
 *    capsule and the bridge; the realtime bridge keeps them fresh, this only
 *    fills what nobody has read yet (a cold start before the WS is up).
 *
 * Both loaders wait while auth is loading (`useAuth.loading`: startup and a
 * station switch, whose store reset clears `botsLoaded` before the new
 * station's session is in) — whatever the caller passes.
 */

import React, { useEffect, useMemo } from 'react';
import { Pressable, Text } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useKeyboardState } from 'react-native-keyboard-controller';
import type { BotView } from '../../shared/bots';
import { useT } from '../../lib/i18n';
import { useAuth } from '../../store/auth';
import { HIT, makeStyles, space, typo, useTheme } from '../../theme';
import { Icon } from '../../ui/core';
import { alertError } from '../../ui/dialogs';
import { useRowCopy } from '../drawer/conversation-row';
import { rowTitle } from '../drawer/row-text';
import { openThread } from '../nav';
import { sproutyBot, sproutyDm, useBots } from '../store';
import { bridgeItem } from './bridge-item';

export function HomeBridge({ idleLine = true }: { idleLine?: boolean }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const copy = useRowCopy();
  const keyboardUp = useKeyboardState((s) => s.isVisible);

  const bots = useBots((s) => s.bots);
  const byId = useBots((s) => s.byId);
  const botsLoaded = useBots((s) => s.botsLoaded);
  const conversations = useBots((s) => s.conversations);
  const pendingRequests = useBots((s) => s.pendingRequests);
  const requestOverrides = useBots((s) => s.requestOverrides);
  const arrivals = useBots((s) => s.arrivals);

  const item = useMemo(
    () => bridgeItem({ bots, botsLoaded, conversations, pendingRequests, requestOverrides, arrivals }, Date.now()),
    [bots, botsLoaded, conversations, pendingRequests, requestOverrides, arrivals],
  );

  const view = useMemo(() => {
    if (!item) return null;
    const dir = { byId, botsLoaded };
    const titleOf = (sessionId: string) => {
      const row = conversations.find((r) => r.session_id === sessionId);
      return row ? rowTitle(row, dir, copy) : '';
    };
    switch (item.kind) {
      case 'needs_you': {
        const name = (item.botId && byId[item.botId]?.name) || titleOf(item.sessionId);
        if (item.count > 1) {
          return {
            label: t('bots.nav.bridgeNeedsYouN', { n: item.count }),
            urgent: true,
            go: () => router.push('/bots/needs-you'),
          };
        }
        if (!name) return null;
        return {
          label: t('bots.nav.bridgeNeedsYou', { name }),
          urgent: true,
          go: () =>
            openThread(router, { c: item.sessionId, title: titleOf(item.sessionId), request: item.requestId ?? '' }),
        };
      }
      case 'report': {
        const name = byId[item.arrival.botId]?.name;
        if (!name) return null;
        return {
          label: t('bots.nav.bridgeReport', { name, title: item.arrival.title }),
          urgent: false,
          go: () => openThread(router, { c: item.sessionId, title: titleOf(item.sessionId) }),
        };
      }
      case 'unread': {
        const name = rowTitle(item.row, dir, copy);
        if (!name) return null;
        return {
          label: t('bots.nav.bridgeNew', { name }),
          urgent: false,
          go: () => openThread(router, { c: item.row.session_id, title: name }),
        };
      }
      case 'sprouty': {
        if (!idleLine) return null;
        const { bot, sessionId } = item;
        return {
          label: t('bots.nav.bridgeDefault', { name: bot.name }),
          urgent: false,
          go: async () => {
            const sid = sessionId ?? (await useBots.getState().ensureSprouty());
            if (sid) openThread(router, { c: sid, title: bot.name });
            else alertError(t('bots.nav.unavailable'));
          },
        };
      }
    }
  }, [item, idleLine, byId, botsLoaded, conversations, copy, router, t]);

  if (!view || keyboardUp) return null;
  const tint = view.urgent ? c.orange : c.accent;
  return (
    <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(120)}>
      <Pressable
        onPress={() => void view.go()}
        accessibilityRole="button"
        accessibilityLabel={view.label}
        hitSlop={{ top: (HIT - 20) / 2, bottom: (HIT - 20) / 2 }}
        style={({ pressed }) => [styles.row, pressed && { opacity: 0.5 }]}
      >
        <Text numberOfLines={1} style={[styles.text, { color: tint }]}>
          {view.label}
        </Text>
        <Icon name="chevR" size={11} color={tint} weight="semibold" />
      </Pressable>
    </Animated.View>
  );
}

/**
 * The Bot a `?profile=` new chat talks to: `sprouty` or `bot:<id>`, with its
 * ongoing DM (null until known). null for any other profile — a system agent
 * picked in the agent capsule is not a Bot.
 */
export function useProfileBot(profile: string | undefined): { bot: BotView | null; dm: string | null } | null {
  // `bot:<id>`, possibly pinned to a version (`bot:<id>@<v>`)
  const botId = profile?.startsWith('bot:') ? profile.slice('bot:'.length).split('@')[0] || null : null;
  const isBot = profile === 'sprouty' || !!botId;
  const bot = useBots((s) => (profile === 'sprouty' ? sproutyBot(s) : botId ? (s.byId[botId] ?? null) : null));
  const dm = useBots((s) => {
    if (profile === 'sprouty') return sproutyDm(s);
    if (!botId) return null;
    const direct = s.byId[botId]?.dm_session_id;
    return (
      direct ?? s.conversations.find((row) => row.kind === 'direct' && row.owner_bot_id === botId)?.session_id ?? null
    );
  });
  const botsLoaded = useBots((s) => s.botsLoaded);
  const settled = useAuth((s) => !s.loading);
  useEffect(() => {
    if (settled && isBot && !botsLoaded) void useBots.getState().loadBots();
  }, [settled, isBot, botsLoaded]);
  return useMemo(() => (isBot ? { bot, dm } : null), [isBot, bot, dm]);
}

/** Fill the lists the home reads (☰ badge, capsule, bridge) when nothing has read them yet. */
export function useBotsWarm(wanted: boolean): void {
  const enabled = useAuth((s) => wanted && !s.loading);
  const botsLoaded = useBots((s) => s.botsLoaded);
  const conversationsLoaded = useBots((s) => s.conversationsLoaded);
  // Cards are waiting (the list says so) but the pending list itself was never read.
  const pendingUnread = useBots((s) => s.pendingTotal > 0 && s.pendingRequests.length === 0);
  useEffect(() => {
    if (!enabled) return;
    const store = useBots.getState();
    if (!botsLoaded) void store.loadBots();
    if (!conversationsLoaded) void store.loadConversations();
  }, [enabled, botsLoaded, conversationsLoaded]);
  useEffect(() => {
    if (enabled && pendingUnread) void useBots.getState().loadPending();
  }, [enabled, pendingUnread]);
}

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xxs + 1,
    marginTop: space.sm,
    maxWidth: '100%',
  },
  text: { flexShrink: 1, ...typo.footnote, color: c.accent },
}));
