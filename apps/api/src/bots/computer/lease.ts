/**
 * Take-over lease — who drives the computer's screen and input (spec §6.4,
 * review R11).
 *
 * The lease is DB state (`lease_controller` + a monotonically increasing
 * `lease_epoch`, both slots see it). Taking over bumps the epoch, aborts every
 * computer action this process tracks for the member (shell and file
 * commands, and the browser/vault steps registered through
 * access.trackComputerAction) and kills the Bot shell's processes
 * (`gh-agent-kill`: everything of uid agent except background jobs and the
 * member's open terminals); Bot tools
 * re-check the lease before every step that cannot be undone and the epoch
 * before returning any observation, so nothing taken under the old lease
 * leaks out. Handing back bumps it again, brings the browser window back
 * (best effort — the member may have minimised it) and settles exactly the
 * card the member answered (CAS) — the one named, or the single card waiting
 * in the conversation they are in; never a guess across conversations —
 * waking the Bot that asked through the conversation's single writer
 * (deliverToConversation). Viewers gone for more than 3 minutes release the
 * lease back to the Bots but never continue on their own — a phone that
 * dropped its socket to read an SMS code must not have the Bot resume on a
 * half-typed login.
 */

import { getDb, type BotRequestRow } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { BotEvent, BotRequestDecision } from '@greenhouse/types/bots';
import type { InboxItem } from '../engine/inbox-types.js';

import {
  abortComputerActions,
  ensureComputerReady,
  getBrowser,
  rememberFilledSecret,
  restoreBrowserWindow,
} from './access.js';
import { ComputerUnavailableError } from './errors.js';
import { computerLifecycleHooks } from './hooks.js';
import { leaseChanged } from './lease-events.js';
import { requireComputerRuntime } from './runtime.js';

/** Viewers gone this long hand the computer back to the Bots (event only, no continue). */
export const ABANDONED_LEASE_MS = 3 * 60_000;
const MAX_NOTE_CHARS = 500;
const MAX_TYPE_CHARS = 10_000;

// ─── Copy ─────────────────────────────────────────────────

type Locale = 'en' | 'zh';

