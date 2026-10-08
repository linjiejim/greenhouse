/**
 * Vault fills — the server types the member's saved login (or a fresh TOTP
 * code) straight into the Bot's browser page. The Bot names an entry id and
 * gets back `{filled, origin, fields}`; no value ever appears in a tool
 * result, a log line, a stream event or an error.
 *
 * Order of checks (spec §8, design-review R10):
 * 1. The member is not holding the computer; the Bot has a foreground tab.
 * 2. The page's main-frame origin — read from the browser over CDP, never
 *    from model text — matches the entry's sites; otherwise `origin_mismatch`.
 * 3. Approval when the entry's policy is `ask` and this origin was never
 *    "always allowed"; ALWAYS when the turn was not started by the member
 *    (a hand-off, follow-up or continuation could be steered by a web page);
 *    and ALWAYS when this turn read another site or outside content (shell,
 *    files, search, mail — vault/turn-observations.ts), because that content
 *    could be what asked for the sign-in. The card shows the CDP origin (and
 *    the other sites read). "Always" is stored per (entry, origin).
 * 4. After the decision: the member still has not taken the computer (the
 *    lease is re-read right before anything is revealed, and again before
 *    each field and the Enter), the main frame's document (CDP loader id) is
 *    still the one the member approved, fields are located fresh, and right
 *    before EACH fill the owning frame of that field is re-checked against
 *    the entry's sites. Element handles die with their document, so a
 *    navigation between the check and the fill makes the fill throw instead
 *    of typing into the new page.
 * 5. Every value is registered with the computer's redaction set before it
 *    is typed; every attempt is written to the access log.
 *
 * A fill that meets the member at the computer (holding it when the call
 * comes, or taking it over mid-fill) leaves an implicit take-over card, like
 * the browser does, so their hand-back wakes the Bot.
 *
 * `fillSecureLogin` is the same path for values the member typed into a
 * secure sign-in card (no approval — the member is the one acting). It also
 * follows a two-step sign-in (user name first, password on the next screen)
 * for a few seconds, on the same origin only, so the member types once. When
 * the Bot's page is gone (the computer stopped and came back since the card
 * was raised) it reopens the card's URL in the Bot's tab first.
 */

import type { BrowserContext, ElementHandle, Frame, Page } from 'playwright-core';
import type { DatabaseProvider, VaultItemRow } from '@greenhouse/db';
import type { BotApprovalPayload } from '@greenhouse/types/bots';
import { logger } from '@greenhouse/utils/logger';
import type { ApprovalDecision } from '../engine/context.js';
import {
  abortable,
  afterLeaseChange,
  defaultComputerDeps,
  failure,
  findLeasePage,
  isAbortedError,
  memberInControl,
  normalizeBrowseUrl,
  openLeasePage,
  throwIfAborted,
  toFailure,
  type ComputerDeps,
  type ImplicitTakeover,
  type ImplicitTakeoverOutcome,
  type ToolFailure,
} from '../computer/browser-session.js';
import { ComputerUnavailableError } from '../computer/access.js';
import { sniffNeedsHuman, type NeedsHumanKind } from '../computer/needs-human.js';
import { VaultError, isVaultAvailable } from './crypto.js';
import { hostOfOrigin, isGreenhouseOrigin, originMatches, originOfUrl } from './origin.js';
import {
  addAlwaysOrigin,
  recordVaultAccess,
  revealVaultSecrets,
  vaultItemAlwaysOrigins,
  vaultItemOrigins,
} from './service.js';
import { currentTotp } from './totp.js';
import type { ForeignReads } from './turn-observations.js';

// ─── Turn view ────────────────────────────────────────────

export interface FillTurn {
  db: DatabaseProvider;
  userId: string;
  botId: string;
  botName: string;
  sessionId: string;
  locale: 'en' | 'zh';
  background: boolean;
  /** The member asked this Bot directly in this turn (stricter rules otherwise). */
  userTriggered: boolean;
  /**
   * What this turn read outside the entry's sites (vault/turn-observations.ts):
   * other origins, or outside content with no origin. Null = nothing.
   */
  observedForeign(patterns: readonly string[]): ForeignReads | null;
  signal: AbortSignal;
  requestApproval(payload: BotApprovalPayload, opts?: { timeoutMs?: number }): Promise<ApprovalDecision>;
  /** See ComputerTurn.implicitTakeover (browser-session.ts). */
  implicitTakeover?(info: ImplicitTakeover): Promise<ImplicitTakeoverOutcome>;
}

