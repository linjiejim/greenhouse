/**
 * "Needs you" cards in the transcript — approvals, sign-in, take-over, a Bot
 * proposing a new Bot, a background task waiting for "Start".
 *
 * All on the shared ArtifactCard skeleton: pending cards are open with their
 * actions; settled ones collapse to a one-line receipt (expandable), and an
 * expired one offers "Ask again". What a card shows about the target (origin,
 * page, tool inputs) is server-derived — never the model's own description.
 */

import { useState } from 'react';
import type {
  BotApprovalPayload,
  BotRequestView,
  BotTakeoverPayload,
  BotTaskStartPayload,
} from '@greenhouse/types/bots';
import { ArtifactCard, ArtifactCardActions } from '../chat/artifact-card';
import { Button } from '../ui';
import { Info, ListTodo, Monitor, ShieldCheck } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { RichMarkdown } from '../rich-markdown';
import type { BotMessage } from '../../lib/api/bots';
import { LoginRequestCard } from './login-request-card';
import { BotCreateCard } from './bot-create-card';
import { implicitTakeover, useRequestDecision, type RequestCardCallbacks } from './request-decision';
import { DetailList, ExpiredFooter, useSettledStatus } from './request-card-parts';
import type { BotLookup } from './transcript-rows';

export interface RequestCardProps extends RequestCardCallbacks {
  request: BotRequestView | undefined;
  /** The transcript row that marks the card's place (for an old card the API no longer returns). */
  fallback: BotMessage | null;
  lookup: BotLookup;
  vaultAvailable: boolean;
  onOpenComputer: () => void;
  onAskAgain: (botId: string) => void;
}

export function RequestCard(props: RequestCardProps) {
  const { request, fallback } = props;
  if (!request) {
    // Settled long ago and outside the API's recent window: the row's text is the record.
    return fallback?.content ? (
      <div className="flex justify-center px-2 text-[11px] text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <Info size={12} aria-hidden="true" />
          {fallback.content}
        </span>
      </div>
    ) : null;
  }
  return (
    <div className="max-w-[min(36rem,100%)]" data-testid="bots-request-card" data-request-kind={request.kind}>
      {request.kind === 'login' && <LoginRequestCard {...props} request={request} />}
      {request.kind === 'bot_create' && <BotCreateCard {...props} request={request} />}
      {request.kind === 'approval' && <ApprovalCard {...props} request={request} />}
      {request.kind === 'takeover' && <TakeoverCard {...props} request={request} />}
      {request.kind === 'task_start' && <TaskStartCard {...props} request={request} />}
    </div>
  );
}

type KnownRequestProps = RequestCardProps & { request: BotRequestView };

function ApprovalCard({ request, lookup, onSettled, onStale, onAskAgain }: KnownRequestProps) {
  const t = useT();
  const payload = request.payload as BotApprovalPayload;
  const name = lookup(request.bot_id)?.name ?? t('bots.deletedBot');
  const { busy, decide } = useRequestDecision(request, { onSettled, onStale });
  const { pending, expired, status } = useSettledStatus(request);
  const [open, setOpen] = useState(false);

  return (
    <ArtifactCard
      icon={<ShieldCheck size={14} />}
      title={t('bots.requests.approvalTitle', { name })}
      meta={payload.title}
      status={status}
      tone={pending ? 'accent' : 'neutral'}
      collapsed={!pending && !expired && !open}
      onToggle={pending || expired ? undefined : () => setOpen((value) => !value)}
      footer={
        pending ? (
          <ArtifactCardActions>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide({ decision: 'deny' })}>
              {t('bots.requests.deny')}
            </Button>
            {payload.allow_always && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide({ decision: 'always' })}>
                {t('bots.requests.allowAlways')}
              </Button>
            )}
            <Button size="sm" disabled={busy} onClick={() => void decide({ decision: 'approve' })}>
              {t('bots.requests.allowOnce')}
            </Button>
          </ArtifactCardActions>
        ) : (
          <ExpiredFooter request={request} onAskAgain={onAskAgain} />
        )
      }
    >
      <DetailList rows={payload.details ?? []} />
    </ArtifactCard>
  );
}

