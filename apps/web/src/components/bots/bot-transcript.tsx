/**
 * The Bots message list. Reuses Chat's renderers (MessageBubble for persisted
 * turns, StreamingMessageBubble for live ones, ToolCallRenderer inside them)
 * and adds only what several speakers need: a speaker header on change,
 * hand-off strips, system events, request cards and memory receipts.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BotRequestView, BotView } from '@greenhouse/types/bots';
import { botTemplate } from '@greenhouse/types/bots';
import { MessageBubble } from '../chat/message';
import { Button, Spinner } from '../ui';
import { AlertTriangle, ArrowDown, X } from '../../lib/icons';
import { useI18n } from '../../lib/i18n';
import type { BotStreamSegment } from '../../lib/session-manager';
import type { BotMessage } from '../../lib/api/bots';
import { MemoryReceipts, memoryReceiptsFromCalls } from './memory-receipts';
import { RequestCard } from './request-card';
import { LiveSegment } from './live-segment';
import { buildTranscript, type PendingSend, type TranscriptItem } from './transcript';
import {
  ConversationIntro,
  EventRow,
  HandoffStrip,
  PendingBubble,
  SpeakerHeader,
  TaskReportRow,
  type BotLookup,
} from './transcript-rows';

/** Pixels from the bottom that still count as "following along". */
const STICK_THRESHOLD = 96;

export interface BotTranscriptProps {
  sessionId: string;
  kind: 'direct' | 'group';
  title: string;
  ownerBotId: string | null;
  members: BotView[];
  lookup: BotLookup;
  messages: BotMessage[];
  hasMore: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  segments: BotStreamSegment[];
  liveRequests: BotRequestView[];
  pending: PendingSend[];
  requests: Map<string, BotRequestView>;
  /** Server-reported status of the memories receipts name (undone ones stay undone after a reload). */
  memoryStates?: Readonly<Record<string, string>>;
  busy: boolean;
  /** Nobody here can reply any more: no starters, and no one-click lines that would address a Bot. */
  readOnly?: boolean;
  /** The computer is waking for this run — said under the live reply, not just in the header. */
  computerNotice?: 'starting' | 'queued' | null;
  runError: string | null;
  onDismissRunError: () => void;
  vaultAvailable: boolean;
  onRequestSettled: (request: BotRequestView) => void;
  onStale: () => void;
  onOpenComputer: () => void;
  onViewSummary: () => void;
  /** Address one Bot with a fixed line ("try again", "please continue"). */
  onAddress: (botId: string | null, text: 'retry' | 'continue') => void;
  /**
   * Free text from an ask_user form / confirm block in a Bot's reply. Rejects
   * when it was not delivered (already reported) — the form re-arms.
   */
  onSendText: (text: string) => Promise<void>;
  /** Prefill (never send) the composer — greeting starters. */
  onStarter: (text: string) => void;
  /** A speaker header opens that Bot's profile. */
  onOpenProfile?: (botId: string) => void;
}

