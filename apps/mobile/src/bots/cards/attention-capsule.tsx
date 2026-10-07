/**
 * `AttentionCapsule` — the glass "needs you" capsule under the navigation bar
 * of a thread or a chat (spec docs/specs/20261008-mobile-bots.md §2.5.3 g,
 * D12; props: ../contract.ts `AttentionCapsuleProps`). Without push, this is
 * how a card waiting in *another* conversation reaches the member before its
 * window closes (an approval waits ~110 s):
 *
 * - another conversation's pending card first — the one expiring soonest
 *   (`capsuleItem`): "(face) Pip needs your approval · Send the report ›",
 *   or "3 things need you ›" — opens the needs-you sheet, where it is decided
 *   in place without leaving this conversation;
 * - else a background task's report that landed elsewhere this app session:
 *   "(face) Curly reported back: Meeting notes ›" — opens that thread.
 *
 * Control layer, so glass (`Glass`, interactive); renders nothing — and takes
 * no space — when there is nothing to say or the Bots surfaces are closed.
 * The host places it (and pads its transcript by its height). Re-reads the
 * clock exactly when the first listed card expires, so an expired card never
 * lingers.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useT } from '../../lib/i18n';
import { makeStyles, radius, space, typo, useTheme, weight } from '../../theme';
import { Icon } from '../../ui/core';
import { Glass, LIQUID_GLASS } from '../../ui/glass';
import { useBotsEnabled } from '../availability';
import type { AttentionCapsuleProps } from '../contract';
import { openThread } from '../nav';
import { capsuleItem, useBots } from '../store';
import { BotAvatar } from '../ui/bot-avatar';
import { AvatarStack } from '../ui/avatar-stack';
import { conversationTitle, botsById } from '../vendor/web-helpers';
import { capsuleLine } from './decision';

const AVATAR = 22;

/** Re-render when the soonest-expiring pending card expires (the capsule must drop it then). */
function useExpiryTick(expiries: readonly (string | null)[]): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    let next = Infinity;
    for (const at of expiries) {
      const ms = at ? Date.parse(at) : NaN;
      if (Number.isFinite(ms) && ms > now && ms < next) next = ms;
    }
    if (next === Infinity) return undefined;
    const timer = setTimeout(() => setTick((n) => n + 1), next - now + 50);
    return () => clearTimeout(timer);
  }, [expiries, tick]);
  return tick;
}

export function AttentionCapsule({ excludeSid }: AttentionCapsuleProps): React.JSX.Element | null {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const router = useRouter();
  const enabled = useBotsEnabled();
  const pendingRequests = useBots((s) => s.pendingRequests);
  const requestOverrides = useBots((s) => s.requestOverrides);
  const arrivals = useBots((s) => s.arrivals);
  const byId = useBots((s) => s.byId);
  const botsLoaded = useBots((s) => s.botsLoaded);
  const conversations = useBots((s) => s.conversations);

  const expiries = useMemo(() => pendingRequests.map((request) => request.expires_at), [pendingRequests]);
  const tick = useExpiryTick(expiries);
  const item = useMemo(
    () => capsuleItem({ pendingRequests, requestOverrides, arrivals }, excludeSid, Date.now()),
    // `tick` re-reads the clock when a card expires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingRequests, requestOverrides, arrivals, excludeSid, tick],
  );

  if (!enabled || !item) return null;

  const nameOf = (botId: string | null) => {
    const bot = botId ? byId[botId] : undefined;
    if (bot) return bot.name;
    return botId && botsLoaded ? t('bots.common.deletedBot') : t('bots.card.aBot');
  };
  const line = capsuleLine(item, nameOf);
  const head = t(line.key, line.vars);
  const label = line.detail ? t('bots.capsule.detail', { text: head, detail: line.detail }) : head;

  // Faces: the asking Bot; several cards → their distinct Bots; a report → the Bot that reported.
  let faces: Array<string | null>;
  if (item.kind === 'arrival') faces = [item.arrival.botId];
  else if (item.count > 1) {
    // The same cards `capsuleItem` counted: still pending here, not expired, elsewhere.
    const now = Date.now();
    const ids = new Set<string | null>();
    for (const request of pendingRequests) {
      const status = requestOverrides[request.id]?.status ?? request.status;
      const expires = request.expires_at ? Date.parse(request.expires_at) : Infinity;
      if (status === 'pending' && request.session_id !== excludeSid && !(expires <= now)) ids.add(request.bot_id);
    }
    faces = [...ids];
  } else faces = [item.request.bot_id];
  const avatars = faces.map((id) => (id ? (byId[id] ?? null) : null));

  const onPress = () => {
    if (item.kind === 'needs_you') {
      router.push('/bots/needs-you');
      return;
    }
    const row = conversations.find((candidate) => candidate.session_id === item.sessionId);
    const title = row
      ? conversationTitle(row, botsById(Object.values(byId)), {
          unknownBot: '',
          group: t('bots.needs.group'),
          archived: (name) => t('bots.needs.archivedName', { name }),
        })
      : nameOf(item.arrival.botId);
    openThread(router, { c: item.sessionId, title });
  };

  return (
    // box-none: the strip beside the capsule must not swallow touches meant for the transcript under it.
    <Animated.View
      entering={FadeInUp.duration(220)}
      exiting={FadeOutUp.duration(160)}
      pointerEvents="box-none"
      style={styles.wrap}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={t(item.kind === 'needs_you' ? 'bots.capsule.needsHint' : 'bots.capsule.reportHint')}
        // Liquid Glass answers the touch itself (interactive); the fallback surface dims.
        style={({ pressed }) => [styles.press, pressed && !LIQUID_GLASS ? { opacity: 0.6 } : null]}
      >
        <Glass interactive style={styles.capsule}>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {avatars.length > 1 ? (
              <AvatarStack bots={avatars} size={AVATAR - 2} ring={null} />
            ) : (
              <BotAvatar bot={avatars[0] ?? null} size={AVATAR} animate={false} />
            )}
          </View>
          <Text style={styles.text} numberOfLines={1}>
            {label}
          </Text>
          <Icon name="chevR" size={11} weight="semibold" color={c.tertiaryLabel} />
        </Glass>
      </Pressable>
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: { alignItems: 'center', paddingHorizontal: space.margin, paddingVertical: space.xs },
  press: { maxWidth: '100%' },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 40,
    paddingLeft: space.sm,
    paddingRight: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.full,
  },
  text: { ...typo.subheadline, fontWeight: weight.medium, color: c.label, flexShrink: 1 },
}));
