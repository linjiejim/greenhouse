/**
 * The Bot's browser — every `browser` tool action, end to end.
 *
 * One call = make sure the member's computer is up → check nobody took it
 * over → find (or open) this turn's tab lease → act → observe → check again
 * that nobody took over meanwhile → return `{url, title, snapshot}`. The
 * observation is made safe here (snapshot.ts) — nothing about a page reaches
 * the model any other way.
 *
 * Rules enforced here rather than in prompts:
 * - Take-over: while the member holds the computer the Bot may not act or
 *   observe. The lease is checked when the call arrives AND again at the real
 *   start of the action (after the start / queue wait), every action is
 *   registered so a take-over in this process aborts it before its next
 *   mutating step, and an observation taken across a lease change (epoch
 *   bump) is dropped, never returned. A foreground Bot that meets the member
 *   at the computer (interrupted, or arriving while they hold it) leaves an
 *   implicit take-over card (`memberInControl`), so their hand-back wakes it
 *   — which is what the Bot is told.
 * - Only http(s) is browsable — `file://` would expose the browser profile
 *   (cookies, local storage) and `chrome://` its settings; greenhouse's own
 *   origin is refused so a Bot can never drive the member's greenhouse.
 * - The Bot never types into password or card fields: credentials go through
 *   the vault (server-side fill) or the secure sign-in card.
 * - Every observation marks the turn tainted (web content is untrusted) and
 *   records the page's origin, so the vault can tell a turn that only read
 *   the entry's own site from one another site could have steered.
 * - Screenshots of the member's signed-in pages are chat files of the
 *   conversation (owner-authenticated download), never public uploads.
 * - Human checks go to the member at the first block: a CAPTCHA, a "checking
 *   your browser" page that does not clear within seconds, or a Cloudflare
 *   challenge response raises a verification card (`ComputerTurn.humanCheck`)
 *   and ends the turn; the site cannot be opened again in that turn. Nothing
 *   here solves, retries or routes around a check.
 *
 * Test seam: everything that touches the computer goes through
 * `ComputerDeps`; tests inject a locally launched Chromium.
 */

import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Browser, Page, Response } from 'playwright-core';
import type { DatabaseProvider } from '@greenhouse/db';
import type { ComputerProcessLog, ComputerProcessView } from '@greenhouse/types/bots';
import { nowIso } from '@greenhouse/utils/date';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { sanitizeUploadName } from '../../storage/filename.js';
import { deleteObjectAtKey, putObjectAtKey } from '../../storage/uploads.js';
import { contentTypeFor, isUnderAgentHome, resolveAgentPath } from '../tools/agent-paths.js';
import { hostOfOrigin, isGreenhouseOrigin, originOfUrl } from '../vault/origin.js';
import * as access from './access.js';
import {
  ComputerActionsAbortedError,
  ComputerUnavailableError,
  type ComputerLease,
  type EnsureOptions,
  type ExecOptions,
  type TrackedComputerAction,
} from './access.js';
import { ComputerDockerError } from './docker.js';
import * as jobs from './jobs.js';
import { computerStatusFor } from './runtime.js';
import {
  humanCheckHint,
  humanCheckRefusal,
  isCloudflareBlock,
  needsHumanHint,
  sniffNeedsHuman,
  type NavigationResponse,
  type NeedsHumanKind,
  type VaultMatch,
} from './needs-human.js';
import { takeSnapshot } from './snapshot.js';
import { leaseRegistryFor, withTimeout, type LeaseRegistry, type LeaseSpec, type TabLease } from './tab-leases.js';

// ─── Dependencies (test seam) ─────────────────────────────

/** Where a screenshot is stored: a chat file of this conversation, owned by the member. */
export interface ScreenshotOwner {
  db: DatabaseProvider;
  userId: string;
  sessionId: string;
}

/** A stored screenshot — the same shape as a `share_file` attachment, so the UI shows it as a file card. */
export interface StoredScreenshot {
  file_id: string;
  name: string;
  size: number;
  /** Authenticated (`GET /api/chat-files/:id/content`): only people who can read the conversation. */
  download_url: string;
}

/** A registered in-flight action: `signal` aborts with the turn and on a take-over / purge in this process. */
export type TrackedAction = TrackedComputerAction;

/** A long job `run_background` started (jobs.ts `startJob`). */
export type StartedJob = Awaited<ReturnType<typeof jobs.startJob>>;

export interface ComputerDeps {
  getBrowser(userId: string, opts?: EnsureOptions): Promise<Browser>;
  /** Make sure the computer is running (start / capacity queue) without doing anything on it. */
  ensureReady(userId: string, opts?: EnsureOptions): Promise<void>;
  /**
   * Register an action on the member's computer so a take-over in this
   * process (access.abortComputerActions) stops it. Playwright calls take no
   * AbortSignal, so the action checks the signal before every step that
   * changes the page; its waits give up at once. Take-overs made on another
   * API slot are caught by the DB lease re-checks.
   */
  trackAction(userId: string, signal: AbortSignal): TrackedAction;
  currentLease(userId: string): Promise<ComputerLease>;
  touch(userId: string): Promise<void>;
  remember(userId: string, value: string): void;
  redact(userId: string, text: string): string;
  /** Whether the computer is running right now — without starting it. */
  isRunning(userId: string): Promise<boolean>;
  exec: typeof access.execInComputer;
  readFile: typeof access.readComputerFile;
  writeFile: typeof access.writeComputerFile;
  /** Persist a PNG for the member to see, as a chat file of the conversation. */
  storeScreenshot(png: Buffer, owner: ScreenshotOwner): Promise<StoredScreenshot>;
  /**
   * Long jobs (`gh-jobs`, jobs.ts). Acting on a job needs the computer
   * running (it does not start it); listing never starts it — [] when stopped.
   */
  startJob(
    userId: string,
    input: { command: string; name?: string },
    opts?: { signal?: AbortSignal },
  ): Promise<StartedJob>;
  listJobs(userId: string): Promise<ComputerProcessView[]>;
  jobLog(userId: string, id: string, opts?: { lines?: number; signal?: AbortSignal }): Promise<ComputerProcessLog>;
  stopJob(userId: string, id: string): Promise<{ id: string; stopped: boolean }>;
}