export function BotTranscript(props: BotTranscriptProps) {
  const { t, locale } = useI18n();
  const {
    sessionId,
    kind,
    title,
    ownerBotId,
    members,
    lookup,
    messages,
    hasMore,
    loadingEarlier,
    onLoadEarlier,
    segments,
    liveRequests,
    pending,
    requests,
    memoryStates,
    busy,
    readOnly = false,
    computerNotice = null,
    runError,
    onDismissRunError,
    vaultAvailable,
    onRequestSettled,
    onStale,
    onOpenComputer,
    onViewSummary,
    onAddress,
    onSendText,
    onStarter,
    onOpenProfile,
  } = props;

  const items = useMemo(
    () =>
      buildTranscript({
        messages,
        conversationKind: kind,
        ownerBotId,
        segments,
        liveRequests,
        pending,
        requests,
      }),
    [kind, liveRequests, messages, ownerBotId, pending, requests, segments],
  );

  // ── Stick to the bottom while the member is following along ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    atBottomRef.current = next;
    setAtBottom(next);
  }, []);
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);
  useLayoutEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [items, scrollToBottom]);
  useEffect(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    scrollToBottom();
  }, [sessionId, scrollToBottom]);

  // Starters only while the greeting is still the last word.
  const lastItem = items[items.length - 1];
  const starters = useMemo(() => {
    if (readOnly) return [];
    if (!lastItem || lastItem.kind !== 'bot' || lastItem.message.bot_event?.kind !== 'greeting') return [];
    const bot = lookup(lastItem.botId);
    const template = botTemplate(bot?.template_key);
    return template ? template.copy[locale === 'zh' ? 'zh' : 'en'].starters : [];
  }, [lastItem, locale, lookup, readOnly]);
  // A read-only conversation offers nothing that would address a Bot.
  const actionsLocked = busy || readOnly;

  const renderItem = (item: TranscriptItem, index: number) => {
    switch (item.kind) {
      case 'user':
        return (
          <MessageBubble
            role="user"
            content={item.message.content}
            messageId={item.message.id}
            sessionId={sessionId}
            images={item.message.images}
            createdAt={item.message.created_at}
          />
        );
      case 'bot': {
        const bot = lookup(item.botId);
        const name = bot?.name ?? t('bots.deletedBot');
        const next = items[index + 1];
        return (
          <div>
            {item.header && <SpeakerHeader bot={bot} fallbackName={name} onOpenProfile={onOpenProfile} />}
            <MessageBubble
              role="assistant"
              content={item.message.content}
              messageId={item.message.id}
              sessionId={sessionId}
              reasoning={item.message.reasoning}
              pipeline={item.message.pipeline}
              references={item.message.references}
              images={item.message.images}
              model={item.message.model}
              createdAt={item.message.created_at}
              onAskUserSubmit={onSendText}
              onConfirmAction={readOnly ? undefined : onSendText}
              hasFollowUpUserMessage={next?.kind === 'user' || next?.kind === 'pending'}
              submittedUserMessage={next?.kind === 'user' ? next.message.content : undefined}
              confirmedActionValue={next?.kind === 'user' ? next.message.content : undefined}
            />
            <MemoryReceipts
              receipts={memoryReceiptsFromCalls(
                item.message.pipeline.map((step) => ({ name: step.tool, output: step.output })),
              )}
              botId={item.botId}
              botName={name}
              memoryStates={memoryStates}
            />
          </div>
        );
      }
      case 'segment':
        return (
          <LiveSegment
            segment={item.segment}
            header={item.header}
            lookup={lookup}
            onAddress={onAddress}
            onOpenProfile={onOpenProfile}
            busy={actionsLocked}
          />
        );
      case 'handoff':
        return <HandoffStrip handoff={item.handoff} lookup={lookup} />;
      case 'event':
        if (item.event?.kind === 'task_report' && item.message.content) {
          return <TaskReportRow message={item.message} event={item.event} lookup={lookup} />;
        }
        return (
          <EventRow
            message={item.message}
            event={item.event}
            lookup={lookup}
            busy={actionsLocked}
            onRetry={(botId) => onAddress(botId, 'retry')}
            onContinue={() => onAddress(null, 'continue')}
            onViewSummary={onViewSummary}
          />
        );
      case 'request':
        return (
          <RequestCard
            request={requests.get(item.requestId)}
            fallback={item.message}
            lookup={lookup}
            vaultAvailable={vaultAvailable}
            onSettled={onRequestSettled}
            onStale={onStale}
            onOpenComputer={onOpenComputer}
            onAskAgain={(botId) => onAddress(botId, 'retry')}
          />
        );
      case 'pending':
        return <PendingBubble pending={item.pending} />;
    }
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto overscroll-contain"
        data-testid="bots-transcript"
      >
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-3 pb-6 pt-2 md:px-6">
          {hasMore ? (
            <div className="flex justify-center pt-2">
              <Button size="sm" variant="ghost" disabled={loadingEarlier} onClick={onLoadEarlier}>
                {loadingEarlier && <Spinner className="mr-1.5 h-3 w-3" />}
                {t('bots.transcript.loadEarlier')}
              </Button>
            </div>
          ) : (
            <ConversationIntro kind={kind} title={title} bots={members} />
          )}
          {items.map((item, index) => (
            <div key={item.key} data-transcript-kind={item.kind}>
              {renderItem(item, index)}
            </div>
          ))}
          {starters.length > 0 && (
            <div className="flex flex-col gap-1.5" data-testid="bots-starters">
              <span className="text-[11px] text-fg-faint">{t('bots.transcript.starters')}</span>
              <div className="flex flex-wrap gap-1.5">
                {starters.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => onStarter(starter)}
                    className="rounded-full border border-edge bg-surface-raised px-3 py-1.5 text-xs text-fg-secondary transition-colors hover:border-primary-edge hover:bg-primary-subtle hover:text-primary-fg-strong"
                  >
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          )}
          {busy && computerNotice && (
            <p
              className="flex items-center gap-2 text-[11px] text-fg-muted"
              role="status"
              data-testid="bots-computer-notice"
            >
              <Spinner className="h-3 w-3" />
              {t(computerNotice === 'queued' ? 'bots.transcript.computerQueued' : 'bots.transcript.computerStarting')}
            </p>
          )}
          {runError && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-subtle px-3 py-2 text-xs text-danger">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{t('bots.transcript.runFailed', { reason: runError })}</span>
              <button type="button" onClick={onDismissRunError} aria-label={t('bots.transcript.dismiss')}>
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
      {!atBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-edge bg-surface-raised px-3 py-1.5 text-xs text-fg-secondary shadow-md transition-colors hover:bg-surface-muted"
          >
            <ArrowDown size={12} aria-hidden="true" />
            {t('bots.transcript.jumpToLatest')}
          </button>
        </div>
      )}
    </div>
  );
}
