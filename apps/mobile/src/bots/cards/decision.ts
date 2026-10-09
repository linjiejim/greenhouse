/**
 * What a "needs you" card offers and says — pure, so the root vitest can pin
 * every kind's buttons and copy (./decision.test.ts). The views
 * (./request-card.tsx and the kind files beside it, the sheets under
 * app/bots/) only render what these functions decide.
 *
 * Honest button mapping (spec docs/specs/20261008-mobile-bots.md §2.5.4, D11):
 * the phone cannot see the computer, so a human check can only be skipped, a
 * Bot's take-over request is skipped or confirmed as done on the web, and a
 * take-over the computer raised itself is only handed back. Every button maps
 * to one `BotRequestDecision` the server reads exactly that way
 * (apps/api/src/bots/computer/lease.ts — approve = "done, hand back").
 *
 * Ports of web logic that is inlined in components there, each named below:
 * - `settledReceipt` / `statusBadge` ← request-decision.ts `settledLabelKey`
 *   (pinned by a text tripwire in ../vendor/vendor.parity.test.ts — a web
 *   change to it turns that test red here);
 * - `detailRows` ← request-card-parts.tsx `DetailList` (the server's
 *   truncation markers, apps/api/src/bots/engine/tools-assembly.ts);
 * - `decisionErrorKey` ← request-decision.ts `STILL_PENDING_KEYS`;
 * - `LOGIN_PAGE_MOVED` ← login-request-card.tsx `PAGE_MOVED`.
 */

import type {
  BotApprovalPayload,
  BotCreatePayload,
  BotInstructionsUpdatePayload,
  BotLoginPayload,
  BotRequestDecision,
  BotRequestErrorCode,
  BotRequestView,
  BotTakeoverPayload,
  BotTaskStartPayload,
} from '../../shared/bots';
import type { TranslationKey } from '../../lib/i18n';
import type { IconName } from '../../ui/core';
import type { BadgeTone } from '../../ui/list';
import { humanCheckTakeover, implicitTakeover, lineDiff } from '../vendor/web-helpers';

/** A translation: the key and its `{placeholders}`. */
export interface Copy {
  key: TranslationKey;
  vars?: Record<string, string>;
}

// ─── Kinds ───────────────────────────────────────────────

/**
 * How a card reads, one step finer than `BotRequestView.kind`: the three
 * take-over cards look and decide differently, and a kind this app version
 * does not know still gets a line (never a silent gap in the thread).
 */
export type CardKind =
  | 'approval'
  | 'task_start'
  | 'bot_create'
  | 'instructions_update'
  | 'login'
  /** Raised by the computer itself: the member took over mid-action, or holds it while a Bot waits. */
  | 'handback'
  /** A site asked for human verification — done by hand on the computer screen. */
  | 'captcha'
  /** A Bot asked the member to do something on the computer. */
  | 'takeover'
  | 'unknown';

export function cardKind(r: Pick<BotRequestView, 'kind' | 'payload'>): CardKind {
  switch (r.kind) {
    case 'approval':
    case 'task_start':
    case 'bot_create':
    case 'instructions_update':
    case 'login':
      return r.kind;
    case 'takeover':
      if (implicitTakeover(r.payload)) return 'handback';
      return humanCheckTakeover(r.payload) ? 'captcha' : 'takeover';
    default:
      return 'unknown';
  }
}

/** The kind's symbol (the card's icon tile, its receipt, the sheet). */
export const CARD_ICON: Record<CardKind, IconName> = {
  approval: 'shieldCheck',
  task_start: 'hourglass',
  bot_create: 'sparkle',
  instructions_update: 'file',
  login: 'lock',
  handback: 'hand',
  captcha: 'shieldAlert',
  takeover: 'hand',
  unknown: 'alertCircle',
};