export const defaultComputerDeps: ComputerDeps = {
  getBrowser: (userId, opts) => access.getBrowser(userId, opts),
  ensureReady: (userId, opts) => access.ensureComputerReady(userId, opts),
  trackAction: (userId, signal) => access.trackComputerAction(userId, signal),
  currentLease: (userId) => access.currentLease(userId),
  touch: (userId) => access.touchComputer(userId),
  remember: (userId, value) => access.rememberFilledSecret(userId, value),
  redact: (userId, text) => access.redactFilledSecrets(userId, text),
  isRunning: async (userId) => (await computerStatusFor(userId)).state === 'running',
  exec: (userId: string, command: string, opts: ExecOptions) => access.execInComputer(userId, command, opts),
  readFile: (userId, path, opts) => access.readComputerFile(userId, path, opts),
  writeFile: (userId, path, content, opts) => access.writeComputerFile(userId, path, content, opts),
  storeScreenshot: (png, owner) => storeScreenshotAsChatFile(png, owner),
  startJob: (userId, input, opts) => jobs.startJob(userId, input, opts),
  listJobs: (userId) => jobs.listJobs(userId),
  jobLog: (userId, id, opts) => jobs.jobLog(userId, id, opts),
  stopJob: (userId, id) => jobs.stopJob(userId, id),
};

/**
 * A screenshot shows the member's signed-in pages (mail, banking, HR), so it
 * is stored like `share_file` output — a `chat_files` row of the
 * conversation behind the authenticated download route — and NOT in the flat
 * public upload store, whose URLs work for anyone who ever sees one (provider
 * logs, a pasted transcript, a proxy cache) and are never deleted. Deleting
 * the conversation deletes the object.
 */
export async function storeScreenshotAsChatFile(png: Buffer, owner: ScreenshotOwner): Promise<StoredScreenshot> {
  // screenshot-20261005-061502.png (UTC)
  const name = `screenshot-${nowIso().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}.png`;
  // Same key layout as share_file and member uploads (routes/chat-files.ts).
  const storageKey = `chat-files/${owner.userId}/${randomUUID()}/${name}`;
  await putObjectAtKey(storageKey, png, 'image/png');
  try {
    const file = await owner.db.chatFiles.create({
      session_id: owner.sessionId,
      name,
      content_type: 'image/png',
      size: png.length,
      storage_key: storageKey,
      source: 'agent',
      created_by: owner.userId,
    });
    return { file_id: file.id, name: file.name, size: file.size, download_url: `/api/chat-files/${file.id}/content` };
  } catch (err) {
    await deleteObjectAtKey(storageKey).catch(() => undefined);
    throw err;
  }
}

// ─── Connections this process holds ───────────────────────

/**
 * The last browser connection handed out per member. Lets clean-up paths
 * (releaseTurnLeases) act only on a connection this process already holds:
 * opening one just to close a background context would kick another API
 * slot off the single-client DevTools relay.
 */
const connections = new Map<string, Browser>();

function rememberConnection(userId: string, browser: Browser): Browser {
  connections.set(userId, browser);
  return browser;
}

function heldConnection(userId: string): Browser | null {
  const browser = connections.get(userId);
  if (browser?.isConnected()) return browser;
  connections.delete(userId);
  return null;
}

// ─── Turn view ────────────────────────────────────────────

/** The slice of a Bot turn the computer tools need (built from BotTurnContext). */
export interface ComputerTurn {
  db: DatabaseProvider;
  userId: string;
  botId: string;
  sessionId: string;
  turnId: string;
  background: boolean;
  signal: AbortSignal;
  markTainted(): void;
  /**
   * Record what the turn just read: a page origin, or `null` for outside
   * content that has no origin (shell output, a file). Feeds the vault's
   * "steered by another site" rule (vault/turn-observations.ts).
   */
  noteObservation(origin: string | null): void;
  /** Vault entries for an origin, or null when this turn has no vault tool. */
  vaultMatches: ((origin: string) => Promise<VaultMatch[]>) | null;
  /**
   * The member holds the computer while this Bot wanted it: make sure a
   * take-over card waits for their hand-back (implicit; one per conversation
   * and Bot), so the hand-back wakes this Bot. Absent for background turns —
   * a hand-back could not wake them.
   */
  implicitTakeover?(info: ImplicitTakeover): Promise<ImplicitTakeoverOutcome>;
  /**
   * The Bot's page asks for human verification: raise the verification card
   * (a `captcha` take-over card; one per conversation and Bot) and end the
   * turn after this step. Absent for background turns — nobody would answer.
   */
  humanCheck?(info: HumanCheck): Promise<HumanCheckOutcome>;
}

/** A page that asks for human verification, as the browser saw it (all server-derived). */
export interface HumanCheck {
  origin: string | null;
  /** The page's URL (redacted); the card shows origin + path only. */
  url: string;
  /** The page's title — page content, never written into a transcript line. */
  title: string;
  /** captcha = a visible widget; challenge = an interstitial that did not clear, or a Cloudflare challenge response. */
  kind: 'captcha' | 'challenge';
}

/** card = a verification card now waits for the member; already_pending = this Bot's earlier card still does. */
export type HumanCheckOutcome = 'card' | 'already_pending';

/** Why a Bot met the member at the computer — the implicit take-over card's payload. */
export interface ImplicitTakeover {
  /** interrupted = taken over mid-action; waiting = the member already held it when the Bot came. */
  reason: 'interrupted' | 'waiting';
  /** Host of the Bot's page (server-derived). */
  host?: string;
  /** Title of the Bot's page — page content, for the member's card only. */
  title?: string;
}

/** card = a card waits for the hand-back (which wakes the Bot); handed_back = the member already gave it back. */
export type ImplicitTakeoverOutcome = 'card' | 'handed_back';

export function leaseSpecFor(turn: Pick<ComputerTurn, 'background' | 'botId' | 'sessionId' | 'turnId'>): LeaseSpec {
  return turn.background
    ? { kind: 'background', turnId: turn.turnId }
    : { kind: 'foreground', botId: turn.botId, sessionId: turn.sessionId };
}

// ─── Results ──────────────────────────────────────────────

export interface ToolFailure {
  error: string;
  code: string;
}

export function failure(code: string, error: string): ToolFailure {
  return { code, error };
}

