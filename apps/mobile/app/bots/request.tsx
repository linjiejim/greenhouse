/**
 * `/bots/request?id=&c=` — a card's sheet, the only place a "needs you" card
 * is decided (2026-10: in a transcript a card is just its summary — tap it,
 * read everything, then decide). The sheet itself is the container — no card
 * nested inside it: the kind's tile and headline, then the whole body (every
 * approval detail — long values such as a task prompt under their label,
 * across the row — the whole task brief, the instructions' line diff, a
 * proposed Bot's whole instructions), and the decision buttons pinned under it
 * (equal widths, the prominent one nearest the thumb) with the last-minute
 * countdown. A settled card opens here read-only, its outcome as a badge.
 *
 * Decisions go through `useBots.decide`, so the result lands in
 * `requestOverrides` and the card in the thread underneath flips with it (results
 * travel through the store, never callbacks). The sheet closes once a decision
 * went through or turned out to be settled elsewhere; a refusal keeps it open
 * with the reason in an alert. Pure RN + `NativeButton` (both platforms).
 */

import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DecisionBar, tr, useBotName, useCardActions } from '../../src/bots/cards/card-frame';
import { Countdown } from '../../src/bots/cards/countdown';
import { CARD_ICON, cardKind, cardTitle, statusBadge, type CardButton } from '../../src/bots/cards/decision';
import { RequestBody } from '../../src/bots/cards/request-card';
import { useRequestLookup } from '../../src/bots/cards/use-login-form';
import { BotsRouteGate } from '../../src/bots/route-gate';
import { useBots } from '../../src/bots/store';
import type { BotRequestDecision, BotRequestView } from '../../src/shared/bots';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, typo, useTheme, weight } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { useFontScaleKey } from '../../src/ui/font-scale';
import { Badge, IconTile } from '../../src/ui/list';
import { SheetClose } from '../../src/ui/sheet-chrome';

/** Closed Bots (Android, switched off, refused) → home: src/bots/route-gate.tsx. */
export default function RequestRoute() {
  return (
    <BotsRouteGate kind="threads">
      <RequestSheet />
    </BotsRouteGate>
  );
}

function RequestSheet() {
  const t = useT();
  const { id, c } = useLocalSearchParams<{ id?: string; c?: string }>();
  const lookup = useRequestLookup(id, c);
  return (
    <>
      <Stack.Screen options={{ title: '' }} />
      <SheetClose />
      {lookup.state === 'ready' ? (
        <RequestDetail request={lookup.request} sessionId={c || lookup.request.session_id} />
      ) : lookup.state === 'loading' ? (
        <LoadingState style={{ flex: 1 }} />
      ) : lookup.state === 'error' ? (
        <EmptyState
          icon="alertCircle"
          title={t('bots.needs.loadFailed')}
          message={t('bots.card.err.network')}
          onRetry={lookup.retry}
          style={{ flex: 1 }}
        />
      ) : (
        <EmptyState icon="alertCircle" title={t('bots.needs.goneTitle')} style={{ flex: 1 }} />
      )}
    </>
  );
}

function RequestDetail({ request, sessionId }: { request: BotRequestView; sessionId: string }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const fontKey = useFontScaleKey();
  const decide = useBots((s) => s.decide);
  const name = useBotName(request.bot_id);
  const onDecide = useCallback((body: BotRequestDecision) => decide(request, body), [decide, request]);
  const { busy, press } = useCardActions({ request, sessionId, name, onDecide });
  const onPress = useCallback(
    (button: CardButton) =>
      void press(button).then((outcome) => {
        if (outcome && outcome.kind !== 'refused') router.back();
      }),
    [press, router],
  );
  const pending = request.status === 'pending';
  const badge = statusBadge(request);
  const kind = cardKind(request);
  // The buttons float over the content's end (the sheet sizes its scroll view itself): reserve their height.
  const [barH, setBarH] = useState(0);
  return (
    <View style={styles.root}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.content, pending && { paddingBottom: barH + space.lg }]}
      >
        <View key={fontKey} style={styles.head}>
          <IconTile icon={CARD_ICON[kind]} tint={pending ? undefined : c.gray} />
          <Text style={styles.headline} numberOfLines={2} accessibilityRole="header">
            {tr(t, cardTitle(request, name))}
          </Text>
          {pending ? null : <Badge label={t(badge.key)} tone={badge.tone} />}
        </View>
        <RequestBody request={request} sessionId={sessionId} name={name} />
      </ScrollView>
      {pending ? (
        <View
          onLayout={(e) => setBarH(Math.ceil(e.nativeEvent.layout.height))}
          style={[styles.actions, { paddingBottom: Math.max(insets.bottom, space.md) }]}
        >
          <Countdown request={request} />
          <DecisionBar request={request} busy={busy} onPress={onPress} />
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1 },
  content: { paddingHorizontal: space.margin, paddingTop: space.sm, paddingBottom: space.xl, gap: space.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  headline: { ...typo.subheadline, fontWeight: weight.semibold, color: c.secondaryLabel, flex: 1 },
  actions: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: space.sm,
    paddingHorizontal: space.margin,
    paddingTop: space.md,
    backgroundColor: c.background,
    borderTopWidth: 0.5,
    borderTopColor: c.separator,
  },
}));