// ─── Payload reading (defensive: a payload is server JSON of the kind's shape) ─

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `https://github.com/login` → `github.com`; a bare host stays itself; empty → null. */
export function hostOf(url: string | null | undefined): string | null {
  const raw = (url ?? '').trim();
  if (!raw) return null;
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(raw);
  const host = (match ? match[1] : raw.split(/[/?#:]/)[0]).toLowerCase();
  return host || null;
}

/** What a card is about, for receipts and the sheet's title line; null when nothing is. */
export function cardSubject(r: Pick<BotRequestView, 'kind' | 'payload'>): string | null {
  const kind = cardKind(r);
  if (kind === 'approval') return text((r.payload as BotApprovalPayload).title) || null;
  if (kind === 'task_start') return text((r.payload as BotTaskStartPayload).title) || null;
  if (kind === 'bot_create') return text((r.payload as BotCreatePayload).name) || null;
  if (kind === 'login') {
    const payload = r.payload as BotLoginPayload;
    return hostOf(payload.origin) ?? hostOf(payload.url);
  }
  if (kind === 'handback') return implicitTakeover(r.payload)?.host ?? null;
  if (kind === 'captcha') return hostOf(humanCheckTakeover(r.payload)?.url);
  if (kind === 'takeover') return hostOf((r.payload as BotTakeoverPayload).url);
  return null;
}

/**
 * The card's headline ("{name} needs your approval"); `name` is the Bot's, already resolved.
 * Short in every language — it shares the card's width with the kind icon and must stay on one or
 * two lines with a 24-character name; what the card is about (the site, the task) is its body.
 */
export function cardTitle(r: Pick<BotRequestView, 'kind' | 'payload'>, name: string): Copy {
  switch (cardKind(r)) {
    case 'approval':
      return { key: 'bots.card.approvalTitle', vars: { name } };
    case 'task_start':
      return { key: 'bots.card.taskTitle', vars: { name } };
    case 'bot_create':
      return { key: 'bots.card.createTitle', vars: { name } };
    case 'instructions_update':
      return { key: 'bots.card.instructionsTitle', vars: { name } };
    case 'login': {
      const payload = r.payload as BotLoginPayload;
      if (payload.kind === 'otp') return { key: 'bots.card.otpTitle', vars: { name } };
      return { key: 'bots.card.loginTitle', vars: { name } };
    }
    case 'handback':
      return implicitTakeover(r.payload)?.reason === 'waiting'
        ? { key: 'bots.card.waitingComputer', vars: { name } }
        : { key: 'bots.card.handBackTitle', vars: { name } };
    case 'captcha':
      return { key: 'bots.card.captchaTitle', vars: { name } };
    case 'takeover':
      return { key: 'bots.card.otherTitle', vars: { name } };
    default:
      return { key: 'bots.card.unknownTitle', vars: { name } };
  }
}

// ─── Buttons ─────────────────────────────────────────────

/**
 * One decision button. `approve` / `always` / `deny` / `finished` post a
 * decision (`decisionFor`); `edit` (a proposed Bot → the Bot form) and
 * `signIn` (→ the secure sign-in sheet) open a sheet instead. `confirm` asks
 * first (system alert). At most one per card is `prominent`.
 */
export type CardButton = {
  id: 'approve' | 'always' | 'deny' | 'edit' | 'signIn' | 'finished';
  prominent: boolean;
  confirm?: boolean;
};

/** The buttons of a pending card, secondary first, the prominent one last (§2.5.4); none once settled. */
export function cardButtons(r: BotRequestView): CardButton[] {
  if (r.status !== 'pending') return [];
  switch (cardKind(r)) {
    case 'approval':
      return [
        { id: 'deny', prominent: false },
        ...((r.payload as BotApprovalPayload).allow_always
          ? [{ id: 'always', prominent: false, confirm: true } as const]
          : []),
        { id: 'approve', prominent: true },
      ];
    case 'task_start':
    case 'instructions_update':
      return [
        { id: 'deny', prominent: false },
        { id: 'approve', prominent: true },
      ];
    case 'bot_create':
      return [
        { id: 'deny', prominent: false },
        { id: 'edit', prominent: false },
        { id: 'approve', prominent: true },
      ];
    case 'login':
      return [
        { id: 'deny', prominent: false },
        { id: 'signIn', prominent: true },
      ];
    case 'handback':
      return [{ id: 'approve', prominent: true }];
    // Nobody can pass the check from the phone: answering approve would tell the Bot it was done.
    case 'captcha':
      return [{ id: 'deny', prominent: false }];
    // The server reads approve as "done, hand back" — offered only behind a confirmation.
    case 'takeover':
      return [
        { id: 'deny', prominent: false },
        { id: 'finished', prominent: false, confirm: true },
      ];
    default:
      return [];
  }
}

/** A button's label — one or two words in every language (three may share a row on the card). */
export function buttonLabel(r: Pick<BotRequestView, 'kind' | 'payload'>, id: CardButton['id']): Copy {
  const kind = cardKind(r);
  switch (id) {
    case 'always':
      return { key: 'bots.card.allowAlways' };
    case 'edit':
      return { key: 'bots.card.editFirst' };
    case 'signIn':
      return { key: 'bots.card.signIn' };
    case 'finished':
      return { key: 'bots.card.finished' };
    case 'deny': {
      const deny: Partial<Record<CardKind, TranslationKey>> = {
        task_start: 'bots.card.cancel',
        bot_create: 'bots.card.notNow',
        instructions_update: 'bots.card.decline',
        login: 'bots.card.loginNotNow',
        captcha: 'bots.card.skip',
        takeover: 'bots.card.skip',
      };
      return { key: deny[kind] ?? 'bots.card.deny' };
    }
    case 'approve': {
      if (kind === 'handback') return { key: 'bots.card.handBack' };
      const approve: Partial<Record<CardKind, TranslationKey>> = {
        task_start: 'bots.card.start',
        bot_create: 'bots.card.create',
        instructions_update: 'bots.card.accept',
      };
      return { key: approve[kind] ?? 'bots.card.allowOnce' };
    }
  }
}

/** The decision a button posts; null for the two that open a sheet instead. */
export function decisionFor(id: CardButton['id']): BotRequestDecision | null {
  if (id === 'approve' || id === 'finished') return { decision: 'approve' };
  if (id === 'always') return { decision: 'always' };
  if (id === 'deny') return { decision: 'deny' };
  return null;
}

/**
 * The site an approval's "always allow" covers, for the confirmation: the
 * first detail value that is a web origin (the server puts it first for a
 * vault fill — apps/api/src/bots/vault/fill.ts `approvalPayload`).
 */
export function alwaysSite(payload: Pick<BotApprovalPayload, 'details'>): string | null {
  for (const row of payload.details ?? []) {
    if (/^https?:\/\//i.test(text(row.value))) return hostOf(row.value);
  }
  return null;
}

// ─── Status, receipt, ask again ──────────────────────────

/**
 * The status badge: pending orange; allowed / done green; declined red;
 * expired / canceled neutral. One label per settled state, as the web's
 * `settledLabelKey` (approvals also say whether "always" was chosen).
 */
export function statusBadge(r: Pick<BotRequestView, 'kind' | 'status' | 'result'>): {
  key: TranslationKey;
  tone: BadgeTone;
} {
  if (r.status === 'pending') return { key: 'bots.card.waiting', tone: 'orange' };
  if (r.status === 'denied') return { key: 'bots.card.declined', tone: 'red' };
  if (r.status === 'expired') return { key: 'bots.card.expired', tone: 'neutral' };
  if (r.status === 'canceled') return { key: 'bots.card.canceled', tone: 'neutral' };
  if (r.kind === 'approval') {
    return { key: r.result?.decision === 'always' ? 'bots.card.allowedAlways' : 'bots.card.allowed', tone: 'green' };
  }
  if (r.kind === 'takeover') return { key: 'bots.card.handedBack', tone: 'green' };
  if (r.kind === 'bot_create') return { key: 'bots.card.createdShort', tone: 'green' };
  if (r.kind === 'task_start') return { key: 'bots.card.started', tone: 'green' };
  return { key: 'bots.card.done', tone: 'green' };
}

/**
 * The one line a settled card collapses to: "Allowed · {title}", "Declined",
 * "Created {bot}", "Started · {title}". `botName` names the Bot a `bot_create`
 * card made (its id is in `result.bot_id`; the member may have renamed it in
 * the form) — the proposal's name otherwise.
 */
export function settledReceipt(
  r: Pick<BotRequestView, 'kind' | 'status' | 'payload' | 'result'>,
  botName?: (botId: string) => string | undefined,
): Copy {
  const kind = cardKind(r);
  const subject = cardSubject(r);
  const titled = (plain: TranslationKey, withTitle: TranslationKey): Copy =>
    subject ? { key: withTitle, vars: { title: subject } } : { key: plain };

  if (r.status === 'expired') return titled('bots.card.receipt.expired', 'bots.card.receipt.expiredTitle');
  if (r.status === 'canceled') return titled('bots.card.receipt.canceled', 'bots.card.receipt.canceledTitle');
  if (r.status === 'denied') {
    // Skipping a computer chore is not refusing a Bot something.
    if (kind === 'captcha' || kind === 'takeover' || kind === 'login') {
      return subject
        ? { key: 'bots.card.receipt.skippedHost', vars: { host: subject } }
        : { key: 'bots.card.receipt.skipped' };
    }
    return titled('bots.card.receipt.declined', 'bots.card.receipt.declinedTitle');
  }
  if (r.status !== 'resolved') return { key: 'bots.card.receipt.done' };
  switch (kind) {
    case 'approval':
      return r.result?.decision === 'always'
        ? titled('bots.card.allowedAlways', 'bots.card.receipt.allowedAlways')
        : titled('bots.card.allowed', 'bots.card.receipt.allowed');
    case 'task_start':
      return titled('bots.card.started', 'bots.card.receipt.started');
    case 'bot_create': {
      const made = typeof r.result?.bot_id === 'string' ? botName?.(r.result.bot_id) : undefined;
      return { key: 'bots.card.created', vars: { bot: made ?? subject ?? '' } };
    }
    case 'instructions_update':
      return { key: 'bots.card.receipt.instructions' };
    case 'login':
      return subject
        ? { key: 'bots.card.receipt.signedInHost', vars: { host: subject } }
        : { key: 'bots.card.receipt.signedIn' };
    case 'handback':
    case 'captcha':
    case 'takeover':
      return { key: 'bots.card.receipt.handedBack' };
    default:
      return { key: 'bots.card.receipt.done' };
  }
}

/** Kinds whose expired card offers "Ask Again" (the web's ExpiredFooter users). */
const ASK_AGAIN: ReadonlySet<CardKind> = new Set(['approval', 'task_start', 'bot_create', 'instructions_update']);

/** An expired card the member may re-ask for — a message to the Bot that asked (needs its id). */
export function askAgainOffered(r: Pick<BotRequestView, 'kind' | 'payload' | 'status' | 'bot_id'>): boolean {
  return r.status === 'expired' && !!r.bot_id && ASK_AGAIN.has(cardKind(r));
}

// ─── Refusals ────────────────────────────────────────────

/** A refused decision, by the server's code: a sentence the member can act on (the card stays pending). */
const REFUSAL_KEYS = {
  page_gone: 'bots.card.err.page_gone',
  origin_mismatch: 'bots.card.err.origin_mismatch',
  no_fields: 'bots.card.err.no_fields',
  failed: 'bots.card.err.failed',
  invalid: 'bots.card.err.invalid',
  limit: 'bots.card.err.limit',
  computer_restarted: 'bots.card.err.computer_restarted',
  bot_gone: 'bots.card.err.bot_gone',
} as const satisfies Record<Exclude<BotRequestErrorCode, 'already_decided' | 'deciding'>, TranslationKey>;

function refusalKnown(code: string | null): code is keyof typeof REFUSAL_KEYS {
  return code !== null && Object.prototype.hasOwnProperty.call(REFUSAL_KEYS, code);
}

/** Why a decision was not carried out: no answer, the computer / vault down (503), else by code. */
export function decisionErrorKey(code: BotRequestErrorCode | null, status: number): TranslationKey {
  if (status === 0) return 'bots.card.err.network';
  if (status === 503) return 'bots.card.err.unavailable';
  return refusalKnown(code) ? REFUSAL_KEYS[code] : 'bots.card.err.failed';
}

/**
 * The alert's message for a refusal: our sentence for the codes we know, else
 * the server's own member-facing message (a 400 that names the field), else
 * the generic one — the web's `useRequestDecision` order.
 */
export function refusalCopy(o: { status: number; code: string | null; message: string }): Copy | { text: string } {
  if (o.status === 0 || o.status === 503 || refusalKnown(o.code)) {
    return { key: decisionErrorKey(o.code as BotRequestErrorCode | null, o.status) };
  }
  return o.message.trim() ? { text: o.message.trim() } : { key: 'bots.card.err.failed' };
}

/**
 * Refusals where the sign-in page itself moved on — retyping will not help, a
 * fresh ask will (`computer_restarted`: the restart closed the Bot's tab).
 */
export const LOGIN_PAGE_MOVED: ReadonlySet<string> = new Set<BotRequestErrorCode>([
  'page_gone',
  'origin_mismatch',
  'no_fields',
  'computer_restarted',
]);

// ─── Countdown ───────────────────────────────────────────

/** A countdown shows only in the last minute — a permanent one manufactures anxiety (D11). */
export const COUNTDOWN_WINDOW_MS = 60_000;

/**
 * Seconds left on a pending card that expires: `expires_at − now`, clamped to
 * [0, `expires_at − created_at`] so a device clock running behind never shows
 * more time than the card ever had; shown only in the last 60 s. At 0 the card
 * says "expiring now" until the server flips it to expired (clock skew: the
 * device never decides it is over).
 */
export function countdown(
  r: Pick<BotRequestView, 'status' | 'expires_at' | 'created_at'>,
  now: number,
): { show: boolean; seconds: number } {
  const end = r.status === 'pending' && r.expires_at ? Date.parse(r.expires_at) : NaN;
  if (!Number.isFinite(end)) return { show: false, seconds: 0 };
  const start = Date.parse(r.created_at);
  const total = Number.isFinite(start) ? Math.max(0, end - start) : Infinity;
  const left = Math.min(Math.max(end - now, 0), total);
  return { show: left <= COUNTDOWN_WINDOW_MS, seconds: Math.ceil(left / 1000) };
}

/** How long until `countdown` reads differently (the view's next tick); null = never again. */
export function countdownNextChange(
  r: Pick<BotRequestView, 'status' | 'expires_at' | 'created_at'>,
  now: number,
): number | null {
  const end = r.status === 'pending' && r.expires_at ? Date.parse(r.expires_at) : NaN;
  if (!Number.isFinite(end)) return null;
  const { show, seconds } = countdown(r, now);
  if (show && seconds === 0) return null;
  // The clamped value crosses a threshold below the clamp exactly when the raw one does:
  // the window opening, else the next whole second.
  const threshold = show ? (seconds - 1) * 1000 : COUNTDOWN_WINDOW_MS;
  return Math.max(1, Math.ceil(Math.max(end - now, 0) - threshold));
}

// ─── Details and diffs ───────────────────────────────────

/** `…(+N more characters)`: the server cut a long value (apps/api/src/bots/engine/tools-assembly.ts). */
const MORE_CHARACTERS = /…\(\+(\d+) more characters\)$/;
/** `+K more field(s)` on a `…` row: fields past the card's total budget, counted instead of dropped. */
const MORE_FIELDS = /^\+(\d+) more fields?$/;

export interface DetailRow {
  label: string;
  /** The value without the server's truncation marker. */
  value: string;
  /** Characters the server cut off the end, when it did. */
  moreChars: number | null;
}

/**
 * An approval's server-derived detail rows, with the server's English
 * truncation markers taken out of the values (the views say them in the
 * member's language): `…(+N more characters)` at the end of a value, and a
 * `…` row `+K more fields` for fields past the card's budget.
 */
export function detailRows(details: ReadonlyArray<{ label: string; value: string }> | null | undefined): {
  rows: DetailRow[];
  hiddenFields: number | null;
} {
  const rows: DetailRow[] = [];
  let hiddenFields: number | null = null;
  for (const row of details ?? []) {
    const label = typeof row.label === 'string' ? row.label : '';
    const value = typeof row.value === 'string' ? row.value : '';
    const fields = label === '…' ? MORE_FIELDS.exec(value) : null;
    if (fields) {
      hiddenFields = Number(fields[1]);
      continue;
    }
    const cut = MORE_CHARACTERS.exec(value);
    rows.push({ label, value: cut ? value.slice(0, cut.index) : value, moreChars: cut ? Number(cut[1]) : null });
  }
  return { rows, hiddenFields };
}

/** Detail rows on the card itself; the rest is behind "View All" (the card sheet). */
export const CARD_DETAIL_ROWS = 3;
/** A value longer than this likely wraps past the card's two lines. */
const LONG_VALUE = 80;

/** Whether the card's preview hides anything the sheet would show. */
export function detailsTruncated(d: ReturnType<typeof detailRows>): boolean {
  return (
    d.rows.length > CARD_DETAIL_ROWS ||
    d.hiddenFields !== null ||
    d.rows.some((row) => row.moreChars !== null || row.value.length > LONG_VALUE || row.value.includes('\n'))
  );
}

/** "+3 lines · −1 line" for an instructions proposal: lines only one side has. */
export function diffCounts(payload: Pick<BotInstructionsUpdatePayload, 'current' | 'instructions'>): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of lineDiff(text(payload.current), text(payload.instructions))) {
    if (line.kind === 'added') added += 1;
    else if (line.kind === 'removed') removed += 1;
  }
  return { added, removed };
}
