/**
 * `RequestCard` — a "needs you" card (approval, background task, proposed Bot,
 * instructions change, sign-in, take-over) in a transcript or the needs-you
 * sheet (props: ../contract.ts `RequestCardProps`).
 *
 * In a list a card is only a SUMMARY (2026-10): the kind's tile, the headline
 * ("Sprouty needs your approval"), what it would do and one quiet line of
 * essentials (./decision.ts `cardGist` — "Create · Weekly due tasks"), and
 * "Waiting for you ›" while it is pending. No buttons: the whole card opens its
 * sheet (app/bots/request.tsx), which shows everything and is the only place
 * to decide — nothing is approved without being seen in full. A settled card
 * collapses to a one-line receipt (./receipt.tsx) that opens the same sheet,
 * read-only. The card holds no state about the decision itself: the host's
 * merged copy of the request (REST → live stream → this device's decisions,
 * only ever forward) is the truth, so a card decided in its sheet flips here.
 * A kind this version does not know renders a line (./unknown.tsx).
 *
 * `RequestBody` is the kind dispatch on its own, for the sheet to show a card
 * in full.
 */

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import type { BotCreatePayload, BotRequestView } from '../../shared/bots';
import { ChatCard } from '../../chat/chat-card';
import { useT } from '../../lib/i18n';
import { makeStyles, space, typo, useTheme, weight } from '../../theme';
import { Icon } from '../../ui/core';
import { useFontScaleKey } from '../../ui/font-scale';
import { IconTile } from '../../ui/list';
import type { RequestCardProps } from '../contract';
import { BotAvatar } from '../ui/bot-avatar';
import { ApprovalBody } from './approval';
import { BotCreateBody } from './bot-create';
import { HighlightWash, tr, useBotName } from './card-frame';
import {
  CARD_ICON,
  askAgainOffered,
  cardGist,
  cardKind,
  cardTitle,
  countdown,
  countdownNextChange,
} from './decision';
import { InstructionsBody } from './instructions';
import { LoginBody } from './login-card';
import { Receipt } from './receipt';
import { TakeoverBody } from './takeover';
import { TaskStartBody } from './task-start';
import { UnknownBody } from './unknown';

/** A card's body by kind, whole — the card's sheet (app/bots/request.tsx) shows it. */
export function RequestBody({
  request,
  name,
  onAskAgain,
}: {
  request: BotRequestView;
  sessionId: string;
  /** The asking Bot's display name. */
  name: string;
  /** A fresh ask after a refused sign-in (threads that can still send). */
  onAskAgain?: () => void;
}) {
  switch (cardKind(request)) {
    case 'approval':
      return <ApprovalBody request={request} />;
    case 'task_start':
      return <TaskStartBody request={request} />;
    case 'bot_create':
      return <BotCreateBody request={request} />;
    case 'instructions_update':
      return <InstructionsBody request={request} />;
    case 'login':
      return <LoginBody request={request} onAskAgain={onAskAgain} />;
    case 'handback':
    case 'captcha':
    case 'takeover':
      return <TakeoverBody request={request} name={name} />;
    default:
      return <UnknownBody />;
  }
}

export const RequestCard: React.NamedExoticComponent<RequestCardProps> = memo(function RequestCard({
  request,
  sessionId,
  readOnly,
  highlighted,
  onAskAgain,
}: RequestCardProps) {
  const router = useRouter();
  const kind = cardKind(request);
  const pending = request.status === 'pending';
  // Flip to the receipt with a fade only when it settled before the member's eyes.
  const sawPending = useRef(pending);
  const open = useCallback(
    () => router.push({ pathname: '/bots/request', params: { id: request.id, c: sessionId } }),
    [router, request.id, sessionId],
  );

  const botId = request.bot_id;
  // A read-only thread cannot send, so it cannot ask again (nor does the needs-you sheet).
  const askAgain = !readOnly && onAskAgain && botId ? () => onAskAgain(botId) : undefined;
  const reAsk = askAgainOffered(request) ? askAgain : undefined;

  if (!pending && kind !== 'unknown') {
    return (
      <Animated.View entering={sawPending.current ? FadeIn.duration(200) : undefined}>
        <Receipt request={request} highlighted={highlighted} onOpen={open} onAskAgain={reAsk} />
      </Animated.View>
    );
  }
  return <SummaryCard request={request} highlighted={highlighted} onOpen={kind === 'unknown' ? undefined : open} />;
});

