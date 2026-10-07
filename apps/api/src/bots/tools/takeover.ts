/**
 * `request_takeover` — the Bot asks the member to step in, then ends its turn.
 *
 * login / otp → a **secure sign-in card**: the member types into fields the
 * Bot never sees, the server fills them into the Bot's page (see
 * vault/fill.ts `fillSecureLogin`), and the Bot is woken to continue.
 * captcha / other → a **take-over card**: the member opens the computer,
 * does it by hand and presses "Hand back", which wakes the Bot.
 *
 * The page URL and origin on the card are read from the Bot's own tab, never
 * taken from the model, so a prompt-injected page cannot dress a card up as
 * another site. Without a tab to sign into, a login request degrades to a
 * plain take-over card (the secure card would have nowhere to fill).
 *
 * Cards expire after HUMAN_WAIT_HOLD_MS — exactly as long as they keep the
 * member's computer (and the page they wait on) from idle shutdown.
 *
 * `implicitTakeoverFor` raises the card nobody asked for: the member took the
 * computer while a Bot was using it (or holds it when a Bot comes), and their
 * hand-back must wake that Bot — which the computer tools then promise it.
 * `humanCheckFor` raises the one the browser asks for when a site wants human
 * verification: a `captcha` take-over card, so the member passes the check
 * (the human-check watcher hands back by itself once the page is clean).
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { BotImplicitTakeoverPayload, BotLoginPayload, BotTakeoverPayload } from '@greenhouse/types/bots';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { BotTurnContext } from '../engine/context.js';
import { copy } from '../engine/copy.js';
import {
  defaultComputerDeps,
  findLeasePage,
  type ComputerDeps,
  type HumanCheck,
  type HumanCheckOutcome,
  type ImplicitTakeover,
  type ImplicitTakeoverOutcome,
} from '../computer/browser-session.js';
import { HUMAN_WAIT_HOLD_MS } from '../computer/limits.js';
import { isVaultAvailable } from '../vault/crypto.js';
import { hostOfOrigin, originOfUrl } from '../vault/origin.js';
import { vaultMatchesForOrigin } from '../vault/service.js';
import { BOT_TOOL_METAS } from './meta.js';

const meta = BOT_TOOL_METAS.find((m) => m.id === 'request_takeover')!;

const schema = z.object({
  kind: z.enum(['login', 'otp', 'captcha', 'other']),
  reason: z.string().min(1).max(300).describe('One sentence the member reads on the card.'),
});

/** origin + path of an http(s) page — no query or fragment (they carry tokens). */
export function displayUrl(url: string | null | undefined): string | null {
  const origin = originOfUrl(url);
  if (!origin || !url) return null;
  try {
    return `${origin}${new URL(url).pathname}`;
  } catch {
    return origin;
  }
}

export async function requestTakeover(
  ctx: BotTurnContext,
  input: z.infer<typeof schema>,
  deps: ComputerDeps = defaultComputerDeps,
): Promise<Record<string, unknown>> {
  const found = await findLeasePage(ctx.userId, ctx.bot.id, ctx.sessionId, deps).catch(() => null);
  const pageUrl = found?.page.url() ?? null;
  const origin = originOfUrl(pageUrl);
  const url = displayUrl(pageUrl);
  const reason = deps.redact(ctx.userId, input.reason.replace(/\s+/g, ' ').trim()).slice(0, 300);

  const secureCard = (input.kind === 'login' || input.kind === 'otp') && origin !== null;

  // One open card per Bot and purpose: a Bot that asks again (a retry, a
  // follow-up turn) must not stack duplicate cards in front of the member.
  const pending = await ctx.db.bots.listRequests(ctx.userId, {
    sessionId: ctx.sessionId,
    status: 'pending',
    kinds: [secureCard ? 'login' : 'takeover'],
  });
  const same = pending.find((row) => {
    if (row.bot_id !== ctx.bot.id) return false;
    if (!secureCard) return true;
    return ((safeJsonParse(row.payload, {}) as Partial<BotLoginPayload>).origin ?? null) === origin;
  });
  if (same) {
    ctx.stopAfterStep('takeover');
    return {
      requested: true,
      request_id: same.id,
      already_pending: true,
      message: 'The member already has your card asking them to step in. End your turn NOW with one short line.',
    };
  }

  let requestId: string;
  if (secureCard) {
    const matches = isVaultAvailable() ? await vaultMatchesForOrigin(ctx.db, ctx.userId, origin) : [];
    const payload: BotLoginPayload = {
      reason,
      kind: input.kind as 'login' | 'otp',
      origin,
      url,
      vault_matches: matches.map(({ id, label, username_hint }) => ({ id, label, username_hint })),
    };
    requestId = (await ctx.createRequest('login', payload, { expiresInMs: HUMAN_WAIT_HOLD_MS })).id;
  } else {
    const payload: BotTakeoverPayload = {
      reason,
      kind: input.kind === 'captcha' ? 'captcha' : 'other',
      url,
    };
    requestId = (await ctx.createRequest('takeover', payload, { expiresInMs: HUMAN_WAIT_HOLD_MS })).id;
  }
  ctx.stopAfterStep('takeover');
  return {
    requested: true,
    request_id: requestId,
    card: secureCard ? 'secure_sign_in' : 'take_over',
    // Left to itself the model tells the member to "take over the browser"
    // even when the card is a fill-in form: name what the card actually is.
    message: secureCard
      ? 'The member now sees a secure sign-in card in this conversation: they type the details into the card (you never see them) or open the computer themselves. End your turn NOW with one short line asking them to fill in the card above. Do not call more tools; you will be woken automatically when they are done.'
      : 'The member now sees a card asking them to step in on the computer. End your turn NOW with one short line saying what you need from them. Do not call more tools; you will be woken automatically when they are done.',
  };
}