export interface FillResult {
  filled: true;
  origin: string;
  fields: Array<'username' | 'password' | 'otp'>;
  submitted: boolean;
  note?: string;
}

type FieldName = 'username' | 'password' | 'otp';

/** A fill was refused at the last moment (page changed, field moved to another site…). */
class FillAbort extends Error {
  constructor(
    readonly code: 'origin_mismatch' | 'page_changed' | 'no_fields',
    message: string,
  ) {
    super(message);
  }
}

// ─── Page facts from CDP ──────────────────────────────────

interface MainFrameFacts {
  origin: string | null;
  /** Changes only when the main frame loads a new document (not on pushState/hash). */
  loaderId: string;
}

/**
 * The main frame's URL and document identity straight from the browser
 * (`Page.getFrameTree`) — what the approval card shows and what step 4
 * compares against.
 */
async function mainFrameFacts(context: BrowserContext, page: Page): Promise<MainFrameFacts> {
  const session = await context.newCDPSession(page);
  try {
    const { frameTree } = (await session.send('Page.getFrameTree')) as {
      frameTree: { frame: { url: string; urlFragment?: string; loaderId: string } };
    };
    return { origin: originOfUrl(frameTree.frame.url), loaderId: frameTree.frame.loaderId };
  } finally {
    await session.detach().catch(() => undefined);
  }
}

// ─── Field location ───────────────────────────────────────

const NOT_BUTTONS =
  ':not([type="hidden"]):not([type="password"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="image"])';

const USERNAME_SELECTORS = [
  `input[autocomplete~="username" i]${NOT_BUTTONS}`,
  `input[autocomplete~="email" i]${NOT_BUTTONS}`,
  'input[type="email"]',
  ['user', 'email', 'login', 'account']
    .map((w) => `input[name*="${w}" i]${NOT_BUTTONS}, input[id*="${w}" i]${NOT_BUTTONS}`)
    .join(', '),
];

const OTP_SELECTORS = [
  'input[autocomplete~="one-time-code" i]',
  'input[name*="otp" i], input[id*="otp" i], input[name*="totp" i], input[id*="totp" i], input[name*="2fa" i], input[name*="mfa" i]',
  `input[name*="code" i]${NOT_BUTTONS}, input[id*="code" i]${NOT_BUTTONS}`,
  `input[inputmode="numeric"]${NOT_BUTTONS}`,
];

async function visibleHandles(frame: Frame, selector: string): Promise<ElementHandle[]> {
  const handles = await frame
    .locator(selector)
    .elementHandles()
    .catch(() => [] as ElementHandle[]);
  const out: ElementHandle[] = [];
  for (const handle of handles) {
    const ok = (await handle.isVisible().catch(() => false)) && (await handle.isEditable().catch(() => false));
    if (ok) out.push(handle);
  }
  return out;
}

async function findPassword(frame: Frame): Promise<ElementHandle | null> {
  const fields = await visibleHandles(frame, 'input[type="password"]');
  for (const field of fields) {
    const auto = ((await field.getAttribute('autocomplete').catch(() => '')) ?? '').toLowerCase();
    if (!auto.includes('new-password')) return field;
  }
  return fields[0] ?? null;
}

