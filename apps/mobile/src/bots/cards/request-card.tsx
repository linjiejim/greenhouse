/**
 * `RequestCard` — a "needs you" card (approval, background task, proposed Bot,
 * instructions change, sign-in, take-over) with its decision buttons, the same
 * component in a thread and in the needs-you sheet (spec
 * docs/specs/20261008-mobile-bots.md §2.5.4; props: ../contract.ts
 * `RequestCardProps`).
 *
 * A pending card is open: headline, body (./approval.tsx …), the
 * last-minute countdown and the buttons (./decision.ts `cardButtons` — the
 * honest mapping). A settled one collapses to a one-line receipt
 * (./receipt.tsx) that opens back into the card, read-only. The card holds no
 * state about the decision itself: the host's merged copy of the request
 * (REST → live stream → this device's decisions, only ever forward) is the
 * truth, so a card decided in the needs-you sheet flips in the thread too.
 * A kind this version does not know renders a line (./unknown.tsx).
 *
 * `RequestBody` is the kind dispatch on its own, for the card sheet
 * (app/bots/request.tsx) to show a card in full.
 */

import React, { memo, useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import type { BotRequestView } from '../../shared/bots';
import { useT } from '../../lib/i18n';
import { NativeButton } from '../../ui/button';
import type { RequestCardProps } from '../contract';
import { ApprovalBody } from './approval';
import { BotCreateBody } from './bot-create';
import { CardFrame, DecisionBar, tr, useBotName, useCardActions } from './card-frame';
import { Countdown } from './countdown';
import { CARD_ICON, askAgainOffered, cardKind, cardTitle, statusBadge, type CardButton } from './decision';
import { InstructionsBody } from './instructions';
import { LoginBody } from './login-card';
import { Receipt } from './receipt';
import { TakeoverBody } from './takeover';
import { TaskStartBody } from './task-start';
import { UnknownBody } from './unknown';

/** A card's body by kind; `full` = the card sheet (everything, whole). */
export function RequestBody({
  request,
  sessionId,
  name,
  full = false,
  onAskAgain,
}: {
  request: BotRequestView;
  sessionId: string;
  /** The asking Bot's display name. */
  name: string;
  full?: boolean;
  /** A fresh ask after a refused sign-in (threads that can still send). */
  onAskAgain?: () => void;
}) {
  switch (cardKind(request)) {
    case 'approval':
      return <ApprovalBody request={request} sessionId={sessionId} full={full} />;
    case 'task_start':
      return <TaskStartBody request={request} full={full} />;
    case 'bot_create':
      return <BotCreateBody request={request} full={full} />;
    case 'instructions_update':
      return <InstructionsBody request={request} sessionId={sessionId} full={full} />;
    case 'login':
      return <LoginBody request={request} full={full} onAskAgain={onAskAgain} />;
    case 'handback':
    case 'captcha':
    case 'takeover':
      return <TakeoverBody request={request} name={name} full={full} />;
    default:
      return <UnknownBody />;
  }
}

export const RequestCard: React.NamedExoticComponent<RequestCardProps> = memo(function RequestCard({
  request,
  sessionId,
  readOnly,
  highlighted,
  onDecide,
  onAskAgain,
}: RequestCardProps) {
  const t = useT();
  const name = useBotName(request.bot_id);
  const kind = cardKind(request);
  const pending = request.status === 'pending';
  const { busy, press } = useCardActions({ request, sessionId, name, onDecide });
  // A settled card opened back up to read (this card instance only).
  const [open, setOpen] = useState(false);
  // Flip to the receipt with a fade only when it settled before the member's eyes.
  const sawPending = useRef(pending);
  const onPress = useCallback((button: CardButton) => void press(button), [press]);

  const botId = request.bot_id;
  // A read-only thread cannot send, so it cannot ask again (nor does the needs-you sheet).
  const askAgain = !readOnly && onAskAgain && botId ? () => onAskAgain(botId) : undefined;
  const reAsk = askAgainOffered(request) ? askAgain : undefined;

  if (!pending && kind !== 'unknown' && !open) {
    return (
      <Animated.View entering={sawPending.current ? FadeIn.duration(200) : undefined}>
        <Receipt request={request} highlighted={highlighted} onExpand={() => setOpen(true)} onAskAgain={reAsk} />
      </Animated.View>
    );
  }

  const badge = statusBadge(request);
  return (
    <CardFrame
      icon={CARD_ICON[kind]}
      title={tr(t, cardTitle(request, name))}
      badge={pending ? undefined : { label: t(badge.key), tone: badge.tone }}
      settled={!pending}
      highlighted={highlighted}
      onHeaderPress={!pending && kind !== 'unknown' ? () => setOpen(false) : undefined}
      headerHint={t('bots.card.showLess')}
      footer={
        pending ? (
          <>
            <Countdown request={request} />
            <DecisionBar request={request} busy={busy} onPress={onPress} />
          </>
        ) : reAsk ? (
          <View style={{ alignSelf: 'flex-end' }}>
            <NativeButton label={t('bots.card.askAgain')} onPress={reAsk} />
          </View>
        ) : undefined
      }
    >
      <RequestBody request={request} sessionId={sessionId} name={name} onAskAgain={askAgain} />
    </CardFrame>
  );
});