/**
 * What a Bot is told when the member holds the computer. "You will be woken"
 * only where it is true: a take-over card waits for the hand-back, and the
 * hand-back wakes the Bot that asked (lease.ts).
 */
const MEMBER_IN_CONTROL = {
  waiting:
    'The member is using the computer right now, so you cannot use the browser, the shell or the vault. A card asks them to hand it back, and you will be woken automatically when they do. End your turn now with one short line saying what you were about to do.',
  interrupted:
    'The member took over the computer while you were working, so this action was stopped and nothing from it was kept. A card asks them to hand it back, and you will be woken automatically when they do. End your turn now with one short line saying where you were.',
  background:
    'The member is using the computer right now, so this background task cannot use it. Finish with what you have and say in the report what is left to do.',
  noCard:
    'The member is using the computer right now. Do not use the browser, the shell or the vault until they hand it back: end your turn with one short line saying what you were about to do, and continue when they ask.',
} as const;
const HANDED_BACK =
  'The member used the computer while you were working and has already handed it back, so nothing from this action was kept. Look again before you continue (a fresh snapshot, or re-check the files).';

/**
 * The member holds the computer: for a foreground Bot make sure a take-over
 * card waits for their hand-back, then say what is true — it will be woken
 * when they hand back, they already did, or (background, no card) it will not
 * be woken.
 */
export async function memberInControl(
  turn: Pick<ComputerTurn, 'userId' | 'background' | 'implicitTakeover'>,
  info: ImplicitTakeover,
  code: 'user_in_control' | 'observation_dropped' = 'user_in_control',
): Promise<ToolFailure> {
  if (turn.background) return failure(code, MEMBER_IN_CONTROL.background);
  if (!turn.implicitTakeover) return failure(code, MEMBER_IN_CONTROL.noCard);
  try {
    const outcome = await turn.implicitTakeover(info);
    if (outcome === 'handed_back') return failure('observation_dropped', HANDED_BACK);
    return failure(code, MEMBER_IN_CONTROL[info.reason]);
  } catch (err) {
    logger.warn('[bots/computer] could not raise the take-over card', {
      userId: turn.userId,
      error: toErrorMessage(err),
    });
    return failure(code, MEMBER_IN_CONTROL.noCard);
  }
}

/**
 * An action stopped because the lease moved under it (a take-over in this
 * process aborts it; one on another slot shows in the DB lease): the member
 * still holds the computer (→ memberInControl), or already handed it back.
 */
export async function afterLeaseChange(
  turn: Pick<ComputerTurn, 'userId' | 'background' | 'implicitTakeover'>,
  deps: Pick<ComputerDeps, 'currentLease'>,
  info: () => Promise<ImplicitTakeover> | ImplicitTakeover,
  code: 'user_in_control' | 'observation_dropped' = 'user_in_control',
): Promise<ToolFailure> {
  // An unreadable lease counts as the member's: never act on a guess.
  const now = await deps.currentLease(turn.userId).catch(() => null);
  if (now && now.controller !== 'user') return failure('observation_dropped', HANDED_BACK);
  return await memberInControl(turn, await info(), code);
}

/** A user-facing message for a computer that could not be reached. */
export function unavailableFailure(err: ComputerUnavailableError): ToolFailure {
  const messages: Record<ComputerUnavailableError['code'], string> = {
    disabled: 'The computer is not enabled on this deployment, so browsing and shell commands are not possible.',
    unavailable:
      "The computer host is not ready right now. Tell the member; an administrator can check 'Bot computers'.",
    busy: "All of the organisation's computers are in use. Try again in a minute, or do what you can without the computer.",
    start_failed: 'The computer failed to start. Tell the member; trying again later may work.',
    user_in_control: MEMBER_IN_CONTROL.noCard,
    stopped: 'The computer was stopped. Tell the member if you still need it.',
    over_quota: "The computer's disk is over its limit. Ask the member to delete files on it before continuing.",
  };
  if (err.reason === 'host_disk') {
    return failure(
      err.code,
      'The server that runs the computers is almost out of disk space, so the computer cannot start. Tell the member an administrator needs to free space; do what you can without the computer.',
    );
  }
  return failure(err.code, messages[err.code]);
}

/** Map any error to a tool failure; Playwright call logs are trimmed to their first line. */
export function toFailure(err: unknown, redact: (text: string) => string, fallbackCode = 'failed'): ToolFailure {
  if (err instanceof ComputerUnavailableError) return unavailableFailure(err);
  if (err instanceof AbortedError) return failure('aborted', 'Stopped.');
  const first = toErrorMessage(err).split('\n')[0] ?? '';
  const message = first.replace(/^[a-zA-Z]+\.[a-zA-Z]+: /, '').slice(0, 300);
  return failure(fallbackCode, redact(message) || 'The action failed');
}

class AbortedError extends Error {}

/** True for the error `throwIfAborted` / `abortable` raise when the turn was stopped. */
export function isAbortedError(err: unknown): boolean {
  return err instanceof AbortedError;
}

/**
 * The error for an aborted signal: a take-over or a stopped computer keeps its
 * own reason (so the Bot is told the member took over, not "Stopped"); a user
 * Stop is a plain abort.
 */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof ComputerUnavailableError) return reason;
  if (reason instanceof ComputerActionsAbortedError) {
    return reason.reason === 'takeover'
      ? new ComputerUnavailableError('user_in_control', reason.message)
      : new ComputerUnavailableError('stopped', reason.message);
  }
  return new AbortedError('aborted');
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/** Race a promise against the turn's abort signal. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Inputs ───────────────────────────────────────────────

export const BROWSER_ACTIONS = [
  'open',
  'snapshot',
  'click',
  'type',
  'select',
  'hover',
  'drag',
  'upload',
  'press',
  'scroll',
  'wait',
  'back',
  'tabs',
  'close',
  'screenshot',
] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

/** Background tasks are read-only: they can look (and wait for a page), never act. */
export const BACKGROUND_BROWSER_ACTIONS = ['open', 'snapshot', 'scroll', 'wait', 'back', 'tabs', 'screenshot'] as const;

export interface BrowserInput {
  action: BrowserAction;
  url?: string;
  ref?: string;
  /** drag: the element to drop onto. */
  to_ref?: string;
  text?: string;
  submit?: boolean;
  value?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  tab?: number;
  /** upload: a file on the computer (agent home). */
  path?: string;
  /** wait: seconds, at most WAIT_MAX_S. */
  timeout_s?: number;
}