async function findUsername(frame: Frame, password: ElementHandle | null): Promise<ElementHandle | null> {
  for (const selector of USERNAME_SELECTORS) {
    const [first] = await visibleHandles(frame, selector);
    if (first) return first;
  }
  if (!password) return null;
  // Last resort: the visible text-like input right before the password field.
  const handle = await password
    .evaluateHandle((pw) => {
      const field = pw as HTMLInputElement;
      const scope: ParentNode = field.form ?? document;
      const candidates = Array.from(scope.querySelectorAll('input')).filter((input) => {
        const type = (input.getAttribute('type') ?? 'text').toLowerCase();
        const rect = input.getBoundingClientRect();
        return ['text', 'email', 'tel', ''].includes(type) && rect.width > 0 && rect.height > 0;
      });
      const before = candidates.filter(
        (input) => input.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      return before[before.length - 1] ?? null;
    })
    .catch(() => null);
  return handle?.asElement() ?? null;
}

/** One OTP input, or a row of single-digit boxes. */
async function findOtp(frame: Frame, digits: number): Promise<ElementHandle[] | null> {
  const boxes = (await visibleHandles(frame, 'input[maxlength="1"]')).slice(0, digits);
  if (boxes.length === digits) return boxes;
  for (const selector of OTP_SELECTORS) {
    for (const handle of await visibleHandles(frame, selector)) {
      // "code" also names postcodes, promo codes and phone prefixes.
      const unrelated = await handle
        .evaluate((el) => {
          const input = el as HTMLInputElement;
          return /post|zip|promo|coupon|country|area|phone|discount|gift|captcha/i.test(
            `${input.name} ${input.id} ${input.getAttribute('aria-label') ?? ''}`,
          );
        })
        .catch(() => true);
      if (!unrelated) return [handle];
    }
  }
  return null;
}

interface LocatedFields {
  username?: ElementHandle;
  password?: ElementHandle;
  otp?: ElementHandle[];
}

/**
 * Locate the wanted fields in the main frame, then in child frames whose own
 * origin is one of the entry's sites (an embedded sign-in widget).
 */
async function locateFields(
  page: Page,
  patterns: readonly string[],
  want: ReadonlySet<FieldName>,
  digits = 6,
): Promise<LocatedFields> {
  const frames = [
    page.mainFrame(),
    ...page.frames().filter((f) => f !== page.mainFrame() && originMatches(patterns, originOfUrl(f.url()))),
  ];
  const found: LocatedFields = {};
  for (const frame of frames) {
    if (want.has('password') && !found.password) found.password = (await findPassword(frame)) ?? undefined;
    if (want.has('username') && !found.username) {
      found.username = (await findUsername(frame, found.password ?? null)) ?? undefined;
    }
    if (want.has('otp') && !found.otp) found.otp = (await findOtp(frame, digits)) ?? undefined;
  }
  return found;
}

// ─── Verified fill ────────────────────────────────────────

interface FillGuard {
  context: BrowserContext;
  page: Page;
  patterns: readonly string[];
  origin: string;
  loaderId: string;
}

/**
 * Re-check, immediately before typing, that the field's own frame belongs to
 * one of the entry's sites and that the main frame still shows the document
 * the decision was made on — then type.
 */
async function verifiedFill(guard: FillGuard, handle: ElementHandle, value: string): Promise<void> {
  const frame = await handle.ownerFrame();
  if (!frame || frame.isDetached()) throw new FillAbort('page_changed', 'The page changed before the fill.');
  const facts = await mainFrameFacts(guard.context, guard.page);
  if (facts.loaderId !== guard.loaderId || facts.origin !== guard.origin) {
    throw new FillAbort('page_changed', 'The page changed before the fill.');
  }
  const frameOrigin = originOfUrl(frame.url());
  if (!originMatches(guard.patterns, frameOrigin)) {
    throw new FillAbort('origin_mismatch', 'The field belongs to a different site than the vault entry.');
  }
  await handle.fill(value, { timeout: 5_000 });
}

/**
 * Fill the located fields. `beforeStep` runs before each field and before the
 * Enter (a vault fill re-checks there that the member has not taken over).
 */
async function fillLocated(
  guard: FillGuard,
  fields: LocatedFields,
  values: { username?: string; password?: string; otp?: string },
  submit: boolean,
  beforeStep: () => Promise<void> = async () => undefined,
): Promise<{ fields: FieldName[]; submitted: boolean }> {
  const filled: FieldName[] = [];
  if (values.username && fields.username) {
    await beforeStep();
    await verifiedFill(guard, fields.username, values.username);
    filled.push('username');
  }
  if (values.password && fields.password) {
    await beforeStep();
    await verifiedFill(guard, fields.password, values.password);
    filled.push('password');
  }
  if (values.otp && fields.otp?.length) {
    await beforeStep();
    if (fields.otp.length === 1) {
      await verifiedFill(guard, fields.otp[0]!, values.otp);
    } else {
      const digits = [...values.otp];
      for (let i = 0; i < fields.otp.length; i++) await verifiedFill(guard, fields.otp[i]!, digits[i] ?? '');
    }
    filled.push('otp');
  }
  if (filled.length === 0) throw new FillAbort('no_fields', 'No matching sign-in fields were found on the page.');

  let submitted = false;
  if (submit) {
    const last = fields.otp?.[fields.otp.length - 1] ?? fields.password ?? fields.username;
    if (last) {
      await beforeStep();
      await last.press('Enter', { timeout: 5_000 }).catch(() => undefined);
      submitted = true;
      await guard.page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => undefined);
    }
  }
  return { fields: filled, submitted };
}

