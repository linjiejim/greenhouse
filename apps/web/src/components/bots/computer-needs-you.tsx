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
import type { BotLoginPayload, BotRequestView, BotTakeoverPayload } from '@greenhouse/types/bots';
import { Button, Spinner } from '../ui';
import { ShieldAlert } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { wsClient } from '../../lib/ws';
import { allBotsOf, computerRequestsFor, listBots, listRequests } from '../../lib/api/bots';
import { implicitTakeover } from './request-decision';

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

export function usePendingRequest(sessionId: string | undefined) {
  const [pending, setPending] = useState<{ request: BotRequestView; botName: string | null } | null>(null);
  const names = useRef<Record<string, string> | null>(null);

  const reload = useCallback(async () => {
    if (!sessionId) {
      setPending(null);
      return;
    }
    try {
      const { requests } = await listRequests('pending');
      const [request] = computerRequestsFor(requests, sessionId);
      if (!request) {
        setPending(null);
        return;
      }
      if (request.bot_id && !names.current?.[request.bot_id]) {
        // Archived Bots included: a request outlives the Bot that raised it.
        names.current = await listBots()
          .then((overview) => Object.fromEntries(allBotsOf(overview).map((bot) => [bot.id, bot.name])))
          .catch(() => names.current);
      }
      setPending({ request, botName: (request.bot_id && names.current?.[request.bot_id]) || null });
    } catch {
      // The banner is a convenience; the conversation's own card stays the source of truth.
    }
  }, [sessionId]);

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
