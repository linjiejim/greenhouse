/**
 * The thread's message rows — thin wrappers that hand Bots rows to the chat's
 * renderers (./adapters.ts) and keep them memoised on their *source* objects:
 * the engine shares structure, so while a reply streams only the row whose
 * message / segment / send / card changed re-renders.
 *
 *  - `UserRow` — a member message (copy only: Bots messages can't be edited).
 *  - `BotRow` — a persisted Bot reply under its speaker line (on a change of
 *    speaker), its memory receipts, and — under the main Bot's greeting — the
 *    naming hint. Answers from its cards go back to that Bot (D22). A
 *    server placeholder for a turn with no text is left out while the tool
 *    steps are hidden (../filler.ts).
 *  - `SegmentRow` — a live turn, quiet until it has something to show: no
 *    thinking row and no speaker line while the Bot is still thinking (the
 *    title says "Thinking…"), so a send isn't followed by a face that comes
 *    and goes; with the first words the speaker line arrives, its plant
 *    talking. A failed turn offers Retry ("@Name Please try that again.").
 *    Both rows draw nothing at all for a turn with nothing on screen.
 *  - `PendingRow` — a send in flight with its Messages-style caption.
 *  - `RequestRow` — a "needs you" card (`RequestCard`); one the thread holds
 *    no state for (an old card past the detail window) reads as its line.
 */