// ─── Copy ─────────────────────────────────────────────────

function approvalPayload(
  turn: FillTurn,
  item: VaultItemRow,
  origin: string,
  kind: 'login' | 'totp',
  opts: { foreign: ForeignReads | null; allowAlways: boolean },
): BotApprovalPayload {
  const host = hostOfOrigin(origin);
  const zh = turn.locale === 'zh';
  const details: BotApprovalPayload['details'] = [
    { label: zh ? '网站' : 'Site', value: origin },
    { label: zh ? '密码库条目' : 'Login', value: item.label },
  ];
  if (item.username_hint) details.push({ label: zh ? '用户名' : 'Username', value: item.username_hint });
  if (opts.foreign) {
    // Why a card shows for an entry that is normally filled without one —
    // server-derived (the turn's ledger), never model text.
    const sites = opts.foreign.origins.slice(0, 3).map(hostOfOrigin);
    const more = opts.foreign.origins.length - sites.length;
    const list = [
      ...sites,
      ...(more > 0 ? [zh ? `另 ${more} 个网站` : `${more} more`] : []),
      ...(opts.foreign.outside ? [zh ? '命令输出、文件或搜索结果' : 'command output, files or search results'] : []),
    ].join(zh ? '、' : ', ');
    details.push({
      label: zh ? '为什么要确认' : 'Why you are asked',
      value: zh ? `这一轮里 Bot 还读了其他内容：${list}` : `In this turn the Bot also read: ${list}`,
    });
  }
  const title =
    kind === 'login'
      ? zh
        ? `允许 ${turn.botName} 用密码库登录 ${host}？`
        : `Let ${turn.botName} sign in to ${host} with your saved login?`
      : zh
        ? `允许 ${turn.botName} 在 ${host} 填入动态验证码？`
        : `Let ${turn.botName} fill a one-time code on ${host}?`;
  // The transcript line / notification: "<Bot> asks to <summary>" (engine/copy.ts approvalLine).
  const summary =
    kind === 'login'
      ? zh
        ? `用密码库登录 ${host}`
        : `sign in to ${host} with your saved login`
      : zh
        ? `在 ${host} 填入动态验证码`
        : `fill a one-time code on ${host}`;
  return { action: 'vault_fill', title, summary, details, allow_always: opts.allowAlways };
}

// ─── Tool entry points ────────────────────────────────────

type Approval = 'auto' | 'once' | 'always';

