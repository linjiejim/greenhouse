/**
 * `/bots/request?id=&c=` — a card in full, opened from its "View All ›" /
 * "View Changes ›" (spec docs/specs/20261008-mobile-bots.md §2.5.6): every
 * approval detail with the server's truncation said in the member's language,
 * the whole task brief, the instructions' line diff, a proposed Bot's whole
 * instructions — and the same decision buttons as the card.
 *
 * Decisions go through `useBots.decide`, so the result lands in
 * `requestOverrides` and the card in the thread underneath flips with it (results
 * travel through the store, never callbacks). The sheet closes once a decision
 * went through or turned out to be settled elsewhere; a refusal keeps it open
 * with the reason in an alert. Pure RN + `NativeButton` (both platforms).
 */

import React, { useCallback } from 'react';
import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { CardFrame, DecisionBar, tr, useBotName, useCardActions } from '../../src/bots/cards/card-frame';
import { Countdown } from '../../src/bots/cards/countdown';
import { CARD_ICON, cardKind, cardTitle, statusBadge, type CardButton } from '../../src/bots/cards/decision';
import { RequestBody } from '../../src/bots/cards/request-card';
import { useRequestLookup } from '../../src/bots/cards/use-login-form';
import { useBots } from '../../src/bots/store';
import type { BotRequestDecision, BotRequestView } from '../../src/shared/bots';
import { useT } from '../../src/lib/i18n';
import { space } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { SheetClose } from '../../src/ui/sheet-chrome';

export default function RequestSheet() {
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
  const router = useRouter();
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
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: space.margin, paddingBottom: space.xxxl }}
    >
      <CardFrame
        icon={CARD_ICON[cardKind(request)]}
        title={tr(t, cardTitle(request, name))}
        badge={{ label: t(badge.key), tone: badge.tone }}
        settled={!pending}
        footer={
          pending ? (
            <>
              <Countdown request={request} />
              <DecisionBar request={request} name={name} busy={busy} onPress={onPress} />
            </>
          ) : undefined
        }
      >
        <RequestBody request={request} sessionId={sessionId} name={name} full />
      </CardFrame>
    </ScrollView>
  );
}
