/**
 * The thread's message rows — thin wrappers that hand Bots rows to the chat's
 * renderers (./adapters.ts) and keep them memoised on their *source* objects:
 * the engine shares structure, so while a reply streams only the row whose
 * message / segment / send / card changed re-renders.
 *
 *  - `UserRow` — a member message (copy only: Bots messages can't be edited).
 *  - `ReplyRow` — a Bot reply, live or persisted, as one component type so
 *    the persisted reply takes over the live row's instance when a run
 *    settles (no end-of-turn jump). Persisted: under its speaker line (on a
 *    change of speaker), its memory receipts, and — under the main Bot's
 *    greeting — the naming hint; a server placeholder for a turn with no text
 *    is left out while the tool steps are hidden (../filler.ts). Live: quiet
 *    until it has something to show — no thinking row and no speaker line
 *    while the Bot is still thinking (the title says "Thinking…"); with the
 *    first words the speaker line arrives, its plant talking. A failed turn
 *    offers Retry ("@Name Please try that again."). Answers from its cards go
 *    back to that Bot (D22). It draws nothing for a turn with nothing on
 *    screen.
 *  - `PendingRow` — a send in flight with its Messages-style caption.
 *  - `RequestRow` — a "needs you" card (`RequestCard`); one the thread holds
 *    no state for (an old card past the detail window) reads as its line.
 */

import React, { memo, useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { space } from '../../../theme';
import { AiMessage, UserMessage, type MessageAction } from '../../../chat/message';
import type { ChatMessage } from '../../../chat/model';
import type { BotMessage, BotRequestView, BotView } from '../../../shared/bots';
import type { BotStreamSegment } from '../../../shared/bots-wire';
import { RequestCard } from '../../cards/request-card';
import type { MobilePending } from '../../contract';
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

/**
 * A Bot's reply — live (`segment` + its `msg`) or persisted (`message`) — as ONE component type:
 * under the turn's stable key (../thread-rows.ts `stableTurnKeys`) the persisted reply takes over the
 * live row's instance when the run settles, so the text, its measured tables and its diagrams stay
 * put instead of mounting again (the end-of-turn jump). Props stay flat and stable — rows are memoised.
 *
 * Persisted: under its speaker line (on a change of speaker), its memory receipts and — under the main
 * Bot's greeting — the naming hint; a server placeholder for a turn with no text is left out while the
 * tool steps are hidden (../filler.ts). Live: quiet until it has something to show; with the first
 * words the speaker line arrives, its plant talking; a failed turn offers Retry.
 */
export const ReplyRow = memo(function ReplyRow({
  segment,
  msg,
  askedBy,
  onRetryBot,
  message,
  botId: persistedBotId,
  followUp,
  nameHint,
  onRename,
  header,
  bot,
  readOnly,
  loaded,
  memoryStates,
  handlers,
  onReplyAs,
  onOpenProfile,
}: ReplyRowProps & {
  header: boolean;
  bot: BotView | undefined;
  /** Live: the streaming turn, its reply (./adapters.ts `fromSegment` — id unique across runs), who asked. */
  segment?: BotStreamSegment;
  msg?: ChatMessage;
  askedBy?: string | null;
  onRetryBot?: (botId: string) => void;
  /** Persisted: the reply and who wrote it. */
  message?: BotMessage;
  botId?: string | null;
  followUp?: string;
  /** Under the main Bot's greeting while it still has its built-in name (./rows/sprouty-name.tsx). */
  nameHint?: BotView;
  onRename?: (botId: string) => void;
}) {
  const botId = segment ? segment.botId : (persistedBotId ?? null);
  const onReply = useCallback((text: string) => onReplyAs(botId, text), [onReplyAs, botId]);
  const onRetry = useCallback(() => {
    if (botId && onRetryBot) onRetryBot(botId);
  }, [botId, onRetryBot]);
  const streaming = segment?.status === 'streaming';
  const failed = segment?.status === 'error';
  const typing = streaming && (segment?.text.length ?? 0) > 0;
  const speaker = useMemo(
    () =>
      header ? (
        <SpeakerLine
          bot={bot}
          loaded={loaded}
          askedBy={segment ? askedBy : undefined}
          state={segment ? (failed ? 'error' : typing ? 'speaking' : streaming ? 'thinking' : undefined) : undefined}
          animate={streaming}
          onPress={onOpenProfile}
        />
      ) : null,
    [header, bot, loaded, segment, askedBy, failed, typing, streaming, onOpenProfile],
  );
  const shown = useMemo(() => msg ?? (message ? fromBotMessage(message) : undefined), [msg, message]);
  const receipts = useMemo(
    () =>
      memoryReceiptsFromCalls(
        segment
          ? segment.toolCalls
              .filter((call) => call.status === 'done')
              .map((call) => ({ name: call.name, output: call.output }))
          : (message?.pipeline ?? []).map((step) => ({ name: step.tool, output: step.output })),
      ),
    [segment, message],
  );
  // A placeholder for a turn with no text ("Over to you — see the card above") points at what is
  // right above it; with the tool steps hidden it says nothing new (./../filler.ts).
  const showTools = usePrefs((s) => s.details.tools);
  if (!shown) return null;
  if (!segment && message && !showTools && receipts.length === 0 && isFillerReply(message.content)) return null;
  return (
    <View>
      <AiMessage
        quiet
        header={speaker}
        msg={shown}
        isLatest={!!segment}
        readOnly={readOnly}
        followUp={followUp}
        onOpenTools={handlers.onOpenTools}
        onOpenReasoning={handlers.onOpenReasoning}
        onOpenRefs={handlers.onOpenRefs}
        onAction={handlers.onAction}
        onRetry={segment ? onRetry : noop}
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

/**
 * A "needs you" card — a summary that opens its sheet (../../cards/request-card.tsx), inset like
 * the replies around it; one the thread has no state for (an old card past the detail window)
 * reads as its line.
 */
export const RequestRow = memo(function RequestRow({
  request,
  fallback,
  sessionId,
  readOnly,
  highlighted,
  onAskAgain,
}: {
  request: BotRequestView | undefined;
  fallback: BotMessage | null;
  sessionId: string;
  readOnly: boolean;
  highlighted: boolean;
  onAskAgain: (botId: string) => void;
}) {
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
    <View style={{ paddingHorizontal: space.margin, paddingVertical: space.xs }}>
      <RequestCard
        request={request}
        sessionId={sessionId}
        readOnly={readOnly}
        highlighted={highlighted}
        onAskAgain={readOnly ? undefined : onAskAgain}
      />
    </View>
  );
});
