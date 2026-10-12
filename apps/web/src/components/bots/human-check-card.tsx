/**
 * "Complete a human check" — the take-over card a Bot raises when a site puts
 * a CAPTCHA or a "verify you are human" page in its way (spec 20261007 §3.3,
 * §4.2). Bots never solve or bypass these; the member does, right on the card:
 *
 *   - the live screen is embedded, view only;
 *   - "Verify here" takes the computer over (POST /takeover) and the embedded
 *     screen becomes interactive;
 *   - when they are through, "I'm done" hands the computer back for this card
 *     and wakes the Bot — it then collapses like every other card.
 *
 * "Open computer" moves to the full pane (typing helpers, full screen);
 * "Skip" declines, which wakes the Bot to carry on without that site.
 *
 * The check is on the computer of the Agent that raised the card (each Agent has
 * its own): the page's computer status is used when it is that computer, the card
 * follows that computer itself otherwise (a guest's card in someone else's DM).
 */

import { useRef, useState, type ReactNode } from 'react';
import type { BotRequestView } from '@greenhouse/types/bots';
import { ArtifactCard, ArtifactCardActions } from '../chat/artifact-card';
import { Button, Skeleton, Spinner, toast } from '../ui';
import { Monitor, ShieldCheck } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { takeoverComputer } from '../../lib/api/bots';
import { computerErrorText } from './computer-pane';
import { computerBotFor, phaseLabelKey, useComputerStatus, type ComputerStatusState } from './computer-phase';
import { ComputerScreen, type ComputerScreenHandle } from './computer-screen';
import { DetailList, useSettledStatus } from './request-card-parts';
import { useRequestDecision, type RequestCardCallbacks } from './request-decision';
import type { BotLookup } from './transcript-rows';

/** What a card needs of the page's computer status (`useComputerStatus`) — `bot` says whose computer it is. */
export type RequestCardComputer = Pick<ComputerStatusState, 'bot' | 'phase' | 'apply' | 'refresh'>;

export interface HumanCheckCardProps extends RequestCardCallbacks {
  request: BotRequestView;
  check: { reason: string; url: string | null };
  lookup: BotLookup;
  /** Open the full computer pane on this card's Agent's computer (`request.bot_id`). */
  onOpenComputer: (botId: string | null) => void;
  /**
   * The page's computer status. Without it the card connects the screen and tracks its own take-over;
   * with another Agent's computer, the card follows its own Agent's computer itself.
   */
  computer?: RequestCardComputer;
}

export function HumanCheckCard({
  request,
  check,
  lookup,
  onSettled,
  onStale,
  onOpenComputer,
  computer: hostComputer,
}: HumanCheckCardProps) {
  const t = useT();
  const name = lookup(request.bot_id)?.name ?? t('bots.deletedBot');
  // The computer the check is on: the raising Agent's own.
  const cardBot = computerBotFor(request.bot_id, lookup);
  const pageComputer = hostComputer && hostComputer.bot === cardBot ? hostComputer : undefined;
  // Only when the page follows another computer: this card's own view of its Agent's.
  const ownComputer = useComputerStatus(!!hostComputer && !pageComputer, cardBot);
  const computer: RequestCardComputer | undefined = pageComputer ?? (hostComputer ? ownComputer : undefined);
  const { busy, decide } = useRequestDecision(request, { onSettled, onStale });
  const { pending, status } = useSettledStatus(request);
  const screenRef = useRef<ComputerScreenHandle>(null);
  const [takingOver, setTakingOver] = useState(false);
  const [tookOver, setTookOver] = useState(false);

  const phase = computer ? computer.phase : undefined;
  // With the page's status the lease is whatever the server says last (a
  // take-over from the pane counts too, and a hand-back from anywhere ends it);
  // standalone, it is this card's own take-over.
  const inControl = computer ? phase?.kind === 'running' && phase.controller === 'user' : tookOver;

  const verifyHere = async () => {
    setTakingOver(true);
    try {
      const next = await takeoverComputer(cardBot);
      computer?.apply(next);
      setTookOver(true);
      screenRef.current?.focus();
    } catch (err) {
      toast(computerErrorText(t, err, 'botsComputer.takeOverFailed'), 'error');
      void computer?.refresh();
    } finally {
      setTakingOver(false);
    }
  };

  let screen: ReactNode;
  if (computer && !phase) {
    screen = <Skeleton className="aspect-[16/10] w-full rounded-lg" />;
  } else if (!phase || phase.kind === 'running') {
    screen = (
      <ComputerScreen
        ref={screenRef}
        bot={cardBot}
        viewOnly={!inControl}
        onTakeOver={() => void verifyHere()}
        onDisconnected={() => void computer?.refresh()}
        className="aspect-[16/10] w-full"
      />
    );
  } else {
    // Not running: "Verify here" starts it (a take-over wakes the computer).
    const asleep = phase.kind === 'asleep' || phase.kind === 'error';
    screen = (
      <div className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-2 rounded-lg border border-edge bg-surface-sunken px-4 text-center text-xs text-fg-muted">
        <Monitor size={20} aria-hidden="true" />
        <span>{asleep ? t('bots.requests.captchaAsleep') : t(phaseLabelKey(phase))}</span>
      </div>
    );
  }

  return (
    <ArtifactCard
      icon={<ShieldCheck size={14} />}
      title={t('bots.requests.captchaTitle', { name })}
      meta={check.reason || undefined}
      status={status}
      tone={pending ? 'accent' : 'neutral'}
      // Settled (verified, skipped) or expired: a one-line receipt.
      collapsed={!pending}
      footer={
        pending ? (
          <ArtifactCardActions hint={t('bots.requests.captchaHint', { name })}>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void decide({ decision: 'deny' })}
              data-testid="bots-request-skip"
            >
              {t('bots.requests.skip')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onOpenComputer(request.bot_id)}
              data-testid="bots-request-open-computer"
            >
              {t('bots.requests.openComputerShort')}
            </Button>
            {inControl ? (
              // Done on the card = hand back for this request (wakes the Bot).
              <Button size="sm" disabled={busy} onClick={() => void decide({ decision: 'approve' })}>
                {t('bots.requests.handBack')}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy || takingOver}
                onClick={() => void verifyHere()}
                data-testid="bots-request-verify-here"
              >
                {takingOver && <Spinner className="mr-1" />}
                {t('bots.requests.verifyHere')}
              </Button>
            )}
          </ArtifactCardActions>
        ) : undefined
      }
    >
      <div className="space-y-2" data-testid="bots-human-check" data-in-control={inControl ? 'true' : 'false'}>
        {pending && screen}
        {check.url && <DetailList rows={[{ label: t('bots.requests.page'), value: check.url }]} />}
      </div>
    </ArtifactCard>
  );
}
