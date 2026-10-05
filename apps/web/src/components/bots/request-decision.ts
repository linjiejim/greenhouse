/**
 * Settling a "needs you" card. Every card goes through the same call and
 * reads a refusal the same way:
 * - Already settled (another tab, the 150 s approval window ran out): the
 *   member is told and the transcript is re-read instead of pretending the
 *   click worked.
 * - Not carried out, still pending (a secure sign-in whose page moved on, a
 *   task over the limit): the member reads why — in their language for the
 *   codes we know, else the server's member-facing message — and the card
 *   stays open so they can try again or open the computer.
 */

import { useCallback, useState } from 'react';
import type { BotRequestDecision, BotRequestErrorCode, BotRequestStatus, BotRequestView } from '@greenhouse/types/bots';
import * as botsApi from '../../lib/api/bots';
import { useT, type TranslationKey } from '../../lib/i18n';
import { toast } from '../ui';

export interface RequestCardCallbacks {
  /** The decision went through — the card shows its settled state. */
  onSettled: (request: BotRequestView) => void;
  /** The server state moved under us; re-read the conversation. */
  onStale: () => void;
}

/**
 * 409 codes that mean "someone already settled this" — or is settling it
 * right now, in another tab (a code-less 409 is the older form of the same).
 */
const ALREADY_SETTLED: ReadonlySet<string> = new Set<BotRequestErrorCode>(['already_decided', 'deciding']);

/** Refusals that leave the request pending, by code — a sentence the member can act on. */
const STILL_PENDING_KEYS: Partial<Record<BotRequestErrorCode, TranslationKey>> = {
  page_gone: 'bots.requests.loginPageGone',
  origin_mismatch: 'bots.requests.loginOriginMoved',
  no_fields: 'bots.requests.loginNoFields',
  failed: 'bots.requests.loginFailed',
  invalid: 'bots.requests.loginInvalid',
  limit: 'bots.requests.taskLimit',
  computer_restarted: 'bots.requests.loginComputerRestarted',
  bot_gone: 'bots.requests.botGone',
} satisfies Record<Exclude<BotRequestErrorCode, 'already_decided' | 'deciding'>, TranslationKey>;

export type DecisionOutcome =
  | { ok: true }
  /** `stale`: already settled elsewhere. `refused`: still pending — `code` says why. */
  | { ok: false; reason: 'stale' | 'refused'; code: string | null };

/** How a failed decision reads: already settled (re-read) or refused with the request still open. */
export function classifyDecisionError(err: unknown): { reason: 'stale' | 'refused'; code: string | null } {
  if (botsApi.isBotsApiError(err) && err.status === 409 && (err.code === null || ALREADY_SETTLED.has(err.code))) {
    return { reason: 'stale', code: err.code };
  }
  return { reason: 'refused', code: botsApi.isBotsApiError(err) ? err.code : null };
}

export function useRequestDecision(request: BotRequestView, { onSettled, onStale }: RequestCardCallbacks) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const decide = useCallback(
    async (decision: BotRequestDecision): Promise<DecisionOutcome> => {
      setBusy(true);
      try {
        const { request: settled } = await botsApi.decideRequest(request.id, decision);
        onSettled(settled);
        return { ok: true };
      } catch (err) {
        const { reason, code } = classifyDecisionError(err);
        if (reason === 'stale') {
          toast(t('bots.requests.alreadySettled'), 'info');
          onStale();
        } else {
          const key = botsApi.copyForCode(STILL_PENDING_KEYS, code);
          const message = key ? t(key) : err instanceof Error && err.message ? err.message : t('bots.requests.failed');
          toast(message, 'error');
        }
        return { ok: false, reason, code };
      } finally {
        setBusy(false);
      }
    },
    [onSettled, onStale, request.id, t],
  );
  return { busy, decide };
}

/**
 * A take-over card the computer raised by itself (the member took over while
 * a Bot was mid-action — `interrupted` — or a Bot needed the computer while
 * the member held it — `waiting`), read defensively from the payload: the
 * card renders "you took over" / "is waiting" instead of a Bot's own reason,
 * and handing back lets that Bot continue.
 */
export function implicitTakeover(
  payload: unknown,
): { reason: 'interrupted' | 'waiting'; host: string | null; title: string | null } | null {
  if (!payload || typeof payload !== 'object') return null;
  const fields = payload as Record<string, unknown>;
  if (fields.implicit !== true) return null;
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return {
    reason: fields.reason === 'waiting' ? 'waiting' : 'interrupted',
    host: text(fields.host),
    title: text(fields.title),
  };
}

/** One label per settled state; approvals also say whether "always" was chosen. */
export function settledLabelKey(request: BotRequestView): TranslationKey {
  const status: BotRequestStatus = request.status;
  if (status === 'denied') return 'bots.requests.declined';
  if (status === 'expired') return 'bots.requests.expired';
  if (status === 'canceled') return 'bots.requests.canceled';
  if (request.kind === 'approval') {
    return request.result?.decision === 'always' ? 'bots.requests.allowedAlways' : 'bots.requests.allowed';
  }
  if (request.kind === 'takeover') return 'bots.requests.handedBack';
  if (request.kind === 'bot_create') return 'bots.requests.created';
  if (request.kind === 'task_start') return 'bots.requests.started';
  return 'bots.requests.done';
}
