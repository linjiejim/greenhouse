/**
 * Small transcript rows of a Bots conversation: the speaker header, the
 * hand-off strip, system event lines, a send in flight, and the thread start.
 *
 * Deliberately quiet. Bots talk in the flush Chat style; everything here is
 * scaffolding around that talk, so it stays small, centered and muted, and
 * only a row that needs a decision (retry, continue) carries a button.
 */

import type { BotEvent, BotRequestKind, BotView } from '@greenhouse/types/bots';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  CheckCircle2,
  Info,
  Lock,
  LogOut,
  Monitor,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  UserPlus,
  XCircle,
  type LucideIcon,
} from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import type { BotMessage } from '../../lib/api/bots';
import { splitAttachments } from '../blocks';
import { RichMarkdown } from '../rich-markdown';
import { AttachmentsBlock } from '../blocks/attachments-block';
import { BotAvatar, BotAvatarStack } from './bot-avatar';
import type { Handoff, PendingSend } from './transcript';

export type BotLookup = (botIdOrName: string | null | undefined) => BotView | undefined;

/** A text-weight action inside a one-line row (a full Button would outweigh the line it belongs to). */
export function InlineAction({
  onClick,
  disabled,
  testId,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="inline-flex min-h-6 items-center gap-1 rounded px-1 font-medium text-primary-fg-strong transition-colors hover:bg-primary-subtle disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/**
 * Static avatar + name, shown only when the speaker changes. With
 * `onOpenProfile`, a known Bot's header opens its profile (who it is, what it
 * remembers) — the same drawer as the info panel's member list.
 */
export function SpeakerHeader({
  bot,
  fallbackName,
  onOpenProfile,
}: {
  bot: BotView | undefined;
  fallbackName: string;
  onOpenProfile?: (botId: string) => void;
}) {
  const t = useT();
  const name = bot?.name ?? fallbackName;
  const body = (
    <>
      <BotAvatar bot={bot} size="xs" />
      <span className="truncate text-xs font-semibold text-fg-secondary" data-testid="bots-speaker">
        {name}
      </span>
      {bot?.role && <span className="hidden truncate text-[10px] text-fg-faint sm:inline">{bot.role}</span>}
    </>
  );
  if (bot && onOpenProfile) {
    return (
      <button
        type="button"
        onClick={() => onOpenProfile(bot.id)}
        aria-label={t('bots.profile.open', { name })}
        title={bot.role || undefined}
        className="mb-1 -ml-1 flex max-w-full items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-surface-sunken"
      >
        {body}
      </button>
    );
  }
  return (
    <div className="mb-1 flex items-center gap-2" title={bot?.role || undefined}>
      {body}
    </div>
  );
}

/** `team.ask`: one Bot hands work to another, visible so the member can follow the relay. */
export function HandoffStrip({ handoff, lookup }: { handoff: Handoff; lookup: BotLookup }) {
  const t = useT();
  const from = lookup(handoff.from);
  const to = lookup(handoff.to);
  const fromName = from?.name ?? t('bots.deletedBot');
  const toName = to?.name ?? handoff.to;
  const label = `${fromName} → @${toName}${handoff.text ? `: ${handoff.text}` : ''}`;
  return (
    <div className="flex justify-center px-2" role="note" aria-label={t('bots.transcript.handoff')}>
      <div
        className="flex min-w-0 max-w-[min(36rem,100%)] items-center gap-1.5 rounded-full border border-edge bg-surface-sunken px-2.5 py-1 text-[11px] text-fg-muted"
        title={label}
      >
        <BotAvatar bot={from} size="xs" />
        <span className="flex-shrink-0 font-semibold text-fg-secondary">{fromName}</span>
        <ArrowRight size={11} className="flex-shrink-0 text-fg-faint" aria-hidden="true" />
        <span className="flex-shrink-0 font-semibold text-primary-fg-strong">@{toName}</span>
        {handoff.text && <span className="min-w-0 truncate">{handoff.text}</span>}
      </div>
    </div>
  );
}

const EVENT_ICON: Partial<Record<BotEvent['kind'], LucideIcon>> = {
  joined: UserPlus,
  created: Sparkles,
  left: LogOut,
  takeover_done: Monitor,
  takeover_released: Monitor,
  login_done: Lock,
  task_started: Play,
  limit: AlertTriangle,
  turn_error: AlertTriangle,
  // Nobody could answer (the Bot was archived) — the engine says so instead of going quiet.
  unavailable: Archive,
  stopped: Square,
};

/**
 * A later line about a card (its first row is the card itself): "Sign-in to
 * github.com skipped", a declined approval… — marked with the card's icon.
 */
const REQUEST_ICON: Record<BotRequestKind, LucideIcon> = {
  login: Lock,
  takeover: Monitor,
  approval: ShieldCheck,
  bot_create: Sparkles,
  task_start: Play,
};

/** A system line: who joined, what finished, what stopped — with the one action that helps. */
export function EventRow({
  message,
  event,
  lookup,
  onRetry,
  onContinue,
  onViewSummary,
  busy,
}: {
  message: BotMessage;
  event: BotEvent | null;
  lookup: BotLookup;
  onRetry: (botId: string) => void;
  onContinue: () => void;
  onViewSummary: () => void;
  /** A run is in progress — retrying now would only queue behind it. */
  busy: boolean;
}) {
  const t = useT();
  if (event?.kind === 'digest') {
    return (
      <div className="flex items-center gap-3 px-2 py-1 text-[11px] text-fg-faint" role="separator">
        <span className="h-px flex-1 bg-edge" />
        <span>{t('bots.transcript.summarized')}</span>
        <InlineAction onClick={onViewSummary}>{t('bots.transcript.viewSummary')}</InlineAction>
        <span className="h-px flex-1 bg-edge" />
      </div>
    );
  }

  const danger = event?.kind === 'turn_error' || (event?.kind === 'task_report' && event.status === 'failed');
  const Icon =
    event?.kind === 'task_report'
      ? event.status === 'succeeded'
        ? CheckCircle2
        : XCircle
      : event?.kind === 'request'
        ? (REQUEST_ICON[event.request_kind] ?? Info)
        : event
          ? (EVENT_ICON[event.kind] ?? Info)
          : Info;
  const failedBot = event?.kind === 'turn_error' ? lookup(event.bot_id) : undefined;
  const text =
    message.content ||
    (event?.kind === 'turn_error' ? t('bots.transcript.turnFailed', { name: failedBot?.name ?? '' }) : '');

  return (
    <div className="flex justify-center px-2" data-testid="bots-event" data-event-kind={event?.kind ?? 'system'}>
      <div
        className={`flex max-w-[min(40rem,100%)] flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-[11px] ${
          danger ? 'text-danger' : 'text-fg-muted'
        }`}
      >
        <Icon size={12} className="flex-shrink-0" aria-hidden="true" />
        <span className="min-w-0">{text}</span>
        {event?.kind === 'turn_error' && failedBot && (
          <InlineAction disabled={busy} onClick={() => onRetry(event.bot_id)}>
            <RotateCcw size={11} aria-hidden="true" />
            {t('bots.transcript.retry')}
          </InlineAction>
        )}
        {event?.kind === 'limit' && (
          <InlineAction disabled={busy} onClick={onContinue}>
            {t('bots.transcript.continue')}
          </InlineAction>
        )}
      </div>
    </div>
  );
}

type TaskReportEvent = Extract<BotEvent, { kind: 'task_report' }>;

const TASK_STATUS: Record<TaskReportEvent['status'], { icon: LucideIcon; tone: string; label: TranslationKey }> = {
  succeeded: { icon: CheckCircle2, tone: 'text-success', label: 'bots.transcript.taskSucceeded' },
  failed: { icon: XCircle, tone: 'text-danger', label: 'bots.transcript.taskFailed' },
  canceled: { icon: Square, tone: 'text-fg-muted', label: 'bots.transcript.taskCanceled' },
};

/**
 * A background task's report: the Bot speaking after working on its own, so
 * it reads like the Bot's message (markdown, tables, links) inside a card that
 * says which task it closes — not a one-line system event.
 */
export function TaskReportRow({
  message,
  event,
  lookup,
}: {
  message: BotMessage;
  event: TaskReportEvent;
  lookup: BotLookup;
}) {
  const t = useT();
  const bot = lookup(event.bot_id);
  const status = TASK_STATUS[event.status] ?? TASK_STATUS.failed;
  const StatusIcon = status.icon;
  return (
    <div className="px-1" data-testid="bots-task-report" data-status={event.status}>
      <div className="overflow-hidden rounded-xl border border-edge bg-surface-raised">
        <div className="flex min-w-0 items-center gap-2 border-b border-edge bg-surface-sunken px-3 py-2">
          <BotAvatar bot={bot} size="xs" />
          <span className="flex-shrink-0 text-xs font-semibold text-fg-secondary">
            {t('bots.transcript.taskReport', { name: bot?.name ?? t('bots.deletedBot') })}
          </span>
          <span className="min-w-0 truncate text-xs text-fg-muted" title={event.title}>
            {event.title}
          </span>
          <span
            className={`ml-auto inline-flex flex-shrink-0 items-center gap-1 text-[11px] font-medium ${status.tone}`}
          >
            <StatusIcon size={12} aria-hidden="true" />
            {t(status.label)}
          </span>
        </div>
        <div className="px-3 py-2 text-sm text-fg">
          <RichMarkdown content={message.content} compact />
        </div>
      </div>
    </div>
  );
}

/**
 * A member message the transcript has not confirmed yet. One delivered while
 * Bots work waits for the current reply; "Handle now" (`onHandleNow`, offered
 * while a run is going) lets the current step finish and reads it next.
 */
export function PendingBubble({
  pending,
  onHandleNow,
  interrupting = false,
}: {
  pending: PendingSend;
  onHandleNow?: () => void;
  /** The run already stops after the current step (a soft stop, or "Handle now" on another message). */
  interrupting?: boolean;
}) {
  const t = useT();
  // The attachments fence renders as chips, exactly as the persisted copy will.
  const { text, attachments } = splitAttachments(pending.content);
  const queued = pending.status === 'queued';
  const handlingNext = queued && (pending.nudged === true || interrupting);
  return (
    <div className="flex flex-col items-end gap-1 animate-fade-in" data-testid="bots-pending-send">
      <div className="max-w-[80%] rounded-2xl rounded-br-md border border-edge bg-surface-muted px-4 py-3 text-sm text-fg shadow-sm">
        {pending.images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pending.images.map((image) => (
              <img
                key={image.id}
                src={image.url}
                alt=""
                className="h-16 w-16 rounded-lg border border-edge object-cover"
              />
            ))}
          </div>
        )}
        {text && <p className="whitespace-pre-wrap break-words">{text}</p>}
        {attachments.length > 0 && (
          <div className={text ? 'mt-2' : ''}>
            <AttachmentsBlock data={attachments} />
          </div>
        )}
      </div>
      {pending.status !== 'sent' && (
        <span className="flex flex-wrap items-center justify-end gap-x-1 text-[10px] text-fg-faint">
          <span>
            {handlingNext
              ? t('bots.transcript.handlingNext')
              : queued
                ? t('bots.transcript.delivered')
                : t('bots.transcript.sending')}
          </span>
          {queued && !handlingNext && onHandleNow && (
            <span className="text-[11px]">
              <InlineAction onClick={onHandleNow} testId="bots-pending-handle-now">
                {t('bots.transcript.handleNow')}
              </InlineAction>
            </span>
          )}
        </span>
      )}
    </div>
  );
}