import React, { memo, useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { AiMessage, UserMessage, type MessageAction } from '../../../chat/message';
import type { ChatMessage } from '../../../chat/model';
import type { BotMessage, BotRequestDecision, BotRequestView, BotView } from '../../../shared/bots';
import type { BotStreamSegment } from '../../../shared/bots-wire';
import { RequestCard } from '../../cards/request-card';
import type { DecideOutcome, MobilePending, ThreadController } from '../../contract';
import { memoryReceiptsFromCalls } from '../../vendor/web-helpers';
import { usePrefs } from '../../../store/prefs';
import { fromBotMessage, fromPending } from '../adapters';
import { isFillerReply } from '../filler';
import { EventRow } from './event-row';
import { MemoryReceipts } from './memory-receipts';
import { PendingCaption } from './pending-caption';
import { SpeakerLine } from './speaker-line';
import { SproutyNameHint } from './sprouty-name';

const noop = () => {};

/** What a reply row hands back to the screen (stable callbacks — the rows are memoised). */
export interface ReplyHandlers {
  onOpenTools: (msg: ChatMessage) => void;
  onOpenReasoning: (msg: ChatMessage) => void;
  onOpenRefs: (msg: ChatMessage) => void;
  onAction: (msg: ChatMessage, action: MessageAction) => void;
}

/** Shared props of the Bot reply rows (all stable). */
export interface ReplyRowProps {
  readOnly: boolean;
  loaded: boolean;
  /** The server's memory statuses (receipts undone elsewhere read undone). */
  memoryStates: Readonly<Record<string, string>>;
  handlers: ReplyHandlers;
  /** An answer from a card in a Bot's reply (ask_user, confirm) — addressed to that Bot. */
  onReplyAs: (botId: string | null, text: string) => Promise<boolean>;
  onOpenProfile: (botId: string) => void;
}

export const UserRow = memo(function UserRow({
  message,
  readOnly,
  onAction,
}: {
  message: BotMessage;
  readOnly: boolean;
  onAction: (msg: ChatMessage, action: MessageAction) => void;
}) {
  // Bots messages can't be edited (the server answers 409) — copy only.
  return <UserMessage msg={fromBotMessage(message)} readOnly={readOnly} onAction={onAction} allowEdit={false} />;
});

export const BotRow = memo(function BotRow({
  message,
  botId,
  header,
  bot,
  followUp,
  readOnly,
  loaded,
  memoryStates,
  handlers,
  onReplyAs,
  onOpenProfile,
  nameHint,
  onRename,
}: ReplyRowProps & {
  message: BotMessage;
  botId: string | null;
  header: boolean;
  bot: BotView | undefined;
  followUp?: string;
  /** Under the main Bot's greeting while it still has its built-in name (./rows/sprouty-name.tsx). */
  nameHint?: BotView;
  onRename?: (botId: string) => void;
}) {
  const onReply = useCallback((text: string) => onReplyAs(botId, text), [onReplyAs, botId]);
  const receipts = useMemo(
    () => memoryReceiptsFromCalls(message.pipeline.map((step) => ({ name: step.tool, output: step.output }))),
    [message],
  );
  // A placeholder for a turn with no text ("Over to you — see the card above") points at what is
  // right above it; with the tool steps hidden it says nothing new (./../filler.ts).
  const showTools = usePrefs((s) => s.details.tools);
  const speaker = useMemo(
    () => (header ? <SpeakerLine bot={bot} loaded={loaded} onPress={onOpenProfile} /> : null),
    [header, bot, loaded, onOpenProfile],
  );
  if (!showTools && receipts.length === 0 && isFillerReply(message.content)) return null;
  return (
    <View>
      <AiMessage
        quiet
        header={speaker}
        msg={fromBotMessage(message)}
        isLatest={false}
        readOnly={readOnly}
        followUp={followUp}
        onOpenTools={handlers.onOpenTools}
        onOpenReasoning={handlers.onOpenReasoning}
        onOpenRefs={handlers.onOpenRefs}
        onAction={handlers.onAction}
        onRetry={noop}
        onReply={onReply}
        allowRegenerate={false}
      />
      <MemoryReceipts
        receipts={receipts}
        botId={botId}
        botName={bot?.name}
        memoryStates={memoryStates}
        readOnly={readOnly}
      />
      {nameHint && onRename ? <SproutyNameHint bot={nameHint} onRename={onRename} /> : null}
    </View>
  );
});

/** One Bot's live turn: its speaker line (on a change of speaker) and the reply as it streams. */
export const SegmentRow = memo(function SegmentRow({
  segment,
  msg,
  header,
  bot,
  askedBy,
  readOnly,
  loaded,
  memoryStates,
  handlers,
  onReplyAs,
  onRetryBot,
  onOpenProfile,
}: ReplyRowProps & {
  segment: BotStreamSegment;
  /** The segment as a reply (./adapters.ts `fromSegment` — its id is unique across runs). */
  msg: ChatMessage;
  header: boolean;
  bot: BotView | undefined;
  askedBy: string | null;
  onRetryBot: (botId: string) => void;
}) {
  const botId = segment.botId;
  const onReply = useCallback((text: string) => onReplyAs(botId, text), [onReplyAs, botId]);
  const onRetry = useCallback(() => onRetryBot(botId), [onRetryBot, botId]);
  const live = segment.status === 'streaming';
  const failed = segment.status === 'error';
  const typing = live && segment.text.length > 0;
  const speaker = useMemo(
    () =>
      header ? (
        <SpeakerLine
          bot={bot}
          loaded={loaded}
          askedBy={askedBy}
          state={failed ? 'error' : typing ? 'speaking' : live ? 'thinking' : undefined}
          animate={live}
          onPress={onOpenProfile}
        />
      ) : null,
    [header, bot, loaded, askedBy, failed, typing, live, onOpenProfile],
  );
  const receipts = useMemo(
    () =>
      memoryReceiptsFromCalls(
        segment.toolCalls
          .filter((call) => call.status === 'done')
          .map((call) => ({ name: call.name, output: call.output })),
      ),
    [segment],
  );
  return (
    <View>
      <AiMessage
        quiet
        header={speaker}
        msg={msg}
        isLatest
        readOnly={readOnly}
        onOpenTools={handlers.onOpenTools}
        onOpenReasoning={handlers.onOpenReasoning}
        onOpenRefs={handlers.onOpenRefs}
        onAction={handlers.onAction}
        onRetry={onRetry}
        onReply={onReply}
        allowRegenerate={false}
      />
      <MemoryReceipts
        receipts={receipts}
        botId={botId}
        botName={bot?.name}
        memoryStates={memoryStates}
        readOnly={readOnly}
      />
    </View>
  );
});

export const PendingRow = memo(function PendingRow({
  pending,
  runActive,
  upNext,
  onAction,
  onHandleNow,
  onRetry,
  onDiscard,
}: {
  pending: MobilePending;
  runActive: boolean;
  upNext: boolean;
  onAction: (msg: ChatMessage, action: MessageAction) => void;
  onHandleNow: (clientId: string) => void;
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
}) {
  const footer = useMemo(
    () => (
      <PendingCaption
        pending={pending}
        runActive={runActive}
        upNext={upNext}
        onHandleNow={onHandleNow}
        onRetry={onRetry}
        onDiscard={onDiscard}
      />
    ),
    [pending, runActive, upNext, onHandleNow, onRetry, onDiscard],
  );
  return <UserMessage msg={fromPending(pending)} readOnly onAction={onAction} allowEdit={false} footer={footer} />;
});

/** A "needs you" card; one the thread has no state for (an old card past the detail window) reads as its line. */
export const RequestRow = memo(function RequestRow({
  request,
  fallback,
  sessionId,
  readOnly,
  highlighted,
  ctl,
  onAskAgain,
}: {
  request: BotRequestView | undefined;
  fallback: BotMessage | null;
  sessionId: string;
  readOnly: boolean;
  highlighted: boolean;
  ctl: ThreadController;
  onAskAgain: (botId: string) => void;
}) {
  const onDecide = useCallback(
    (body: BotRequestDecision): Promise<DecideOutcome> =>
      request ? ctl.decide(request, body) : Promise.resolve<DecideOutcome>({ kind: 'stale' }),
    [ctl, request],
  );
  if (!request) {
    return fallback ? (
      <EventRow
        message={fallback}
        event={fallback.bot_event}
        failedBotName={null}
        canAct={false}
        busy={false}
        onRetry={noop}
        onContinue={noop}
        onViewSummary={noop}
      />
    ) : null;
  }
  return (
    <RequestCard
      request={request}
      sessionId={sessionId}
      readOnly={readOnly}
      highlighted={highlighted}
      onDecide={onDecide}
      onAskAgain={readOnly ? undefined : onAskAgain}
    />
  );
});
