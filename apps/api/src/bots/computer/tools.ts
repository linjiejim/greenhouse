/**
 * Computer-side Bot tools for one turn, and the secure sign-in settlement.
 *
 * `buildComputerTools(ctx)` is what the Bots engine merges into a Bot turn:
 * - runtime not ready (disabled / docker missing / checking) → nothing: a Bot
 *   must not be offered a computer that cannot start;
 * - foreground → browser, computer, request_takeover, and vault when the
 *   vault is configured; meeting the member at the computer leaves an
 *   implicit take-over card (tools/takeover.ts), so their hand-back wakes
 *   the Bot, and a site asking for human verification raises the
 *   verification card (`humanCheck`), which ends the turn;
 * - background → browser (open/snapshot/scroll/wait/back/tabs/screenshot, in
 *   a clean signed-out context) and computer (status/read_file/processes/
 *   process_log). No vault, no take-over: nobody is there to answer a card.
 *
 * `handleLoginDecision` runs when the member submits a secure sign-in card or
 * dismisses it ("Not now"); either way the asking Bot is woken exactly once,
 * with what actually happened.
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md §5, §6, §8.
 */

import type { Tool } from 'ai';
import { getDb, type BotRequestRow, type DatabaseProvider } from '@greenhouse/db';
import type { BotLoginPayload, BotRequestDecision } from '@greenhouse/types/bots';
import { safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { BotTurnContext } from '../engine/context.js';
import type { InboxItem } from '../engine/inbox-types.js';
import { createBrowserTool } from '../tools/browser.js';
import { createComputerTool } from '../tools/computer.js';
import { createTakeoverTool, humanCheckFor, implicitTakeoverFor } from '../tools/takeover.js';
import { createVaultTool } from '../tools/vault.js';
import { isVaultAvailable } from '../vault/crypto.js';
import { SecureLoginError, fillSecureLogin, type SecureLoginResult } from '../vault/fill.js';
import { hostOfOrigin } from '../vault/origin.js';
import { recordVaultAccess, saveSecureLogin, vaultMatchesForOrigin } from '../vault/service.js';
import { noteTurnObservation } from '../vault/turn-observations.js';
import { defaultComputerDeps, releaseTurnLeases, type ComputerDeps, type ComputerTurn } from './browser-session.js';
import { getComputerRuntime } from './runtime.js';

export { SecureLoginError } from '../vault/fill.js';
export { releaseTurnLeases } from './browser-session.js';

export function computerTurnFrom(ctx: BotTurnContext, deps: ComputerDeps = defaultComputerDeps): ComputerTurn {
  const withVault = !ctx.background && isVaultAvailable();
  const implicitTakeover = implicitTakeoverFor(ctx, deps);
  // A site asking for human verification raises the verification card (tools/takeover.ts).
  const humanCheck = humanCheckFor(ctx);
  return {
    db: ctx.db,
    userId: ctx.userId,
    botId: ctx.bot.id,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    background: ctx.background,
    signal: ctx.signal,
    markTainted: () => ctx.markTainted(),
    noteObservation: (origin) => noteTurnObservation(ctx, origin, ctx.isTainted()),
    vaultMatches: withVault ? (origin) => vaultMatchesForOrigin(ctx.db, ctx.userId, origin) : null,
    ...(implicitTakeover ? { implicitTakeover } : {}),
    ...(humanCheck ? { humanCheck } : {}),
  };
}

/**
 * `browser`, `computer`, `request_takeover`, `vault` for one turn — the
 * read-only subset for background turns, nothing when the runtime is not ready.
 */
export function buildComputerTools(
  ctx: BotTurnContext,
  deps: ComputerDeps = defaultComputerDeps,
): Record<string, Tool> {
  if (getComputerRuntime().state !== 'ready') return {};
  const turn = computerTurnFrom(ctx, deps);
  if (ctx.background) {
    // The clean context dies with the run when it is stopped; a normal finish
    // is covered by the engine calling releaseTurnLeases (and an idle sweep).
    ctx.signal.addEventListener('abort', () => void releaseTurnLeases(ctx.userId, ctx.turnId, deps), { once: true });
    return { browser: createBrowserTool(turn, deps), computer: createComputerTool(turn, deps) };
  }
  const tools: Record<string, Tool> = {
    browser: createBrowserTool(turn, deps),
    computer: createComputerTool(turn, deps),
    request_takeover: createTakeoverTool(ctx, deps),
  };
  if (isVaultAvailable()) tools.vault = createVaultTool(ctx, deps);
  return tools;
}

// ─── Secure sign-in ───────────────────────────────────────

type Deliver = (sessionId: string, item: InboxItem) => Promise<void>;

async function engineDeliver(sessionId: string, item: InboxItem): Promise<void> {
  // Imported lazily: the engine imports this module's barrel to build tools.
  const { deliverToConversation } = await import('../engine/index.js');
  await deliverToConversation(sessionId, item);
}

/**
 * Settle a `login` request: fill the secure sign-in values server-side into
 * the asking Bot's page (following a two-step sign-in to its next screen),
 * optionally save them to the vault, log it, and wake the Bot with what
 * actually happened. The values live only in this call — never in the
 * request row, the transcript, a log line or an event.
 *
 * Throws `SecureLoginError` (message safe to show) when nothing could be
 * filled — the page is gone or moved to another site — so the card can tell
 * the member to sign in through "Open computer" instead; the request stays
 * pending. "Not now" (`deny`) settles the request, writes a transcript line
 * and wakes the Bot to continue another way.
 *
 * This function settles the row itself (compare-and-set) BEFORE waking the
 * Bot, so a double click or a second API slot can never wake it twice;
 * decideComputer then finds the row settled.
 */
export async function handleLoginDecision(
  args: { userId: string; request: BotRequestRow; decision: BotRequestDecision },
  deps: ComputerDeps = defaultComputerDeps,
  deliver: Deliver = engineDeliver,
  db: DatabaseProvider = getDb(),
): Promise<void> {
  const { userId, request, decision } = args;
  if (request.kind !== 'login' || request.user_id !== userId) return;

  const payload = safeJsonParse(request.payload, {}) as Partial<BotLoginPayload>;
  const origin = payload.origin ?? null;
  const zh = async () => (await db.users.getById(userId).catch(() => undefined))?.locale === 'zh';

  if (decision.decision === 'deny') {
    const settled = await db.bots.settleRequest(userId, request.id, 'denied', { decision: 'deny', by: 'member' });
    if (!settled) return; // another click or slot settled it, and woke the Bot
    const host = origin ? hostOfOrigin(origin) : null;
    const eventText = (await zh())
      ? `已跳过${host ? ` ${host} 的` : ''}登录`
      : `Sign-in${host ? ` to ${host}` : ''} skipped`;
    const event = {
      kind: 'request' as const,
      request_id: request.id,
      request_kind: 'login' as const,
      bot_id: request.bot_id,
    };
    await safeDeliver(
      deliver,
      request.session_id,
      request.bot_id
        ? {
            kind: 'continue',
            botId: request.bot_id,
            note: `The member chose not to sign in${origin ? ` on ${origin}` : ''} right now. Do not ask again unless they say so: continue another way, or tell them in one line what you need the sign-in for.`,
            eventText,
            event,
          }
        : { kind: 'event', text: eventText, event },
    );
    return;
  }

  const values = {
    username: decision.login?.username?.trim() || undefined,
    password: decision.login?.password || undefined,
    otp: decision.login?.otp?.replace(/\s+/g, '') || undefined,
  };
  if (!values.username && !values.password && !values.otp) {
    throw new SecureLoginError('invalid', 'Enter your sign-in details first.');
  }
  if (!origin || !request.bot_id) {
    throw new SecureLoginError('page_gone', 'This sign-in request has no page to fill. Use “Open computer” instead.');
  }

  // The Bot's page may be gone because the computer stopped (idle, an admin,
  // a crash) and came back since the card was raised: then the card's URL is
  // reopened in the Bot's tab, and if it cannot be the member is told why.
  const computer = await db.botComputers.get(userId).catch(() => undefined);
  const restarted =
    computer?.state !== 'running' ||
    (computer.last_started_at !== null && Date.parse(computer.last_started_at) > Date.parse(request.created_at));
  const filled = await fillSecureLogin(
    {
      userId,
      botId: request.bot_id,
      sessionId: request.session_id,
      origin,
      values,
      submit: decision.login?.submit !== false,
      reopenUrl: payload.url ?? null,
      restarted,
    },
    deps,
  );

  let savedItem: { id: string; label: string } | null = null;
  if (decision.login?.save_to_vault && (values.username || values.password) && isVaultAvailable()) {
    try {
      savedItem = await saveSecureLogin(db, userId, origin, values);
    } catch (err) {
      // The sign-in itself went through; saving is a convenience.
      logger.warn('[bots/vault] saving a secure sign-in failed', { userId, origin, error: toErrorMessage(err) });
    }
  }

  await recordVaultAccess(db, {
    user_id: userId,
    item_id: savedItem?.id ?? null,
    item_label: savedItem?.label ?? hostOfOrigin(origin),
    bot_id: request.bot_id,
    session_id: request.session_id,
    origin,
    action: 'secure_login',
    outcome: 'filled',
    approval: 'user',
  });

  // Field names only: the row's result is shown in the transcript API.
  const settled = await db.bots.settleRequest(userId, request.id, 'resolved', {
    decision: decision.decision,
    by: 'member',
    fields: filled.fields,
  });
  if (!settled) return;

  const outcome = describeSecureLogin(filled, origin, savedItem, await zh());
  await safeDeliver(deliver, request.session_id, {
    kind: 'continue',
    botId: request.bot_id,
    note: outcome.note,
    eventText: outcome.eventText,
    event: { kind: 'login_done', request_id: request.id, origin, saved_to_vault: savedItem !== null },
  });
}

/** Wake-up delivery is best effort: the row is already settled, so a failure must not 500 the card. */
async function safeDeliver(deliver: Deliver, sessionId: string, item: InboxItem): Promise<void> {
  try {
    await deliver(sessionId, item);
  } catch (err) {
    logger.warn('[bots/vault] could not wake the Bot after a sign-in card', { sessionId, error: toErrorMessage(err) });
  }
}

/**
 * The Bot's note and the member's transcript line for a secure sign-in,
 * built from what was actually filled — never "signed in" when the password
 * had nowhere to go (a two-step sign-in whose next screen did not come).
 */
export function describeSecureLogin(
  result: SecureLoginResult,
  origin: string,
  savedItem: { id: string; label: string } | null,
  zh: boolean,
): { note: string; eventText: string } {
  const host = hostOfOrigin(origin);
  const saved = savedItem !== null;
  const savedNote = saved ? ` The login was saved to the vault as ${savedItem.id}.` : '';
  const savedText = saved ? (zh ? '，并保存到密码库' : ' and saved it to Passwords') : '';

  // Only the user name went in: the password they typed had nowhere to go,
  // or they gave none and the site now asks for it.
  const passwordUnused = result.pending.includes('password');
  const passwordNotGiven =
    result.fields.includes('username') && !result.fields.includes('password') && result.next === 'login';
  if (passwordUnused || passwordNotGiven) {
    const retry = saved
      ? `call vault fill_login with item ${savedItem.id}`
      : 'call request_takeover with kind "login" again (the member only needs to type the password)';
    return {
      note:
        `The member's user name was filled on ${origin}${result.submitted ? ' and the form was submitted' : ''}` +
        (passwordUnused
          ? ', but no password field appeared, so the password they typed was NOT used: this looks like a two-step sign-in. '
          : '; they gave no password and the site now asks for one. ') +
        `Take a snapshot; when the password page shows, ${retry}.${savedNote}`,
      eventText: zh
        ? `已在 ${host} 填入用户名，下一步还需要输入密码${savedText}`
        : `Entered your user name on ${host}; the password step is next${savedText}`,
    };
  }
  if (result.next === 'otp' && !result.fields.includes('otp')) {
    return {
      note:
        `The member's sign-in on ${origin} was submitted and the site now asks for a one-time code. ` +
        'If a vault entry for this site has an authenticator, call vault fill_totp with it; otherwise call request_takeover with kind "otp" and end your turn.' +
        savedNote,
      eventText: zh
        ? `已提交 ${host} 的登录${savedText}，网站还需要一次性验证码`
        : `Submitted your sign-in on ${host}${savedText}; the site now asks for a one-time code`,
    };
  }
  if (result.next === 'captcha' || result.next === 'challenge') {
    return {
      note:
        `The member's sign-in on ${origin} was submitted, and the site now shows a bot check. ` +
        'Take a snapshot; if it stays, call request_takeover with kind "captcha".' +
        savedNote,
      eventText: zh
        ? `已提交 ${host} 的登录${savedText}，网站出现了人机验证`
        : `Submitted your sign-in on ${host}${savedText}; the site shows a bot check`,
    };
  }
  return {
    note:
      `The member signed in on ${origin} through the secure sign-in card` +
      `${result.submitted ? ' and submitted the form' : ''}${saved ? ', and saved the login to the vault' : ''}. ` +
      (result.next === 'login'
        ? 'The page may still be asking to sign in (a wrong password?): take a snapshot and check before continuing.'
        : 'Take a snapshot and continue the task.'),
    eventText: zh
      ? `已通过安全登录卡登录 ${host}${savedText}`
      : `Signed in to ${host} with the secure sign-in card${savedText}`,
  };
}