/** A file `upload` may put into a page — the same cap as share_file / import_attachment. */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const WAIT_MAX_S = 30;
const WAIT_DEFAULT_TEXT_S = 10;
const WAIT_DEFAULT_PLAIN_S = 3;

/**
 * How long a "checking your browser" interstitial gets to clear by itself
 * before it counts as a human check (most do within a few seconds). Mutable
 * for tests only.
 */
export const CHALLENGE_TIMING = { settleMs: 6_000, recheckMs: 1_500 };

const REF = /^(?:f\d+)?e\d+$/;
const KEY =
  /^(?:[A-Za-z0-9]|F\d{1,2}|Enter|Tab|Escape|Backspace|Delete|Space|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|(?:Control|Shift|Alt|Meta)\+.{1,12})$/;
const BLOCKED_SCHEMES =
  /^(?:file|chrome|chrome-extension|chrome-untrusted|devtools|view-source|javascript|data|blob|filesystem):/i;

/** Resolve what the model typed into a browsable URL, or explain why not. */
export function normalizeBrowseUrl(raw: string): { url: string } | ToolFailure {
  const value = raw.trim();
  if (!value) return failure('url_invalid', 'Give a URL to open.');
  if (value === 'about:blank') return { url: value };
  if (BLOCKED_SCHEMES.test(value)) {
    return failure('url_forbidden', 'Only http and https pages can be opened.');
  }
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return failure('url_invalid', `"${value.slice(0, 200)}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return failure('url_forbidden', 'Only http and https pages can be opened.');
  }
  if (isGreenhouseOrigin(parsed.origin)) {
    return failure('url_forbidden', 'greenhouse itself cannot be opened in the computer browser.');
  }
  return { url: parsed.href };
}

// ─── Observation ──────────────────────────────────────────

export interface Observation {
  url: string;
  title: string;
  snapshot: string;
  truncated?: boolean;
  hint?: string;
  /** The page asks for human verification: handed to the member (foreground) — the hint says what to do. */
  blocked?: 'human_check';
  tabs?: TabView[];
  /** screenshot: the picture as a chat-file attachment (same shape as share_file). */
  type?: 'file';
  file_id?: string;
  name?: string;
  content_type?: string;
  size?: number;
  download_url?: string;
  note?: string;
  error?: string;
  code?: string;
}

/**
 * The origins an observation was read from (null = not a web page). Kept
 * beside the result rather than in it: run() feeds them to the turn's
 * observation ledger once the result is known to be returned.
 */
const observedOrigins = new WeakMap<object, Array<string | null>>();

/**
 * Sites that asked for human verification in a turn (keyed by the turn's
 * ComputerTurn, which every browser call of the turn shares): another `open`
 * of them is refused — the URL-hopping a model tries after a block, which a
 * site's bot defences only read as more evidence.
 */
const humanCheckOrigins = new WeakMap<ComputerTurn, Set<string>>();

function blockedOrigins(turn: ComputerTurn): Set<string> {
  let origins = humanCheckOrigins.get(turn);
  if (!origins) humanCheckOrigins.set(turn, (origins = new Set()));
  return origins;
}

/**
 * The last main-frame navigation response of a page while an action runs:
 * a challenge page's status and headers say "Cloudflare" even when its DOM
 * does not. Redirects come first, so the last one is where the page landed.
 */
function watchNavigations(page: Page): { last(): NavigationResponse | null; stop(): void } {
  let last: NavigationResponse | null = null;
  const onResponse = (response: Response) => {
    try {
      if (response.frame() !== page.mainFrame() || !response.request().isNavigationRequest()) return;
      last = { status: response.status(), headers: response.headers() };
    } catch {
      // A service-worker response has no frame.
    }
  };
  page.on('response', onResponse);
  return { last: () => last, stop: () => page.off('response', onResponse) };
}

export interface TabView {
  tab: number;
  url: string;
  title: string;
  current: boolean;
}

async function tabViews(lease: TabLease, redact: (t: string) => string): Promise<TabView[]> {
  return Promise.all(
    lease.tabs.map(async (entry, i) => ({
      tab: i + 1,
      url: redact(entry.page.url()),
      title: redact(await withTimeout(entry.page.title(), 2_000).catch(() => '')),
      current: entry.page === lease.current,
    })),
  );
}

/** Wait briefly for whatever an action set off (navigation, SPA render). */
async function settle(page: Page): Promise<void> {
  await sleep(200);
  await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => undefined);
  await page.waitForLoadState('load', { timeout: 2_000 }).catch(() => undefined);
}

/**
 * If a page ended up somewhere a Bot must not look (a `file://` link, a
 * greenhouse URL after a redirect), take it back to a blank page before
 * anything is read from it.
 */
async function guardLocation(page: Page): Promise<ToolFailure | null> {
  const url = page.url();
  if (url === 'about:blank' || url === '') return null;
  const blocked = BLOCKED_SCHEMES.test(url) && !url.startsWith('data:') ? true : isGreenhouseOrigin(originOfUrl(url));
  if (!blocked) return null;
  await page.goto('about:blank').catch(() => undefined);
  return failure(
    'url_forbidden',
    'That page cannot be viewed by Bots (only http and https sites, and not greenhouse itself).',
  );
}

// ─── The session ──────────────────────────────────────────

/**
 * Executes browser actions for one turn. Construct per tool call or per turn;
 * it holds no page state of its own (that lives in the lease registry).
 */
export class BrowserSession {
  constructor(
    readonly turn: ComputerTurn,
    readonly deps: ComputerDeps = defaultComputerDeps,
  ) {}

  private redact = (text: string) => this.deps.redact(this.turn.userId, text);

  /** The browser + this turn's lease (opening a window when `create`). */
  async lease(
    create: boolean,
    signal: AbortSignal = this.turn.signal,
  ): Promise<{ registry: LeaseRegistry; lease: TabLease | null }> {
    const browser = rememberConnection(this.turn.userId, await this.deps.getBrowser(this.turn.userId, { signal }));
    const registry = leaseRegistryFor(browser);
    const lease = await registry.acquire(leaseSpecFor(this.turn), { create });
    return { registry, lease };
  }

  async run(input: BrowserInput): Promise<Observation | ToolFailure> {
    const { turn, deps } = this;
    if (turn.background && !(BACKGROUND_BROWSER_ACTIONS as readonly string[]).includes(input.action)) {
      return failure('not_allowed', `"${input.action}" is not available in a background task (read-only).`);
    }
    // Refuse a bad address before a window is opened for it.
    const target = input.action === 'open' ? normalizeBrowseUrl(input.url ?? '') : null;
    if (target && 'code' in target) return target;
    const targetOrigin = target ? originOfUrl(target.url) : null;
    if (targetOrigin && humanCheckOrigins.get(turn)?.has(targetOrigin)) {
      return failure('human_check', humanCheckRefusal(targetOrigin, turn.background));
    }
    // Aborts with the turn, and when the member takes over in this process.
    const action = deps.trackAction(turn.userId, turn.signal);
    const signal = action.signal;
    let held: TabLease | null = null;
    try {
      throwIfAborted(signal);
      // Fast path: do not even start the computer for a Bot that may not act.
      const before = await deps.currentLease(turn.userId);
      if (before.controller === 'user') return await memberInControl(turn, { reason: 'waiting' });
      void deps.touch(turn.userId).catch(() => undefined);

      const { registry, lease } = await abortable(this.lease(input.action === 'open', signal), signal);
      held = lease;
      if (!lease) {
        if (input.action === 'tabs')
          return { url: '', title: '', snapshot: '', tabs: [], note: 'You have no tabs open.' };
        return failure('no_tab', 'You have no tab open yet — use open {url} first.');
      }
      const resolved = target ? { ...input, url: target.url } : input;
      // abortable() wraps the queued run, not the other way round: a stopped
      // call stops waiting at once, but the lease queue keeps chaining on the
      // real perform() promise, so the next action on this lease never drives
      // the page while an orphaned one still does.
      const result = await abortable(
        lease.run(async () => {
          // Starting the computer or waiting in the queue / behind another
          // action can take a minute: check again at the real start.
          throwIfAborted(signal);
          const now = await deps.currentLease(turn.userId);
          // Taken over while this call waited: handled with every other take-over below.
          if (now.controller === 'user') throw new ComputerUnavailableError('user_in_control', 'Taken over');
          if (now.epoch !== before.epoch) return failure('observation_dropped', HANDED_BACK);
          // A call queued behind the one that met the human check (parallel tool calls).
          if (targetOrigin && humanCheckOrigins.get(turn)?.has(targetOrigin)) {
            return failure('human_check', humanCheckRefusal(targetOrigin, turn.background));
          }
          return this.perform(resolved, registry, lease, before.epoch, signal);
        }),
        signal,
      );
      if ('code' in result && result.code && !('url' in result)) return result;

      // Observations made across a take-over are dropped, never returned.
      const after = await deps.currentLease(turn.userId);
      if (after.controller === 'user') {
        return await memberInControl(turn, await this.where(lease, 'interrupted'), 'observation_dropped');
      }
      if (after.epoch !== before.epoch) return failure('observation_dropped', HANDED_BACK);
      // Record what was read before marking the turn tainted: the ledger
      // notices when something else tainted the turn first.
      for (const origin of observedOrigins.get(result) ?? []) if (origin) turn.noteObservation(origin);
      turn.markTainted();
      void deps.touch(turn.userId).catch(() => undefined);
      return result;
    } catch (err) {
      const fail = toFailure(err, this.redact);
      // Taken over mid-action (aborted in this process, or caught by a lease
      // re-check for another slot's take-over).
      if (fail.code === 'user_in_control') {
        return await afterLeaseChange(turn, deps, () => this.where(held, 'interrupted'));
      }
      // Aborted while the turn itself goes on: a take-over (or a stop) made
      // through a path that aborts without a reason. Say what happened.
      if (fail.code === 'aborted' && !turn.signal.aborted) {
        const now = await deps.currentLease(turn.userId).catch(() => null);
        return now?.controller === 'user'
          ? await memberInControl(turn, await this.where(held, 'interrupted'))
          : unavailableFailure(new ComputerUnavailableError('stopped', 'The computer was stopped'));
      }
      if (fail.code === 'failed') {
        logger.warn('[bots/browser] action failed', { action: input.action, userId: turn.userId, error: fail.error });
      }
      return fail;
    } finally {
      action.done();
    }
  }

  /**
   * Where the Bot was, for the take-over card: its page's host and title
   * (redacted, short). Background turns get no card, so nothing is read.
   */
  private async where(lease: TabLease | null, reason: ImplicitTakeover['reason']): Promise<ImplicitTakeover> {
    const page = this.turn.background ? null : lease?.currentPage();
    if (!page) return { reason };
    const origin = originOfUrl(page.url());
    const title = this.redact(
      (await withTimeout(page.title(), 1_500).catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 120),
    );
    return { reason, ...(origin ? { host: hostOfOrigin(origin) } : {}), ...(title ? { title } : {}) };
  }

  private async perform(
    input: BrowserInput,
    registry: LeaseRegistry,
    lease: TabLease,
    epoch: number,
    signal: AbortSignal,
  ): Promise<Observation | ToolFailure> {
    let page = lease.currentPage();
    if (!page) return failure('no_tab', 'You have no tab open yet — use open {url} first.');
    lease.touch(page);
    let sniff = false;
    let actionError: ToolFailure | null = null;
    const actionPage = page;
    // Resolve a ref from the latest snapshot; a ref that no longer resolves
    // fails at once instead of waiting out the action timeout.
    const locate = async (ref: string | undefined) => {
      if (!ref || !REF.test(ref)) throw new RefError(ref);
      const locator = actionPage.locator(`aria-ref=${ref}`);
      if ((await locator.count().catch(() => 0)) === 0) throw new StaleRefError(ref);
      return locator;
    };
    // Called right before every step that changes the page or the screen: a
    // take-over in this process (or a Stop) ends the action here instead of
    // letting a queued click or Enter land on the member's screen.
    const step = () => throwIfAborted(signal);
    // Before the Enter that follows a fill (which can take seconds): a
    // take-over on another API slot shows only in the DB lease.
    const stillOurs = async () => {
      step();
      const now = await this.deps.currentLease(this.turn.userId);
      if (now.controller === 'user' || now.epoch !== epoch) {
        throw new ComputerUnavailableError('user_in_control', 'The member took over the computer');
      }
    };
    // Raise the Bot's window so a member watching the screen sees what it is
    // doing. Background tasks never raise theirs over the member's view.
    const front = async () => {
      step();
      if (!this.turn.background) await actionPage.bringToFront().catch(() => undefined);
    };
    // Where the action's navigations landed, until the observation is made:
    // a challenge that clears reloads the page while observe() waits for it.
    const navigations = watchNavigations(actionPage);
    try {
      try {
        switch (input.action) {
          case 'open': {
            await front();
            try {
              await page.goto(input.url ?? 'about:blank', { waitUntil: 'domcontentloaded', timeout: 30_000 });
            } catch (err) {
              // A failed navigation still leaves a page (Chromium's error page);
              // report the reason next to whatever is showing.
              actionError = toFailure(err, this.redact, 'navigation_failed');
            }
            await page.waitForLoadState('load', { timeout: 3_000 }).catch(() => undefined);
            sniff = true;
            break;
          }
          case 'snapshot':
            break;
          case 'click': {
            const locator = await locate(input.ref);
            await front();
            step();
            await locator.click({ timeout: 10_000 });
            await settle(page);
            // A target=_blank link moved the lease to the new tab (registry popup handler).
            const next = lease.currentPage() ?? page;
            if (next !== page) {
              page = next;
              await settle(page);
            }
            sniff = true;
            break;
          }
          case 'type': {
            const locator = await locate(input.ref);
            const kind = await locator
              .evaluate((el) => {
                const input = el as HTMLInputElement;
                const type = (input.getAttribute?.('type') ?? '').toLowerCase();
                const auto = (input.getAttribute?.('autocomplete') ?? '').toLowerCase();
                if (type === 'password' || /current-password|new-password/.test(auto)) return 'password';
                if (/cc-number|cc-csc|cc-exp/.test(auto)) return 'card';
                return 'text';
              })
              .catch(() => 'text');
            if (kind === 'password') {
              return failure(
                'secret_field',
                'That is a password field. Never type passwords yourself: use vault fill_login, or request_takeover with kind "login".',
              );
            }
            if (kind === 'card') {
              return failure('secret_field', 'That is a payment card field. Ask the member to take over for payments.');
            }
            await front();
            step();
            await locator.fill(input.text ?? '', { timeout: 10_000 });
            if (input.submit) {
              await stillOurs();
              await locator.press('Enter', { timeout: 5_000 });
              await settle(page);
              page = lease.currentPage() ?? page;
              sniff = true;
            }
            break;
          }
          case 'select': {
            if (!input.value) return failure('invalid', 'select needs a value (the option text or value).');
            const locator = await locate(input.ref);
            step();
            await locator.selectOption(input.value, { timeout: 10_000 });
            await settle(page);
            break;
          }
          case 'hover': {
            const locator = await locate(input.ref);
            await front();
            step();
            await locator.hover({ timeout: 10_000 });
            await sleep(300); // menus and tooltips open on a delay
            break;
          }
          case 'drag': {
            if (!input.to_ref) return failure('invalid', 'drag needs to_ref: the ref of the element to drop onto.');
            const source = await locate(input.ref);
            const target = await locate(input.to_ref);
            await front();
            step();
            await source.dragTo(target, { timeout: 10_000 });
            await settle(page);
            break;
          }
          case 'upload': {
            // The ref first: a stale one should not cost reading a 20 MB file.
            const locator = await locate(input.ref);
            const file = await this.uploadFile(input.path, signal);
            if ('code' in file) return file;
            const fileInput = await locator
              .evaluate((el) => el instanceof HTMLInputElement && el.type === 'file')
              .catch(() => false);
            await front();
            step();
            if (fileInput) {
              await locator.setInputFiles(file, { timeout: 10_000 });
            } else {
              // A styled "Upload" button in front of a hidden input: press it
              // and answer the file picker it opens (never shown on screen).
              // Caught at once: a click that throws leaves nobody to await it.
              const chooser = actionPage.waitForEvent('filechooser', { timeout: 5_000 }).catch(() => null);
              await locator.click({ timeout: 10_000 });
              const picker = await chooser;
              if (!picker) {
                actionError = failure(
                  'not_a_file_input',
                  `${input.ref} did not open a file picker. Give the ref of the file input, or of the button that opens the picker.`,
                );
                break;
              }
              await stillOurs();
              await picker.setFiles(file, { timeout: 10_000 });
            }
            await settle(page);
            break;
          }
          case 'press': {
            const key = (input.key ?? '').trim();
            if (!KEY.test(key))
              return failure('invalid', 'press needs a key such as Enter, Tab, Escape, ArrowDown or Control+A.');
            step();
            await page.keyboard.press(key === 'Space' ? ' ' : key);
            await settle(page);
            page = lease.currentPage() ?? page;
            sniff = key === 'Enter';
            break;
          }
          case 'scroll': {
            if (input.ref) {
              const locator = await locate(input.ref);
              step();
              await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
            } else {
              const { w, h } = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
              const distance = Math.round(h * 0.8);
              const dir = input.direction ?? 'down';
              step();
              await page.mouse.move(Math.round(w / 2), Math.round(h / 2));
              await page.mouse.wheel(
                dir === 'left' ? -distance : dir === 'right' ? distance : 0,
                dir === 'up' ? -distance : dir === 'down' ? distance : 0,
              );
            }
            await sleep(350);
            break;
          }
          case 'wait': {
            const text = input.text?.trim();
            const seconds = Math.min(
              Math.max(Math.round(input.timeout_s ?? (text ? WAIT_DEFAULT_TEXT_S : WAIT_DEFAULT_PLAIN_S)), 1),
              WAIT_MAX_S,
            );
            if (text) {
              try {
                // abortable(): a take-over or Stop ends the wait at once.
                await abortable(
                  page
                    .getByText(text)
                    .first()
                    .waitFor({ state: 'visible', timeout: seconds * 1000 }),
                  signal,
                );
              } catch (err) {
                if (err instanceof AbortedError || err instanceof ComputerUnavailableError) throw err;
                actionError = failure(
                  'wait_timeout',
                  `"${text.slice(0, 80)}" did not appear within ${seconds} s. The page as it is now is below.`,
                );
              }
            } else {
              await abortable(sleep(seconds * 1000), signal);
            }
            page = lease.currentPage() ?? page;
            sniff = true;
            break;
          }
          case 'back': {
            const before = page.url();
            step();
            const response = await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 });
            if (!response && page.url() === before) {
              actionError = failure('no_history', 'There is no earlier page in this tab.');
            }
            sniff = true;
            break;
          }
          case 'tabs': {
            if (input.tab !== undefined) {
              const entry = lease.tabs[input.tab - 1];
              if (!entry) return failure('invalid', `There is no tab ${input.tab}.`);
              step();
              lease.select(entry.page);
              page = entry.page;
              if (!this.turn.background) await page.bringToFront().catch(() => undefined);
            }
            break;
          }
          case 'close': {
            step();
            await page.close();
            const next = lease.currentPage();
            if (!next) {
              return {
                url: '',
                title: '',
                snapshot: '',
                tabs: [],
                note: 'Your tab is closed. open {url} starts a new one.',
              };
            }
            page = next;
            break;
          }
          case 'screenshot': {
            const blocked = await guardLocation(page);
            if (blocked) return blocked;
            const png = await page.screenshot({ type: 'png', timeout: 15_000 });
            // Store the image only once it is known to be taken under the
            // Bot's lease — a picture of the member's take-over must not exist.
            const now = await this.deps.currentLease(this.turn.userId);
            if (now.controller === 'user') throw new ComputerUnavailableError('user_in_control', 'Taken over');
            if (now.epoch !== epoch) return failure('observation_dropped', HANDED_BACK);
            const file = await this.deps.storeScreenshot(png, {
              db: this.turn.db,
              userId: this.turn.userId,
              sessionId: this.turn.sessionId,
            });
            const shot: Observation = {
              url: this.redact(page.url()),
              title: this.redact(await page.title().catch(() => '')),
              snapshot: '',
              type: 'file',
              ...file,
              content_type: 'image/png',
              note: 'Screenshot saved. The member sees it as an image card in this conversation (only they can open it); do not paste its link. Mention it only if they asked to see the page.',
            };
            observedOrigins.set(shot, [originOfUrl(page.url())]);
            return shot;
          }
        }
      } catch (err) {
        // Stopped (turn Stop, take-over, computer stopped): no observation.
        if (err instanceof AbortedError || err instanceof ComputerUnavailableError) throw err;
        if (err instanceof RefError) {
          return failure('invalid', 'Give the ref of an element from the latest snapshot (like e12).');
        }
        const fail = toFailure(err, this.redact);
        // A stale ref is the common case: tell the model how to recover.
        if (err instanceof StaleRefError || (/aria-ref|not found|Timeout/i.test(toErrorMessage(err)) && input.ref)) {
          const ref = err instanceof StaleRefError ? err.ref : input.ref;
          actionError = failure(
            'stale_ref',
            `Could not ${input.action} ${ref}: it is not on the page any more or is not interactable. Use the fresh snapshot below.`,
          );
        } else {
          actionError = fail;
        }
        page = lease.currentPage() ?? page;
      }

      step(); // stopped meanwhile: nothing to observe
      return await this.observe(registry, lease, page, {
        sniff,
        actionError,
        withTabs: input.action === 'tabs',
        navigation: navigations.last,
        signal,
      });
    } finally {
      navigations.stop();
    }
  }

  /**
   * The file an `upload` puts into the page: read from the agent home (the
   * Bot's own sandbox — the browser profile is not reachable from there),
   * at most UPLOAD_MAX_BYTES.
   */
  private async uploadFile(
    raw: string | undefined,
    signal: AbortSignal,
  ): Promise<{ name: string; mimeType: string; buffer: Buffer } | ToolFailure> {
    if (!raw?.trim()) return failure('invalid', 'upload needs a path: a file on the computer (relative to ~/work).');
    const path = resolveAgentPath(raw);
    if (!isUnderAgentHome(path)) return failure('forbidden_path', 'Only files inside /home/agent can be uploaded.');
    const name = sanitizeUploadName(posix.basename(path));
    if (!name) return failure('invalid', 'That file name cannot be used; rename the file first.');
    const tooLarge = () => failure('too_large', `${name} is larger than 20 MB, so it cannot be uploaded from here.`);
    let buffer: Buffer;
    try {
      buffer = await this.deps.readFile(this.turn.userId, path, { maxBytes: UPLOAD_MAX_BYTES + 1, signal });
    } catch (err) {
      throwIfAborted(signal);
      if (err instanceof ComputerUnavailableError) throw err;
      if (err instanceof ComputerDockerError && err.code === 'too_large') return tooLarge();
      return failure('file_unreadable', `Could not read ${path}: ${toFailure(err, this.redact).error}`);
    }
    if (buffer.length > UPLOAD_MAX_BYTES) return tooLarge();
    return { name, mimeType: contentTypeFor(name), buffer };
  }

  /**
   * A "checking your browser" interstitial usually clears by itself within a
   * few seconds: look again every CHALLENGE_TIMING.recheckMs for up to
   * CHALLENGE_TIMING.settleMs before it counts as a human check. A CAPTCHA
   * counts at once. Never interacts with the page.
   */
  private async settleChallenge(
    lease: TabLease,
    page: Page,
    navigation: () => NavigationResponse | null,
    signal: AbortSignal,
  ): Promise<{ page: Page; needsHuman: NeedsHumanKind | null; cloudflare: boolean }> {
    const read = async (current: Page) => ({
      needsHuman: await sniffNeedsHuman(current),
      cloudflare: isCloudflareBlock(navigation(), await withTimeout(current.title(), 2_000).catch(() => '')),
    });
    const deadline = Date.now() + CHALLENGE_TIMING.settleMs;
    let state = await read(page);
    while ((state.needsHuman === 'challenge' || state.cloudflare) && Date.now() < deadline) {
      await abortable(sleep(CHALLENGE_TIMING.recheckMs), signal);
      page = lease.currentPage() ?? page;
      state = await read(page);
    }
    return { page, ...state };
  }

  /**
   * The page asks for human verification (see the module comment): mark the
   * observation, refuse the site for the rest of the turn, and in the
   * foreground hand it to the member — the verification card, which ends
   * the turn after this step. Background turns cannot raise cards: they note
   * it and move on.
   */
  private async handOverHumanCheck(observation: Observation, check: HumanCheck, signal: AbortSignal): Promise<void> {
    observation.blocked = 'human_check';
    if (check.origin) blockedOrigins(this.turn).add(check.origin);
    if (this.turn.background) {
      observation.hint = needsHumanHint(check.kind, check.origin, null, false);
      return;
    }
    let outcome: HumanCheckOutcome | null = null;
    if (this.turn.humanCheck) {
      throwIfAborted(signal); // stopped meanwhile: no card
      try {
        outcome = await this.turn.humanCheck(check);
      } catch (err) {
        logger.warn('[bots/browser] could not raise the verification card', {
          userId: this.turn.userId,
          error: toErrorMessage(err),
        });
      }
    }
    // Without a card the Bot asks for one itself (request_takeover).
    observation.hint = outcome ? humanCheckHint(check.origin) : needsHumanHint(check.kind, check.origin, null, true);
  }

  private async observe(
    registry: LeaseRegistry,
    lease: TabLease,
    page: Page,
    opts: {
      sniff: boolean;
      actionError: ToolFailure | null;
      withTabs: boolean;
      /** The action's last main-frame navigation response. */
      navigation: () => NavigationResponse | null;
      signal: AbortSignal;
    },
  ): Promise<Observation | ToolFailure> {
    let blocked = await guardLocation(page);
    if (blocked) return blocked;
    let needsHuman: NeedsHumanKind | null = null;
    let cloudflare = false;
    if (opts.sniff) {
      ({ page, needsHuman, cloudflare } = await this.settleChallenge(lease, page, opts.navigation, opts.signal));
      // Wherever the interstitial went meanwhile must be viewable too.
      blocked = await guardLocation(page);
      if (blocked) return blocked;
    }
    await registry.retag(lease, page);
    lease.touch(page);
    const snap = await takeSnapshot(page, this.redact);
    const url = page.url();
    const title = await page.title().catch(() => '');
    const observation: Observation = {
      url: this.redact(url),
      title: this.redact(title),
      snapshot: snap.snapshot,
    };
    if (snap.truncated) observation.truncated = true;
    const origins = [originOfUrl(url)];
    if (opts.withTabs || lease.tabs.length > 1) {
      observation.tabs = await tabViews(lease, this.redact);
      // Other tabs' titles and URLs are page content too.
      origins.push(...lease.tabs.map((entry) => originOfUrl(entry.page.url())));
    }
    observedOrigins.set(observation, origins);
    if (opts.actionError) {
      observation.error = opts.actionError.error;
      observation.code = opts.actionError.code;
    }
    const origin = originOfUrl(url);
    if (needsHuman === 'challenge' || needsHuman === 'captcha' || cloudflare) {
      await this.handOverHumanCheck(
        observation,
        {
          origin,
          url: this.redact(url),
          title: this.redact(title),
          kind: needsHuman === 'captcha' ? 'captcha' : 'challenge',
        },
        opts.signal,
      );
    } else if (needsHuman) {
      const matches =
        this.turn.vaultMatches && origin
          ? await this.turn.vaultMatches(origin).catch(() => [])
          : this.turn.vaultMatches
            ? []
            : null;
      observation.hint = needsHumanHint(needsHuman, origin, matches, !this.turn.background);
    }
    return observation;
  }
}