async function fillFromVault(
  turn: FillTurn,
  input: { item_id: string; submit?: boolean },
  kind: 'login' | 'totp',
  deps: ComputerDeps,
): Promise<FillResult | ToolFailure> {
  const action = kind === 'login' ? 'fill_login' : 'fill_totp';
  if (turn.background) return failure('not_allowed', 'The vault is not available in background tasks.');
  if (!isVaultAvailable())
    return failure('vault_unavailable', 'The password vault is not configured on this deployment.');

  const item = await turn.db.vault.get(turn.userId, input.item_id);
  if (!item) return failure('not_found', `No vault entry ${input.item_id}. Use vault list to see the entries.`);
  if (kind === 'login' && !item.username_enc && !item.password_enc) {
    return failure('invalid', 'That vault entry has no user name or password saved.');
  }
  if (kind === 'totp' && !item.totp_enc) {
    return failure(
      'invalid',
      'That vault entry has no authenticator (TOTP) secret. Use request_takeover with kind "otp".',
    );
  }

  const log = (
    origin: string,
    outcome: 'filled' | 'denied' | 'origin_mismatch' | 'failed',
    approval: Approval | null,
  ) =>
    recordVaultAccess(turn.db, {
      user_id: turn.userId,
      item_id: item.id,
      item_label: item.label,
      bot_id: turn.botId,
      session_id: turn.sessionId,
      origin,
      action,
      outcome,
      approval,
    });

  let origin: string | null = null;
  let approval: Approval | null = null;
  // Registered like a browser action: a take-over in this process aborts it.
  const tracked = deps.trackAction(turn.userId, turn.signal);
  try {
    const lease0 = await deps.currentLease(turn.userId);
    if (lease0.controller === 'user') return await memberInControl(turn, { reason: 'waiting' });
    // The member has not taken the computer since this call began (another
    // API slot's take-over shows only in the DB lease, hence the read).
    const stillOurs = async () => {
      throwIfAborted(tracked.signal);
      const now = await deps.currentLease(turn.userId);
      if (now.controller === 'user') {
        throw new ComputerUnavailableError('user_in_control', 'The member took over the computer');
      }
      if (now.epoch !== lease0.epoch) {
        throw new FillAbort('page_changed', 'The member used the computer meanwhile, so the page may have changed.');
      }
    };
    const found = await findLeasePage(turn.userId, turn.botId, turn.sessionId, deps);
    if (!found) return failure('no_tab', 'Open the sign-in page in your browser tab first.');
    const { page } = found;
    // Serialised with the Bot's other actions on this tab lease, so a
    // parallel browser call cannot click or navigate while the fill types.
    // abortable() outside the queue: a stopped call stops waiting, while the
    // queue still waits for the fill itself to finish.
    return await abortable(
      found.lease.run(async () => {
        await stillOurs();
        const context = page.context();
        const patterns = vaultItemOrigins(item);

        // 2. The site, from the browser.
        const facts = await mainFrameFacts(context, page);
        if (!facts.origin || isGreenhouseOrigin(facts.origin) || !originMatches(patterns, facts.origin)) {
          await log(facts.origin ?? originOfUrl(page.url()) ?? 'unknown', 'origin_mismatch', null);
          return failure(
            'origin_mismatch',
            `Your page is on ${facts.origin ?? 'a non-web page'}, which is not one of this entry's sites (${patterns.join(', ')}). Open the right sign-in page first.`,
          );
        }
        origin = facts.origin;

        const want = new Set<FieldName>(kind === 'login' ? ['username', 'password'] : ['otp']);
        const preview = await locateFields(page, patterns, want);
        if (!preview.username && !preview.password && !preview.otp) {
          return failure(
            'no_fields',
            kind === 'login'
              ? 'There are no sign-in fields on this page. Open the sign-in form first (click "Sign in"), then try again.'
              : 'There is no one-time-code field on this page yet. Continue the sign-in until the code is asked for.',
          );
        }

        // 3. Approval. Reading another site (or outside content) in this turn
        // forces the card even for auto / always-allowed entries: that
        // content may be what asked for this sign-in.
        const alwaysHere = vaultItemAlwaysOrigins(item).includes(origin);
        const policyAsks = item.policy === 'ask' && !alwaysHere;
        const foreign = turn.observedForeign(patterns);
        approval = alwaysHere ? 'always' : 'auto';
        if (policyAsks || !turn.userTriggered || foreign) {
          const decision = await turn.requestApproval(
            approvalPayload(turn, item, origin, kind, {
              foreign,
              // "Always" would not skip the next card in such a turn either;
              // offer it only when the entry's own policy is what asks.
              allowAlways: policyAsks,
            }),
          );
          if (decision === 'deny' || decision === 'expired') {
            await log(origin, 'denied', null);
            return failure(
              decision === 'deny' ? 'denied' : 'expired',
              decision === 'deny'
                ? 'The member declined this sign-in. Do not retry unless they ask; tell them what you need.'
                : 'The member did not answer the approval in time. Tell them you are waiting to sign in.',
            );
          }
          approval = decision === 'always' ? 'always' : 'once';
          if (decision === 'always') await addAlwaysOrigin(turn.db, turn.userId, item, origin);
        }

        // 4. Still ours → same document as approved → fresh fields → verified
        // fills, re-checking the lease before each field and the Enter.
        await stillOurs();
        const after = await mainFrameFacts(context, page);
        if (after.loaderId !== facts.loaderId || after.origin !== origin) {
          await log(origin, 'origin_mismatch', approval);
          return failure(
            'page_changed',
            'The page changed while waiting, so nothing was filled. Check the page and try again.',
          );
        }
        const values =
          kind === 'login'
            ? revealVaultSecrets(turn.userId, item, ['username', 'password'])
            : await freshTotp(turn, item);
        for (const value of Object.values(values)) if (value) deps.remember(turn.userId, value);

        const fields = await locateFields(page, patterns, want, 'otp' in values ? (values.otp?.length ?? 6) : 6);
        const guard: FillGuard = { context, page, patterns, origin, loaderId: facts.loaderId };
        const result = await fillLocated(guard, fields, values, input.submit === true, stillOurs);
        await log(origin, 'filled', approval);
        await turn.db.vault.touch(turn.userId, item.id).catch(() => undefined);
        void deps.touch(turn.userId).catch(() => undefined);

        const note =
          kind === 'login' && result.fields.length === 1 && result.fields[0] === 'username'
            ? 'Only the user name field was on this page. Continue to the password step, then call fill_login again.'
            : result.submitted
              ? 'Submitted. Take a snapshot to see the result.'
              : 'Filled. Click the sign-in button (or call again with submit: true).';
        return { filled: true as const, origin, fields: result.fields, submitted: result.submitted, note };
      }),
      tracked.signal,
    );
  } catch (err) {
    if (err instanceof FillAbort) {
      await log(origin ?? 'unknown', err.code === 'no_fields' ? 'failed' : 'origin_mismatch', approval);
      return failure(err.code, `${err.message} The fill stopped there; take a snapshot before trying again.`);
    }
    if (err instanceof VaultError) return failure(err.code, err.message);
    if (err instanceof ComputerUnavailableError && err.code === 'user_in_control') {
      // Taken over mid-fill: a card for the hand-back, or the member already gave it back.
      const host = origin ? hostOfOrigin(origin) : undefined;
      return await afterLeaseChange(turn, deps, () => ({ reason: 'interrupted', ...(host ? { host } : {}) }));
    }
    if (err instanceof ComputerUnavailableError) return toFailure(err, (t) => t);
    if (isAbortedError(err)) return failure('aborted', 'Stopped before the fill finished.');
    // Never forward a Playwright message from the fill path: it could quote
    // the page around a typed value. Log the class of failure only.
    logger.warn('[bots/vault] fill failed', { userId: turn.userId, item: item.id, action, error: errorClass(err) });
    if (origin) await log(origin, 'failed', approval);
    return failure('failed', 'The fill did not go through. Take a snapshot to check the page.');
  } finally {
    tracked.done();
  }
}