function TakeoverCard({ request, lookup, onSettled, onStale, onOpenComputer }: KnownRequestProps) {
  const t = useT();
  const payload = request.payload as BotTakeoverPayload;
  const implicit = implicitTakeover(request.payload);
  const name = lookup(request.bot_id)?.name ?? t('bots.deletedBot');
  const { busy, decide } = useRequestDecision(request, { onSettled, onStale });
  const { pending, status } = useSettledStatus(request);

  // "Done" on the card is the hand-back for this request: the server returns
  // the lease, settles it and wakes the Bot (same as Done in the computer pane).
  const handBack = (
    <Button size="sm" disabled={busy} onClick={() => void decide({ decision: 'approve' })}>
      {implicit ? t('bots.requests.handBackContinue', { name }) : t('bots.requests.handBack')}
    </Button>
  );

  if (implicit) {
    // Raised by the computer itself, not asked for by the Bot: the member took
    // over mid-action, or holds the computer while the Bot needs it.
    const rows = [
      ...(implicit.title ? [{ label: t('bots.requests.page'), value: implicit.title }] : []),
      ...(implicit.host ? [{ label: t('bots.requests.site'), value: implicit.host }] : []),
    ];
    return (
      <ArtifactCard
        icon={<Monitor size={14} />}
        title={t(
          implicit.reason === 'waiting'
            ? 'bots.requests.implicitWaitingTitle'
            : 'bots.requests.implicitInterruptedTitle',
          { name },
        )}
        status={status}
        tone={pending ? 'accent' : 'neutral'}
        // Settled or expired: a one-line receipt — there is nothing left to do here.
        collapsed={!pending}
        footer={
          pending ? (
            <ArtifactCardActions hint={t('bots.requests.implicitHint', { name })}>
              <Button size="sm" variant="outline" onClick={onOpenComputer}>
                {t('bots.requests.openComputerShort')}
              </Button>
              {handBack}
            </ArtifactCardActions>
          ) : undefined
        }
      >
        <DetailList rows={rows} />
      </ArtifactCard>
    );
  }

  return (
    <ArtifactCard
      icon={<Monitor size={14} />}
      title={t('bots.requests.takeoverTitle', { name })}
      meta={payload.reason}
      status={status}
      tone={pending ? 'accent' : 'neutral'}
      // Expired (no one took over in time) collapses like a settled card: no actions left.
      collapsed={!pending}
      footer={
        pending ? (
          <ArtifactCardActions hint={t('bots.requests.handBackHint', { name })}>
            <Button size="sm" variant="outline" onClick={onOpenComputer}>
              {t('bots.requests.takeOver')}
            </Button>
            {handBack}
          </ArtifactCardActions>
        ) : undefined
      }
    >
      {payload.url && <DetailList rows={[{ label: t('bots.requests.page'), value: payload.url }]} />}
    </ArtifactCard>
  );
}

function TaskStartCard({ request, lookup, onSettled, onStale, onAskAgain }: KnownRequestProps) {
  const t = useT();
  const payload = request.payload as BotTaskStartPayload;
  const name = lookup(request.bot_id)?.name ?? t('bots.deletedBot');
  const { busy, decide } = useRequestDecision(request, { onSettled, onStale });
  const { pending, expired, status } = useSettledStatus(request);
  const [open, setOpen] = useState(false);

  return (
    <ArtifactCard
      icon={<ListTodo size={14} />}
      title={t('bots.requests.taskTitle', { name })}
      meta={payload.title}
      status={status}
      tone={pending ? 'accent' : 'neutral'}
      collapsed={!pending && !expired && !open}
      onToggle={pending || expired ? undefined : () => setOpen((value) => !value)}
      footer={
        pending ? (
          <ArtifactCardActions>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide({ decision: 'deny' })}>
              {t('bots.requests.cancel')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void decide({ decision: 'approve' })}>
              {t('bots.requests.start')}
            </Button>
          </ArtifactCardActions>
        ) : (
          <ExpiredFooter request={request} onAskAgain={onAskAgain} />
        )
      }
    >
      {payload.brief && (
        <div className="max-h-48 overflow-y-auto text-xs">
          <RichMarkdown content={payload.brief} compact linkTarget="new-window" />
        </div>
      )}
    </ArtifactCard>
  );
}