/** The member's copy language (cards, notes the server writes on their behalf). */
export async function localeOf(userId: string): Promise<Locale> {
  const user = await getDb().users.getById(userId);
  return user?.locale?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function cleanNote(note: string | undefined): string | undefined {
  const value = note?.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
  return value || undefined;
}

const COPY = {
  handback: (locale: Locale, note?: string) =>
    locale === 'zh'
      ? `已交还电脑${note ? `——「${note}」` : ''}。`
      : `Computer handed back${note ? ` — “${note}”` : ''}.`,
  skipped: (locale: Locale) => (locale === 'zh' ? '已跳过接管。' : 'Take-over skipped.'),
  released: (locale: Locale) =>
    locale === 'zh'
      ? '查看窗口已关闭超过 3 分钟，电脑已交回给 Bot；请求仍在等你处理。'
      : 'The viewer was closed for 3 minutes, so the computer went back to the Bots. The request is still waiting for you.',
};

/** What the woken Bot reads (model-facing, so English). */
const BOT_NOTE = {
  handback: (note?: string) =>
    `The member finished on the computer and handed it back. Look at the current page before you continue.${
      note ? ` Their note: ${note}` : ''
    }`,
  skipped: () => 'The member skipped your take-over request. Continue another way, or tell them what you need.',
};

// ─── Requests ─────────────────────────────────────────────

/**
 * The conversation's single writer. Loaded lazily: the engine sits above the
 * computer (its tools use it), so a static import would tie the two module
 * graphs into a cycle.
 */
async function deliverToConversation(sessionId: string, item: InboxItem): Promise<void> {
  const engine = await import('../engine/index.js');
  await engine.deliverToConversation(sessionId, item);
}

/** Cards that ask the member to do something on the computer (a hand-back can answer them). */
const HUMAN_STEP_KINDS = ['takeover', 'login'] as const;

function isHumanStep(request: BotRequestRow): boolean {
  return (HUMAN_STEP_KINDS as readonly string[]).includes(request.kind);
}

/**
 * Settle a take-over request once and wake the Bot that asked. A row passed
 * in as `pending` is settled here (CAS); a row the caller already settled is
 * delivered as is. Returns false when another click or slot settled it first.
 */
async function settleAndContinue(
  userId: string,
  request: BotRequestRow,
  outcome: { status: 'resolved' | 'denied'; note?: string },
): Promise<boolean> {
  const db = getDb();
  const settled =
    request.status === 'pending'
      ? await db.bots.settleRequest(userId, request.id, outcome.status, {
          by: 'member',
          ...(outcome.note ? { note: outcome.note } : {}),
        })
      : request;
  if (!settled) return false;
  const locale = await localeOf(userId);
  const text = outcome.status === 'resolved' ? COPY.handback(locale, outcome.note) : COPY.skipped(locale);
  const event: BotEvent = {
    kind: 'takeover_done',
    request_id: request.id,
    bot_id: request.bot_id,
    ...(outcome.note ? { note: outcome.note } : {}),
  };
  try {
    if (request.bot_id) {
      await deliverToConversation(request.session_id, {
        kind: 'continue',
        botId: request.bot_id,
        note: outcome.status === 'resolved' ? BOT_NOTE.handback(outcome.note) : BOT_NOTE.skipped(),
        eventText: text,
        event,
      });
    } else {
      await deliverToConversation(request.session_id, { kind: 'event', text, event });
    }
  } catch (err) {
    logger.warn(`[bots-computer] could not deliver the hand-back to ${request.session_id}: ${toErrorMessage(err)}`);
  }
  return true;
}

// ─── Take over / hand back ────────────────────────────────

/** Kills every process of uid agent except background jobs and terminals (image contract 2). */
const AGENT_KILL_ARGV = ['gh-agent-kill'];

/** The member takes the screen and input. Idempotent. */
export async function takeoverComputer(userId: string): Promise<void> {
  await ensureComputerReady(userId);
  const row = await getDb().botComputers.setLease(userId, 'user');
  if (!row) return; // already theirs
  const aborted = abortComputerActions(userId);
  // Commands of other API slots and anything the Bot's shell left behind: the
  // agent uid's processes go — except background jobs (they are meant to
  // outlive a take-over) and the member's own terminals. The browser
  // (another uid) stays.
  let killed: number | null = null;
  try {
    const { host } = requireComputerRuntime();
    const result = await host.exec({
      container: row.container_name,
      user: 'agent',
      argv: AGENT_KILL_ARGV,
      timeoutMs: 15_000,
      maxStdoutBytes: 1024,
    });
    if (result.code !== 0) throw new Error(result.stderr.trim() || `gh-agent-kill exited ${result.code}`);
    const count = Number.parseInt(result.stdout.toString('utf8').trim(), 10);
    killed = Number.isFinite(count) ? count : null;
  } catch (err) {
    logger.warn(`[bots-computer] could not stop the Bot shell on take-over: ${toErrorMessage(err)}`);
  }
  logger.info('[bots-computer] takeover', {
    user_id: userId,
    epoch: row.lease_epoch,
    aborted_actions: aborted,
    killed_processes: killed,
  });
  leaseChanged(row);
}

/**
 * The Bots have the computer again: bring the browser window back for them
 * (the member may have minimised it). Best effort, never awaited — it must
 * not hold up the hand-back, and a stopped computer has no window to restore.
 */
function restoreWindowAfterHandback(userId: string): void {
  void restoreBrowserWindow(userId).catch((err: unknown) => {
    if (err instanceof ComputerUnavailableError) return;
    logger.warn(`[bots-computer] could not restore the browser window after a hand-back: ${toErrorMessage(err)}`);
  });
}

/**
 * Which card a hand-back answers: the one the member named (it must still be
 * pending, ask for a human step, and sit in their conversation when they say
 * which one), else — given only the conversation — the single card waiting
 * there. Never a guess across conversations: a voluntary take-over in one DM
 * must not resolve another Bot's CAPTCHA card and wake it.
 */
async function requestToSettle(
  userId: string,
  opts: { requestId?: string; sessionId?: string },
): Promise<BotRequestRow | undefined> {
  const db = getDb();
  if (opts.requestId) {
    const request = await db.bots.getRequest(userId, opts.requestId);
    if (!request || request.status !== 'pending' || !isHumanStep(request)) return undefined;
    if (opts.sessionId && request.session_id !== opts.sessionId) return undefined;
    return request;
  }
  if (!opts.sessionId) return undefined;
  const waiting = await db.bots.listRequests(userId, {
    sessionId: opts.sessionId,
    status: 'pending',
    kinds: [...HUMAN_STEP_KINDS],
  });
  return waiting.length === 1 ? waiting[0] : undefined;
}

/**
 * The member hands the computer back: release the lease, settle the card it
 * answers (see requestToSettle; none = just release) and wake its Bot.
 */
export async function handbackComputer(
  userId: string,
  opts: { note?: string; requestId?: string; sessionId?: string } = {},
): Promise<void> {
  const db = getDb();
  const row = await db.botComputers.setLease(userId, 'bot');
  if (row) {
    logger.info('[bots-computer] handback', { user_id: userId, epoch: row.lease_epoch });
    leaseChanged(row);
  }
  restoreWindowAfterHandback(userId);
  const request = await requestToSettle(userId, opts);
  if (!request) return;
  await settleAndContinue(userId, request, { status: 'resolved', note: cleanNote(opts.note) });
}

/**
 * A decision on a take-over card (POST /api/bots/requests/:id): approve =
 * "done" (same as hand-back for this request), deny = "skip". Either way the
 * lease returns to the Bots and the asking Bot is woken exactly once.
 */
export async function handleTakeoverDecision(args: {
  userId: string;
  request: BotRequestRow;
  decision: BotRequestDecision;
}): Promise<void> {
  const { userId, request, decision } = args;
  const db = getDb();
  const row = await db.botComputers.setLease(userId, 'bot');
  if (row) {
    leaseChanged(row);
    restoreWindowAfterHandback(userId);
  }
  // false = a double click or the other slot settled it first; that one woke the Bot.
  await settleAndContinue(userId, request, {
    status: decision.decision === 'deny' ? 'denied' : 'resolved',
    note: cleanNote(decision.note),
  });
}

/** Viewers gone for 3 minutes: the Bots get the computer back, the request stays open, nothing resumes. */
export async function releaseAbandonedLeases(now = Date.now()): Promise<void> {
  const db = getDb();
  const cutoff = now - ABANDONED_LEASE_MS;
  const rows = await db.botComputers.listAbandonedLeases(new Date(cutoff).toISOString());
  for (const candidate of rows) {
    // A take-over that just started has no viewer heartbeat yet.
    if (candidate.lease_since && Date.parse(candidate.lease_since) > cutoff) continue;
    const row = await db.botComputers.setLease(candidate.user_id, 'bot');
    if (!row) continue;
    logger.info('[bots-computer] lease auto-released', { user_id: row.user_id, epoch: row.lease_epoch });
    leaseChanged(row);
    restoreWindowAfterHandback(row.user_id);
    // The note goes to the conversation whose card is still waiting — only
    // when that is unambiguous; the lease change itself reaches every tab.
    const waiting = await db.bots.listRequests(row.user_id, { status: 'pending', kinds: [...HUMAN_STEP_KINDS] });
    if (waiting.length !== 1) continue;
    const request = waiting[0]!;
    const locale = await localeOf(row.user_id);
    try {
      await deliverToConversation(request.session_id, {
        kind: 'event',
        text: COPY.released(locale),
        event: { kind: 'takeover_released', request_id: request.id, bot_id: request.bot_id },
      });
    } catch (err) {
      logger.warn(`[bots-computer] could not record the auto-release: ${toErrorMessage(err)}`);
    }
  }
}

// ─── Type text (take-over toolbar) ────────────────────────

export class LeaseRequiredError extends Error {
  constructor() {
    super('Take over the computer first');
    this.name = 'LeaseRequiredError';
  }
}

/**
 * Insert text into the focused field of the page the member is looking at
 * (CDP Input.insertText — IME-safe, so Chinese works where VNC key events
 * cannot). Only while the member holds the lease; the value is never logged
 * and joins the redaction set.
 */
export async function typeIntoFocusedField(userId: string, text: string): Promise<void> {
  if (!text || text.length > MAX_TYPE_CHARS) throw new RangeError(`Text must be 1–${MAX_TYPE_CHARS} characters`);
  const row = await getDb().botComputers.get(userId);
  if (row?.lease_controller !== 'user') throw new LeaseRequiredError();
  const browser = await getBrowser(userId);
  const pages = browser.contexts().flatMap((context) => context.pages());
  if (pages.length === 0) throw new ComputerUnavailableError('stopped', 'No page is open on the computer');
  let target = pages[pages.length - 1]!;
  for (const page of pages) {
    const focused = await Promise.race([
      page.evaluate(() => document.hasFocus()).catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500)),
    ]);
    if (focused) {
      target = page;
      break;
    }
  }
  rememberFilledSecret(userId, text);
  await target.keyboard.insertText(text);
}

computerLifecycleHooks.onLeaseTick(() => releaseAbandonedLeases());
