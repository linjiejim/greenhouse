/**
 * "Needs you" inside the computer pane: when a Bot in this conversation asked
 * the member to take over (CAPTCHA, a sign-in it must not do), the pane shows
 * the request and a Take over that answers it — handing back then resumes
 * exactly that Bot. A card the computer raised itself (the member took over
 * mid-action, or a Bot is waiting for the computer) offers "let it continue"
 * instead. The conversation's own card stays the source of truth; this banner
 * is the shortcut where the screen is.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { BotLoginPayload, BotRequestView, BotTakeoverPayload, BotView } from '@greenhouse/types/bots';
import { Button, Spinner } from '../ui';
import { ShieldAlert } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { wsClient } from '../../lib/ws';
import { allBotsOf, computerRequestsFor, listBots, listRequests, type ComputerBot } from '../../lib/api/bots';
import { implicitTakeover } from './request-decision';
import { computerBotFor } from './computer-phase';

export function NeedsYouBanner({
  request,
  botName,
  busy,
  canTakeOver,
  onTakeOver,
  onContinue,
}: {
  request: BotRequestView;
  botName: string | null;
  busy: boolean;
  canTakeOver: boolean;
  onTakeOver: () => void;
  /** Answer a card the computer raised itself (the member is no longer in control): wake the Bot. */
  onContinue: () => void;
}) {
  const t = useT();
  const payload = request.payload as BotTakeoverPayload | BotLoginPayload;
  const implicit = implicitTakeover(request.payload);
  const name = botName ?? t('bots.deletedBot');
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-warning bg-warning-subtle px-3 py-2"
      data-testid="computer-needs-you"
    >
      <ShieldAlert size={16} className="mt-0.5 flex-shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-fg">
          {implicit
            ? t(
                implicit.reason === 'waiting'
                  ? 'bots.requests.implicitWaitingTitle'
                  : 'bots.requests.implicitInterruptedTitle',
                { name },
              )
            : botName
              ? t('botsComputer.needsYou', { name: botName })
              : t('botsComputer.needsYouGeneric')}
        </p>
        {/* An implicit card's `reason` is a code, not words for the member. */}
        {!implicit && payload.reason && <p className="mt-0.5 text-xs leading-5 text-fg-secondary">{payload.reason}</p>}
      </div>
      {implicit ? (
        <Button size="sm" onClick={onContinue} disabled={busy}>
          {busy && <Spinner className="mr-1" />}
          {t('bots.requests.handBackContinue', { name })}
        </Button>
      ) : (
        canTakeOver && (
          <Button size="sm" onClick={onTakeOver} disabled={busy}>
            {busy && <Spinner className="mr-1" />}
            {t('botsComputer.takeOver')}
          </Button>
        )
      )}
    </div>
  );
}

/**
 * The take-over / sign-in card waiting in `sessionId` for this computer — `bot`'s
 * (null = the main Agent's). Each Agent works on its own computer, so a guest's
 * card in this conversation belongs on the guest's computer, not on this one.
 */
export function usePendingRequest(sessionId: string | undefined, bot: ComputerBot = null) {
  const [pending, setPending] = useState<{ request: BotRequestView; botName: string | null } | null>(null);
  // Who raised the cards: names for the banner, template keys to tell Sprouty's (main computer) apart.
  const directory = useRef<Map<string, Pick<BotView, 'name' | 'template_key'>> | null>(null);

  const reload = useCallback(async () => {
    if (!sessionId) {
      setPending(null);
      return;
    }
    try {
      const { requests } = await listRequests('pending');
      const candidates = computerRequestsFor(requests, sessionId);
      if (candidates.length === 0) {
        setPending(null);
        return;
      }
      if (candidates.some((request) => request.bot_id && !directory.current?.has(request.bot_id))) {
        // Archived Bots included: a request outlives the Bot that raised it.
        directory.current = await listBots()
          .then((overview) => new Map(allBotsOf(overview).map((one) => [one.id, one])))
          .catch(() => directory.current);
      }
      const known = (id: string) => directory.current?.get(id);
      const request = candidates.find((candidate) => computerBotFor(candidate.bot_id, known) === bot);
      setPending(request ? { request, botName: (request.bot_id && known(request.bot_id)?.name) || null } : null);
    } catch {
      // The banner is a convenience; the conversation's own card stays the source of truth.
    }
  }, [sessionId, bot]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!sessionId) return;
    return wsClient.onEvent((event) => {
      if (event.type === 'bots:attention' || (event.type === 'bots:conversation' && event.sessionId === sessionId)) {
        void reload();
      }
    });
  }, [sessionId, reload]);

  return { pending, reload };
}