// ─── Implicit take-over ───────────────────────────────────

/** Raising in flight per turn: parallel tool calls stopped by one take-over share one card. */
const raising = new WeakMap<BotTurnContext, Promise<ImplicitTakeoverOutcome>>();

/**
 * The card a Bot leaves when it meets the member at the computer — for
 * ComputerTurn/FillTurn.implicitTakeover; undefined for background turns
 * (a hand-back could not wake them). One per conversation and Bot: a pending
 * take-over card of this Bot here (asked for or implicit) is reused. Ends the
 * turn after this step, like request_takeover.
 */
export function implicitTakeoverFor(
  ctx: BotTurnContext,
  deps: Pick<ComputerDeps, 'currentLease'> = defaultComputerDeps,
): ((info: ImplicitTakeover) => Promise<ImplicitTakeoverOutcome>) | undefined {
  if (ctx.background) return undefined;
  return (info) => {
    let pending = raising.get(ctx);
    if (!pending) {
      pending = raiseImplicitTakeover(ctx, info, deps).finally(() => raising.delete(ctx));
      raising.set(ctx, pending);
    }
    return pending;
  };
}

async function raiseImplicitTakeover(
  ctx: BotTurnContext,
  info: ImplicitTakeover,
  deps: Pick<ComputerDeps, 'currentLease'>,
): Promise<ImplicitTakeoverOutcome> {
  const pending = await ctx.db.bots.listRequests(ctx.userId, {
    sessionId: ctx.sessionId,
    status: 'pending',
    kinds: ['takeover'],
  });
  if (!pending.some((row) => row.bot_id === ctx.bot.id)) {
    const payload: BotImplicitTakeoverPayload = {
      implicit: true,
      reason: info.reason,
      ...(info.host ? { host: info.host } : {}),
      ...(info.title ? { title: info.title } : {}),
    };
    const created = await ctx.createRequest('takeover', payload, {
      expiresInMs: HUMAN_WAIT_HOLD_MS,
    });
    // A hand-back between the take-over and this card found nothing to settle
    // and woke nobody; a card left now would wait for a hand-back that already
    // happened. Withdraw it, unless a hand-back since then settled (and woke) it.
    const lease = await deps.currentLease(ctx.userId);
    if (lease.controller !== 'user') {
      const withdrawn = await ctx.db.bots.settleRequest(ctx.userId, created.id, 'canceled', {
        by: 'system',
        reason: 'handed_back',
      });
      if (withdrawn) return 'handed_back';
    }
  }
  ctx.stopAfterStep('takeover');
  return 'card';
}

// ─── Human checks ─────────────────────────────────────────

/** Raising in flight per turn: parallel browser calls that hit one check share one card. */
const checking = new WeakMap<BotTurnContext, Promise<HumanCheckOutcome>>();

/**
 * The verification card for ComputerTurn.humanCheck — undefined for
 * background turns (nobody would answer it). Deduplicated like
 * request_takeover: a pending take-over card of this Bot in this
 * conversation is reused. Ends the turn after this step either way.
 */
export function humanCheckFor(ctx: BotTurnContext): ((info: HumanCheck) => Promise<HumanCheckOutcome>) | undefined {
  if (ctx.background) return undefined;
  return (info) => {
    let pending = checking.get(ctx);
    if (!pending) {
      pending = raiseHumanCheck(ctx, info).finally(() => checking.delete(ctx));
      checking.set(ctx, pending);
    }
    return pending;
  };
}

async function raiseHumanCheck(ctx: BotTurnContext, info: HumanCheck): Promise<HumanCheckOutcome> {
  const pending = await ctx.db.bots.listRequests(ctx.userId, {
    sessionId: ctx.sessionId,
    status: 'pending',
    kinds: ['takeover'],
  });
  if (pending.some((row) => row.bot_id === ctx.bot.id)) {
    ctx.stopAfterStep('takeover');
    return 'already_pending';
  }
  const payload: BotTakeoverPayload = {
    kind: 'captcha',
    // Server-written from the host: the page's own words never reach a card line.
    reason: copy.humanCheckReason(ctx.locale, info.origin ? hostOfOrigin(info.origin) : null),
    url: displayUrl(info.url),
  };
  await ctx.createRequest('takeover', payload, { expiresInMs: HUMAN_WAIT_HOLD_MS });
  ctx.stopAfterStep('takeover');
  return 'card';
}

export function createTakeoverTool(ctx: BotTurnContext, deps: ComputerDeps = defaultComputerDeps): Tool {
  return tool({
    description: meta.description,
    inputSchema: schema,
    execute: (input) => requestTakeover(ctx, input, deps),
  });
}