class StaleRefError extends Error {
  constructor(readonly ref: string) {
    super(`stale ref ${ref}`);
  }
}

class RefError extends Error {
  constructor(ref: string | undefined) {
    super(`invalid ref ${ref ?? ''}`);
  }
}

// ─── Lease lookups for other modules ──────────────────────

/**
 * The current page of a Bot's foreground lease in a conversation, without
 * starting the computer or opening a window (null when there is none).
 */
export async function findLeasePage(
  userId: string,
  botId: string,
  sessionId: string,
  deps: ComputerDeps = defaultComputerDeps,
): Promise<{ page: Page; registry: LeaseRegistry; lease: TabLease } | null> {
  if (!(await deps.isRunning(userId).catch(() => false))) return null;
  const browser = rememberConnection(userId, await deps.getBrowser(userId));
  const registry = leaseRegistryFor(browser);
  const lease = await registry.acquire({ kind: 'foreground', botId, sessionId }, { create: false });
  const page = lease?.currentPage();
  return page && lease ? { page, registry, lease } : null;
}

/**
 * Open `url` in a Bot's foreground tab of a conversation, opening its window
 * when there is none — for server-side flows that need the Bot's page back
 * (a secure sign-in whose page the computer lost). The caller has validated
 * the URL (normalizeBrowseUrl) and checks where the page ended up.
 */