/** A TOTP code that will not expire before the page can use it. */
async function freshTotp(turn: FillTurn, item: VaultItemRow): Promise<{ otp?: string }> {
  const secret = revealVaultSecrets(turn.userId, item, ['totp']).totp;
  if (!secret) return {};
  let current = currentTotp(secret);
  if (current.validForSec < 3) {
    await new Promise((resolve) => setTimeout(resolve, current.validForSec * 1000 + 250));
    current = currentTotp(secret);
  }
  return { otp: current.code };
}

function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export function fillLogin(
  turn: FillTurn,
  input: { item_id: string; submit?: boolean },
  deps: ComputerDeps = defaultComputerDeps,
): Promise<FillResult | ToolFailure> {
  return fillFromVault(turn, input, 'login', deps);
}

export function fillTotp(
  turn: FillTurn,
  input: { item_id: string; submit?: boolean },
  deps: ComputerDeps = defaultComputerDeps,
): Promise<FillResult | ToolFailure> {
  return fillFromVault(turn, input, 'totp', deps);
}

// ─── Secure sign-in card ──────────────────────────────────

export type SecureLoginErrorCode =
  | 'invalid'
  | 'page_gone'
  | 'origin_mismatch'
  | 'no_fields'
  | 'failed'
  /** The computer stopped and came back since the card was raised, and the page could not be reopened. */
  | 'computer_restarted';

/** Why a secure sign-in could not be filled; `message` is safe to show the member. */
export class SecureLoginError extends Error {
  constructor(
    readonly code: SecureLoginErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SecureLoginError';
  }
}

/** What a secure sign-in did. Field names only — never a value. */
export interface SecureLoginResult {
  /** Fields filled, across every step of the sign-in. */
  fields: FieldName[];
  submitted: boolean;
  /** Values the member gave that had nowhere to go (e.g. the password of a two-step sign-in whose next screen never came). */
  pending: FieldName[];
  /** What the page asks a person for after the last submit (an OTP the member did not give, a CAPTCHA…). */
  next: NeedsHumanKind | null;
}