/** The pending card: tile + headline, what it would do, its essentials, "Waiting for you ›". */
function SummaryCard({
  request,
  highlighted,
  onOpen,
}: {
  request: BotRequestView;
  highlighted?: boolean;
  onOpen?: () => void;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const fontKey = useFontScaleKey();
  const name = useBotName(request.bot_id);
  const kind = cardKind(request);
  const title = tr(t, cardTitle(request, name));
  const gist = cardGist(request);
  const detail = gist.detail == null ? null : typeof gist.detail === 'string' ? gist.detail : tr(t, gist.detail);
  const left = useCountdown(request);
  const proposed = kind === 'bot_create' ? (request.payload as BotCreatePayload) : null;
  const status =
    left === null
      ? t('bots.card.waiting')
      : left > 0
        ? t('bots.card.expiresIn', { s: left })
        : t('bots.card.expiringNow');
  const label = [title, gist.what, detail, status].filter(Boolean).join(t('bots.nav.listSep'));
  return (
    <ChatCard variant="fill" onPress={onOpen} accessibilityLabel={label} accessibilityHint={t('bots.card.openHint')}>
      <HighlightWash highlighted={highlighted} radius={16} />
      <View key={fontKey} style={styles.body}>
        <View style={styles.head}>
          <IconTile icon={CARD_ICON[kind]} />
          <Text style={styles.headline} numberOfLines={2}>
            {title}
          </Text>
        </View>
        {kind === 'unknown' ? (
          <UnknownBody />
        ) : (
          <>
            {gist.what ? (
              <View style={styles.whatRow}>
                {proposed ? (
                  <BotAvatar bot={{ id: request.id, avatar: proposed.avatar ?? null, template_key: null }} size={28} />
                ) : null}
                <Text style={styles.what} numberOfLines={2}>
                  {gist.what}
                </Text>
              </View>
            ) : null}
            {detail ? (
              <Text style={styles.detail} numberOfLines={1}>
                {detail}
              </Text>
            ) : null}
            <View style={styles.foot}>
              <View style={[styles.dot, { backgroundColor: c.orange }]} />
              <Text style={[styles.status, left !== null && { color: c.orange }]}>{status}</Text>
              <Icon name="chevR" size={12} weight="semibold" color={c.tertiaryLabel} />
            </View>
          </>
        )}
      </View>
    </ChatCard>
  );
}

/**
 * Seconds left in the card's last minute (./decision.ts `countdown` — the server's `expires_at`,
 * clamped), else null; re-renders once a second inside that window and not at all before it.
 */
function useCountdown(request: BotRequestView): number | null {
  const [now, setNow] = useState(() => Date.now());
  const { status, expires_at, created_at } = request;
  useEffect(() => {
    const wait = countdownNextChange({ status, expires_at, created_at }, Date.now());
    if (wait === null) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [status, expires_at, created_at, now]);
  const { show, seconds } = countdown({ status, expires_at, created_at }, now);
  return show ? seconds : null;
}

const useStyles = makeStyles((c) => ({
  body: { padding: space.md + 2, gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  headline: { ...typo.subheadline, fontWeight: weight.semibold, color: c.secondaryLabel, flex: 1 },
  whatRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  what: { ...typo.body, fontWeight: weight.semibold, color: c.label, flex: 1 },
  detail: { ...typo.subheadline, color: c.secondaryLabel },
  foot: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, marginTop: space.xxs },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  status: { ...typo.footnote, fontWeight: weight.medium, color: c.secondaryLabel, flex: 1 },
}));