/** Thread start: who this is and what Bots are for — the positioning line lives here. */
export function ConversationIntro({ kind, title, bots }: { kind: 'direct' | 'group'; title: string; bots: BotView[] }) {
  const t = useT();
  const owner = bots[0];
  return (
    <div className="flex flex-col items-center gap-2 px-4 pb-4 pt-6 text-center">
      {kind === 'direct' && owner ? (
        // Static: in a transcript, motion means "this Bot is talking".
        <BotAvatar bot={owner} size="lg" animate={false} />
      ) : (
        // The transcript has no surface of its own: it sits on the canvas, so the chip ring does too
        // (the stack's default `surface-raised` ring is a visible halo on dark's darker canvas).
        <BotAvatarStack bots={bots} max={5} size="md" ringClassName="ring-surface-canvas" />
      )}
      <div>
        <p className="text-base font-semibold text-fg">{title}</p>
        {kind === 'direct' && owner?.role && <p className="text-xs text-fg-muted">{owner.role}</p>}
      </div>
      <p className="max-w-md text-xs leading-5 text-fg-faint">
        {kind === 'direct'
          ? t('bots.transcript.dmStart', { name: owner?.name ?? title })
          : t('bots.transcript.groupStart', { title })}{' '}
        {t('bots.positioning')}
      </p>
    </div>
  );
}