/** How long a secure sign-in follows a two-step page to its next screen. */
const NEXT_STEP_WAIT_MS = 8_000;
const NEXT_STEP_POLL_MS = 250;
/** At most user name → password → code. */
const MAX_FOLLOW_STEPS = 2;

/**
 * Fill what the member typed into a secure sign-in card into the Bot's page.
 * No approval (the member is acting), but the same origin and document
 * checks as a vault fill: the page must still be on the origin the card was
 * raised for.
 */
export async function fillSecureLogin(
  args: {
    userId: string;
    botId: string;
    sessionId: string;
    origin: string;
    values: { username?: string; password?: string; otp?: string };
    submit: boolean;
    /**
     * The card's page (origin + path, server-derived when it was raised). If
     * the Bot's tab is gone, it is reopened there before filling.
     */
    reopenUrl?: string | null;
    /** Why the page may be gone: the computer restarted since the card (decides the error code). */
    restarted?: boolean;
  },
  deps: ComputerDeps = defaultComputerDeps,
  opts: { nextStepWaitMs?: number } = {},
): Promise<SecureLoginResult> {
  // Browser work (keeps this process's DevTools ownership while it types).
  const tracked = deps.trackAction(args.userId, new AbortController().signal);
  try {
    let found: Awaited<ReturnType<typeof findLeasePage>> = null;
    try {
      found = await findLeasePage(args.userId, args.botId, args.sessionId, deps);
    } catch (err) {
      // Busy (another API slot drives the browser) or down: reopening would hit the same wall.
      if (err instanceof ComputerUnavailableError) {
        throw new SecureLoginError(
          'failed',
          'The computer is not available right now. Try again in a minute, or use “Open computer”.',
        );
      }
    }
    const { page, lease } = found ?? (await reopenCardPage(args, deps));
    return await lease.run(() => secureFillOnPage(args, page, deps, opts.nextStepWaitMs ?? NEXT_STEP_WAIT_MS));
  } catch (err) {
    if (err instanceof SecureLoginError) throw err;
    if (err instanceof FillAbort) {
      throw new SecureLoginError(
        err.code === 'no_fields' ? 'no_fields' : 'origin_mismatch',
        err.code === 'no_fields'
          ? 'Could not find the sign-in fields on the page. Use “Open computer” to sign in yourself.'
          : 'The page changed while signing in. Use “Open computer” to finish yourself.',
      );
    }
    // As with vault fills, never forward a Playwright message from this path.
    logger.warn('[bots/vault] secure sign-in fill failed', { userId: args.userId, error: errorClass(err) });
    throw new SecureLoginError('failed', 'Signing in did not go through. Use “Open computer” to finish yourself.');
  } finally {
    tracked.done();
  }
}

/**
 * The Bot's page is gone — usually because the computer was stopped and
 * started again since the card was raised. Reopen the card's URL (origin and
 * path the server read from the Bot's tab, never model text) in the Bot's
 * foreground tab, so the member's values still reach a page; the origin
 * checks in secureFillOnPage then apply as always. Without a URL to reopen,
 * say why there is no page.
 */
async function reopenCardPage(
  args: Parameters<typeof fillSecureLogin>[0],
  deps: ComputerDeps,
): Promise<NonNullable<Awaited<ReturnType<typeof findLeasePage>>>> {
  const target = args.reopenUrl ? normalizeBrowseUrl(args.reopenUrl) : null;
  if (!target || 'code' in target || originOfUrl(target.url) !== args.origin) {
    throw args.restarted
      ? new SecureLoginError(
          'computer_restarted',
          'The computer restarted since the Bot asked, so its page is gone. Ask the Bot to open the page again, or use “Open computer” to sign in yourself.',
        )
      : new SecureLoginError(
          'page_gone',
          "The Bot's page is no longer open. Use “Open computer” to sign in yourself, or ask the Bot to open the page again.",
        );
  }
  try {
    await deps.ensureReady(args.userId);
    return await openLeasePage(args.userId, args.botId, args.sessionId, target.url, deps);
  } catch (err) {
    if (err instanceof ComputerUnavailableError) {
      throw new SecureLoginError(
        'failed',
        'The computer could not be started to reopen the sign-in page. Try again in a minute, or use “Open computer”.',
      );
    }
    logger.warn('[bots/vault] reopening the sign-in page failed', { userId: args.userId, error: errorClass(err) });
    throw new SecureLoginError(
      'page_gone',
      'The sign-in page could not be reopened. Use “Open computer” to sign in yourself.',
    );
  }
}

