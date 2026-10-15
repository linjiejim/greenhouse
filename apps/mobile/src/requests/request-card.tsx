/**
 * A 「需要你」 card in a transcript or the notification center (CONV-17, conversation.md): the
 * one card layout — the kind's icon, the title, a short meta line, and the status word fixed at
 * the right of the title row (yellow only while it needs you). Below, the essentials: why, and
 * up to three details.
 *
 * On a phone a card in a list is a summary: the whole card opens its sheet (app/request.tsx),
 * which shows everything and is where the member decides — nothing is approved without being
 * seen in full. Once decided the card stays, quieter, with the outcome as its status.
 */

import React, { memo, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { plainText } from '../chat/text';
import { ChatCard } from '../chat/chat-card';
import { relativeTimeNow } from '../lib/time-words';
import { useT } from '../lib/i18n';
import type { NeedsYou } from '../shared/contract';
import { makeStyles, radius, space, typo, useTheme, weight } from '../theme';
import { openConversation } from '../shell/nav';
import { Icon } from '../ui/core';
import { useFontScaleKey } from '../ui/font-scale';
import { KIND_ICON, cardBody, requestStatus, secondsLeft, retiredRequest } from './model';

export const RequestCard = memo(function RequestCard({
  request,
  inset = false,
  context,
  highlighted,
}: {
  request: NeedsYou;
  /** A transcript row (not inside a reply): keeps the replies' margins. */
  inset?: boolean;
  /** A line about where it is from (the notification center: the Agent's name). */
  context?: string;
  /** Deep-linked: drawn with the accent edge for a moment. */
  highlighted?: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const fontKey = useFontScaleKey();
  const large = Number(fontKey) >= 1.5;
  const pending = request.status === 'pending';
  const status = requestStatus(request);
  const body = cardBody(request);
  const left = useSecondsLeft(request);
  const statusWord =
    left !== null
      ? t('requests.expiresIn', { s: left })
      : t(`requests.status.${status.word}` as 'requests.status.needsYou');
  const tone = status.tone === 'warning' ? c.orange : status.tone === 'success' ? c.green : c.secondaryLabel;
  const summary = plainText(body.reason || body.details.map((detail) => detail.value).join(' · ') || body.body);
  const meta = [context, relativeTimeNow(request.created_at)].filter(Boolean).join(' · ');
  const retired = retiredRequest(request);
  if (retired)
    return (
      <Text
        style={styles.summary}
        accessibilityRole={retired.replacement ? 'link' : undefined}
        onPress={retired.replacement ? () => openConversation(router, retired.replacement!) : undefined}
      >
        {t(`requests.status.${retired.word}` as 'requests.status.needsYou')}
      </Text>
    );
  return (
    <ChatCard
      variant={pending ? 'fill' : 'outline'}
      inset={inset}
      onPress={() => router.push({ pathname: '/request', params: { id: request.id } })}
      accessibilityLabel={[request.title, statusWord, summary].filter(Boolean).join(t('common.listSep'))}
      accessibilityHint={t('requests.openHint')}
      style={[pending && styles.pending, highlighted && styles.highlighted]}
    >
      <View key={fontKey} style={styles.body}>
        <View style={[styles.head, large && { flexWrap: 'wrap' }]}>
          <Icon name={KIND_ICON[request.kind]} size={16} color={pending ? c.orange : c.secondaryLabel} />
          <Text style={[styles.title, large && { flexBasis: '80%' }]} numberOfLines={large ? 0 : 2}>
            {request.title}
          </Text>
          <View style={[styles.status, { borderColor: tone }]}>
            <Text style={[styles.statusText, { color: tone }]}>{statusWord}</Text>
          </View>
        </View>
        {summary ? (
          <Text style={styles.summary} numberOfLines={large ? 0 : 3}>
            {summary}
          </Text>
        ) : null}
        <View style={styles.foot}>
          <Text style={styles.meta} numberOfLines={large ? 0 : 1}>
            {meta}
          </Text>
          {pending ? (
            <>
              <Text style={styles.open}>{t('requests.review')}</Text>
              <Icon name="chevR" size={12} weight="semibold" color={c.accent} />
            </>
          ) : null}
        </View>
      </View>
    </ChatCard>
  );
});

/** Seconds left in a card's last minute; re-renders once a second inside that window only. */
function useSecondsLeft(request: NeedsYou): number | null {
  const [now, setNow] = useState(() => Date.now());
  const left = secondsLeft(request, now);
  useEffect(() => {
    if (request.status !== 'pending' || !request.expires_at) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), left !== null ? 1000 : 30_000);
    return () => clearTimeout(timer);
  }, [request.status, request.expires_at, left, now]);
  return left;
}

const useStyles = makeStyles((c) => ({
  pending: { borderWidth: 1, borderColor: c.orange },
  highlighted: { borderWidth: 2, borderColor: c.accent },
  body: { padding: space.md, gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  title: { flex: 1, ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  status: { maxWidth: '100%', borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 1 },
  statusText: { ...typo.caption1, fontWeight: weight.semibold },
  summary: { ...typo.subheadline, color: c.secondaryLabel },
  foot: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  meta: { flex: 1, ...typo.caption1, color: c.tertiaryLabel },
  open: { ...typo.footnote, fontWeight: weight.semibold, color: c.accent },
}));