export async function openLeasePage(
  userId: string,
  botId: string,
  sessionId: string,
  url: string,
  deps: ComputerDeps = defaultComputerDeps,
): Promise<{ page: Page; registry: LeaseRegistry; lease: TabLease }> {
  const browser = rememberConnection(userId, await deps.getBrowser(userId));
  const registry = leaseRegistryFor(browser);
  const lease = await registry.acquire({ kind: 'foreground', botId, sessionId }, { create: true });
  if (!lease) throw new Error('The Bot has no tab');
  // Serialised with the Bot's own actions on this tab, like every page step.
  const page = await lease.run(async () => {
    const current = lease.currentPage();
    if (!current) throw new Error('The Bot has no tab');
    await current.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await current.waitForLoadState('load', { timeout: 3_000 }).catch(() => undefined);
    await registry.retag(lease, current);
    lease.touch(current);
    return current;
  });
  return { page, registry, lease };
}

/**
 * Close a background turn's clean browser context (idempotent). Only through
 * a DevTools connection this process already holds: connecting just to close
 * a context would kick another API slot off the single-client relay (and the
 * context dies anyway — a later connection sweeps it, see tab-leases.ts).
 */
export async function releaseTurnLeases(
  userId: string,
  turnId: string,
  deps: ComputerDeps = defaultComputerDeps,
): Promise<void> {
  try {
    const browser = heldConnection(userId);
    if (!browser || !(await deps.isRunning(userId))) return;
    await leaseRegistryFor(browser).release(`bg:${turnId}`);
  } catch (err) {
    logger.warn('[bots/browser] releasing a background lease failed', { userId, turnId, error: toErrorMessage(err) });
  }
}