type SecureValues = { username?: string; password?: string; otp?: string };

function wantedFields(values: SecureValues): Set<FieldName> {
  const want = new Set<FieldName>();
  if (values.username) want.add('username');
  if (values.password) want.add('password');
  if (values.otp) want.add('otp');
  return want;
}

async function secureFillOnPage(
  args: Parameters<typeof fillSecureLogin>[0],
  page: Page,
  deps: ComputerDeps,
  nextStepWaitMs: number,
): Promise<SecureLoginResult> {
  const context = page.context();
  const facts = await mainFrameFacts(context, page);
  if (facts.origin !== args.origin || isGreenhouseOrigin(facts.origin)) {
    throw new SecureLoginError(
      'origin_mismatch',
      `The page moved to ${facts.origin ?? 'another page'} since the Bot asked. Use “Open computer” to sign in yourself.`,
    );
  }
  for (const value of Object.values(args.values)) if (value) deps.remember(args.userId, value);

  const patterns = [args.origin];
  const digits = args.values.otp?.length ?? 6;
  const fields = await locateFields(page, patterns, wantedFields(args.values), digits);
  const first = await fillLocated(
    { context, page, patterns, origin: args.origin, loaderId: facts.loaderId },
    fields,
    args.values,
    args.submit,
  );
  const filled = [...first.fields];
  let submitted = first.submitted;

  // Two-step sign-in (Google, Microsoft, Apple…): the user name went in and
  // was submitted, and the password — or the code — belongs to the next
  // screen. Follow the page for a few seconds so the member types once. The
  // values never leave this call; nothing is filled unless the page is still
  // on the card's origin, and every fill is verified like the first.
  let rest: SecureValues = {
    ...(args.values.password && !filled.includes('password') ? { password: args.values.password } : {}),
    ...(args.values.otp && !filled.includes('otp') ? { otp: args.values.otp } : {}),
  };
  for (let step = 0; submitted && (rest.password || rest.otp) && step < MAX_FOLLOW_STEPS; step++) {
    const next = await waitForNextStep(page, args.origin, rest, digits, nextStepWaitMs);
    if (!next) break;
    const more = await fillLocated(
      { context, page, patterns, origin: args.origin, loaderId: next.loaderId },
      next.fields,
      rest,
      args.submit,
    );
    filled.push(...more.fields);
    submitted = more.submitted;
    rest = {
      ...(rest.password && !more.fields.includes('password') ? { password: rest.password } : {}),
      ...(rest.otp && !more.fields.includes('otp') ? { otp: rest.otp } : {}),
    };
  }
  const pending: FieldName[] = [
    ...(args.values.username && !filled.includes('username') ? (['username'] as const) : []),
    ...(rest.password ? (['password'] as const) : []),
    ...(rest.otp ? (['otp'] as const) : []),
  ];
  void deps.touch(args.userId).catch(() => undefined);
  return { fields: filled, submitted, pending, next: submitted ? await sniffAfterSubmit(page) : null };
}

/**
 * Wait for the next screen of a two-step sign-in to show a field for one of
 * `rest` — on the card's origin only (a redirect elsewhere is never filled).
 */
async function waitForNextStep(
  page: Page,
  origin: string,
  rest: SecureValues,
  digits: number,
  waitMs: number,
): Promise<{ fields: LocatedFields; loaderId: string } | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, NEXT_STEP_POLL_MS));
    if (page.isClosed()) return null;
    const facts = await mainFrameFacts(page.context(), page).catch(() => null);
    // Mid-navigation, or passing through another site: keep waiting, never fill there.
    if (facts?.origin !== origin) continue;
    const fields = await locateFields(page, [origin], wantedFields(rest), digits);
    if (fields.password || fields.otp?.length) return { fields, loaderId: facts.loaderId };
  }
  return null;
}

/** What the page asks a person for once the sign-in was submitted (best effort). */
async function sniffAfterSubmit(page: Page): Promise<NeedsHumanKind | null> {
  await page.waitForLoadState('load', { timeout: 2_000 }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return page.isClosed() ? null : sniffNeedsHuman(page);
}
