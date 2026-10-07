/**
 * Which card the secure sign-in sheet (app/bots/login.tsx) shows its form
 * for — pure, so the root vitest pins it (./login-sheet.test.ts):
 *
 * - Only a sign-in card (`kind: 'login'` — a user name / password, or a
 *   one-time code). The sheet opens by id, and `/bots/login?id=` is a deep link
 *   like every route; the server applies an `approve` to whatever kind the id
 *   names, so a sheet opened for an approval, a new Bot or a task would approve
 *   that instead, the typed values riding along. Any other kind reads as gone —
 *   the Bot form sheet's rule too (../manage/bot-form-model.ts).
 * - While it is pending, or while this sheet's own decision holds it: deciding
 *   settles the card in the store (a synchronous re-render) before the awaited
 *   call returns, and the form — whose native fields are released when it
 *   unmounts — must outlive its own decision. The held copy also covers the
 *   card dropping out of the lists while the sheet dismisses.
 */

import type { BotLoginPayload, BotRequestView } from '../../shared/bots';

/** A sign-in card: the request kind, and a payload variant the sheet knows. */
export function isLoginCard(request: Pick<BotRequestView, 'kind' | 'payload'>): boolean {
  if (request.kind !== 'login') return false;
  const variant = (request.payload as Partial<BotLoginPayload> | null | undefined)?.kind;
  return variant === 'login' || variant === 'otp';
}

/**
 * The card to show the form for, or null for the "no longer open" state.
 * `held` — the card this sheet's own decision is out (or went through) for.
 */
export function loginSheetRequest(
  lookup: { state: 'loading' | 'ready' | 'missing' | 'error'; request: BotRequestView | null },
  held: BotRequestView | null,
): BotRequestView | null {
  const found = lookup.state === 'ready' ? lookup.request : null;
  if (held && isLoginCard(held) && (!found || found.id === held.id)) return found ?? held;
  if (!found || !isLoginCard(found)) return null;
  return found.status === 'pending' ? found : null;
}
