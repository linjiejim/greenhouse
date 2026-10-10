/**
 * Low-level access to a member's computer — the seam between the computer
 * runtime (lifecycle, tunnels) and the browser/vault/tool layer.
 *
 * Contract (keep the signatures):
 * - Every function first makes sure the member's computer is running (starting
 *   it, waiting in the capacity queue for at most ~45 s) and records activity.
 * - `getBrowser` returns a Playwright Browser connected over the DevTools pipe
 *   tunnel with `noDefaults: true`, cached per member and reconnected on drop;
 *   aria-ref handles stay valid between calls on the same connection. Only
 *   one process at a time owns a member's DevTools (cdp-owner.ts): another
 *   process waits up to ~15 s for it, then gets a retryable `busy`.
 * - `execInComputer` runs as uid `agent` by default, enforces the deadline
 *   inside the container (`timeout -k 5 <s> setsid bash -lc …`) and kills the
 *   whole session on abort (including a take-over).
 * - Lease: Bot actions must check `currentLease(...).controller === 'bot'` before
 *   acting and re-check the epoch before returning any observation.
 * - Take-over aborts in-flight work in this process: shell and file commands
 *   are tracked here; browser and vault steps register themselves with
 *   `trackComputerAction` (and may subscribe to `onComputerActionsAborted`), so
 *   `abortComputerActions` reaches them too. Playwright steps take no signal,
 *   so the browser layer still re-checks the lease before every step that
 *   cannot be undone (a click, Enter) — the signal only stops waits early.
 */

import { chromium, type Browser } from 'playwright-core';
import { getDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

import { openCdpBridge, type CdpBridge } from './cdp-bridge.js';
import { createCdpOwnership } from './cdp-owner.js';
import { ComputerDockerError } from './docker.js';
import { ComputerUnavailableError } from './errors.js';
import { computerLifecycleHooks } from './hooks.js';
import { requireComputerRuntime } from './runtime.js';
import { runShell } from './shell.js';
import { leaseRegistryFor } from './tab-leases.js';

export { ComputerUnavailableError } from './errors.js';
export type { ComputerUnavailableCode } from './errors.js';

export interface ExecOptions {
  timeoutSec: number;
  signal?: AbortSignal;
  /** `agent` (default) for Bot commands; `browser` only for trusted API-side helpers. */
  user?: 'agent' | 'browser';
  cwd?: string;
  stdin?: Buffer;
  /** Cap on captured stdout+stderr bytes (default 64 KiB); the rest is dropped. */
  maxOutputBytes?: number;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface ComputerLease {
  controller: 'bot' | 'user';
  epoch: number;
}

export interface EnsureOptions {
  signal?: AbortSignal;
  /** Called while waiting for a free slot (1-based queue position). */
  onQueued?: (position: number) => void;
  /**
   * Stop waiting after this long — the start goes on. A Bot's tool call must answer before the
   * model stream's idle timeout ends its turn (agent-core CHAT_STREAM_TIMEOUT.chunkMs, 2 min),
   * and a start that moves a home into an upgraded computer can take longer than that.
   */
  maxWaitMs?: number;
}

/** How long a Bot's tool waits for the computer before saying it is still starting (EnsureOptions.maxWaitMs). */
export const BOT_START_WAIT_MS = 90_000;

/** Largest file `writeComputerFile` accepts. */
const MAX_WRITE_BYTES = 64 * 1024 * 1024;

// ─── Ensure ───────────────────────────────────────────────

async function ensureRunningRow(userId: string, opts: EnsureOptions & { allowOverQuota?: boolean } = {}) {
  const { controller } = requireComputerRuntime();
  const running = controller.ensureRunning(userId, opts);
  if (!opts.maxWaitMs) return await running;
  // It goes on without us: the next tool call (or the member's panel) finds it running.
  running.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ComputerUnavailableError(
            'busy',
            'The computer is still starting — after an upgrade it first moves its files into the updated computer, which can take a few minutes. Tell the member, end your turn, and try again in a minute or two.',
          ),
        ),
      opts.maxWaitMs,
    );
  });
  try {
    return await Promise.race([running, gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

export async function ensureComputerReady(userId: string, opts: EnsureOptions = {}): Promise<void> {
  await ensureRunningRow(userId, opts);
}

/** Map an exec failure on a running computer (gone, stopped) to the member's row and a tool-friendly error. */
export async function containerFailed(userId: string, err: unknown): Promise<never> {
  if (err instanceof ComputerDockerError && (err.code === 'not_found' || err.code === 'not_running')) {
    try {
      await requireComputerRuntime().controller.markBroken(userId, 'exited');
    } catch {
      /* runtime closed meanwhile */
    }
    throw new ComputerUnavailableError('stopped', 'The computer stopped unexpectedly; it restarts on the next use');
  }
  throw err;
}

// ─── Browser (one DevTools connection per member per process) ─

interface BrowserEntry {
  browser: Browser;
  bridge: CdpBridge;
  container: string;
  startedAt: string | null;
}

const browsers = new Map<string, Promise<BrowserEntry>>();

/** Which members' DevTools this process owns (cdp-owner.ts); letting go drops the connection. */
const ownership = createCdpOwnership({
  store: () => getDb().botComputers,
  disconnect: (userId) => dropBrowser(userId),
});

function dropBrowser(userId: string): void {
  const entry = browsers.get(userId);
  if (!entry) return;
  browsers.delete(userId);
  void entry
    .then(async ({ browser, bridge }) => {
      await browser.close().catch(() => {});
      await bridge.close();
    })
    .catch(() => {});
}

async function connectBrowser(userId: string, container: string, startedAt: string | null): Promise<BrowserEntry> {
  const { host } = requireComputerRuntime();
  const bridge = await openCdpBridge({
    spawnTunnel: () => host.openTunnel(container, 'cdp'),
  });
  try {
    // noDefaults: no download redirection to the API host, no focus/media
    // emulation that would change what the member sees on the shared screen.
    const browser = await chromium.connectOverCDP(bridge.url, { noDefaults: true, timeout: 30_000 });
    const entry: BrowserEntry = { browser, bridge, container, startedAt };
    browser.on('disconnected', () => {
      void browsers.get(userId)?.then((current) => {
        if (current === entry) browsers.delete(userId);
      });
      void bridge.close();
    });
    return entry;
  } catch (err) {
    await bridge.close();
    throw new ComputerUnavailableError(
      'start_failed',
      `Could not connect to the computer's browser: ${toErrorMessage(err)}`,
    );
  }
}

export async function getBrowser(userId: string, opts: EnsureOptions = {}): Promise<Browser> {
  const row = await ensureRunningRow(userId, opts);
  ownership.touch(userId);
  // Re-read the cache after every await: a concurrent caller may have replaced
  // the entry meanwhile, and the relay accepts ONE DevTools client — a second
  // connection from this process would kick the first mid-action. From the
  // empty-map check to `browsers.set` below nothing awaits (the connecting
  // block returns its promise before its first await), so exactly one waiter
  // reconnects and the others adopt its promise.
  for (;;) {
    const cached = browsers.get(userId);
    if (!cached) break;
    const entry = await cached.catch(() => null);
    // A restarted computer is a new container: the old connection is dead even
    // if its 'disconnected' event has not arrived yet.
    if (
      entry &&
      entry.browser.isConnected() &&
      entry.container === row.container_name &&
      entry.startedAt === row.last_started_at
    ) {
      return entry.browser;
    }
    if (browsers.get(userId) !== cached) continue; // replaced while we waited: judge that one
    dropBrowser(userId);
    break;
  }
  // Claim the member's DevTools first (another slot may own it), inside the
  // shared promise so concurrent callers wait on one claim and one connect.
  // Counted as browser use, so a slow connect is never mistaken for idleness.
  const pending = (async () => {
    ownership.begin(userId);
    try {
      const claim = await ownership.claim(userId);
      const entry = await connectBrowser(userId, row.container_name, row.last_started_at);
      // New to this process: no live process owns the contexts still there
      // (an owner that died, or one that closed its own on letting go).
      if (claim.fresh) leaseRegistryFor(entry.browser).expireForeign();
      return entry;
    } finally {
      ownership.end(userId);
    }
  })();
  browsers.set(userId, pending);
  try {
    return (await pending).browser;
  } catch (err) {
    if (browsers.get(userId) === pending) browsers.delete(userId);
    throw err;
  }
}

// ─── In-flight actions (aborted by a take-over) ───────────

/** Why this process's computer work for a member was aborted. */
export type ComputerAbortReason = 'takeover' | 'purge';

/**
 * The `signal.reason` of an action aborted by `abortComputerActions`. Named
 * AbortError like a DOM abort; `toUnavailable()` is what a tool reports
 * (`user_in_control` for a take-over, `stopped` for a purge).
 */
export class ComputerActionsAbortedError extends Error {
  constructor(readonly reason: ComputerAbortReason) {
    super(reason === 'takeover' ? 'The member took over the computer' : 'The computer was removed');
    this.name = 'AbortError';
  }

  toUnavailable(): ComputerUnavailableError {
    return new ComputerUnavailableError(this.reason === 'takeover' ? 'user_in_control' : 'stopped', this.message);
  }
}

export interface TrackedComputerAction {
  /** Aborts when `signal` does, or when the member's computer work is aborted. */
  signal: AbortSignal;
  /** Always call (finally): stops tracking. */
  done(): void;
}

type AbortListener = (userId: string, reason: ComputerAbortReason) => void;
const inflight = new Map<string, Set<AbortController>>();
const abortListeners = new Set<AbortListener>();

function trackAction(userId: string, signal?: AbortSignal): TrackedComputerAction {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let set = inflight.get(userId);
  if (!set) inflight.set(userId, (set = new Set()));
  const own = set;
  own.add(controller);
  return {
    signal: controller.signal,
    done() {
      signal?.removeEventListener('abort', onAbort);
      own.delete(controller);
      if (own.size === 0 && inflight.get(userId) === own) inflight.delete(userId);
    },
  };
}

/**
 * Register a unit of computer work for the member (a browser step, a vault
 * fill) so a take-over or purge aborts it: use the returned signal for every
 * wait and call `done()` in `finally`. Shell and file commands in this module
 * are tracked already.
 */
export function trackComputerAction(userId: string, signal?: AbortSignal): TrackedComputerAction {
  // Browser work: the DevTools owner never lets go while one is in flight.
  ownership.begin(userId);
  const action = trackAction(userId, signal);
  let done = false;
  return {
    signal: action.signal,
    done() {
      if (done) return;
      done = true;
      action.done();
      ownership.end(userId);
    },
  };
}

/**
 * Called whenever `abortComputerActions` runs for a member (after the tracked
 * signals were aborted) — for work that is not a single signal-bound step,
 * e.g. dropping queued browser actions. Returns the unsubscribe.
 */
export function onComputerActionsAborted(listener: AbortListener): () => void {
  abortListeners.add(listener);
  return () => abortListeners.delete(listener);
}

/** Abort every computer action this process is running for the member (take-over, purge). */
export function abortComputerActions(userId: string, reason: ComputerAbortReason = 'takeover'): number {
  const set = inflight.get(userId);
  const count = set?.size ?? 0;
  for (const controller of set ?? []) controller.abort(new ComputerActionsAbortedError(reason));
  for (const listener of abortListeners) {
    try {
      listener(userId, reason);
    } catch (err) {
      logger.warn(`[bots-computer] abort listener failed: ${toErrorMessage(err)}`);
    }
  }
  return count;
}

// ─── Shell and files ──────────────────────────────────────

export async function execInComputer(userId: string, command: string, opts: ExecOptions): Promise<ExecResult> {
  const row = await ensureRunningRow(userId, { signal: opts.signal });
  const { host, config } = requireComputerRuntime();
  const action = trackAction(userId, opts.signal);
  try {
    return await runShell(host, row.container_name, command, {
      user: opts.user ?? 'agent',
      timeoutSec: opts.timeoutSec,
      signal: action.signal,
      cwd: opts.cwd,
      stdin: opts.stdin,
      maxOutputBytes: opts.maxOutputBytes,
      proxy: config.proxy,
    });
  } catch (err) {
    return await containerFailed(userId, err);
  } finally {
    action.done();
    void touchComputer(userId);
  }
}

/** Positional-argument scripts: the path is `$1`, never interpolated into the script. */
const READ_FILE_SCRIPT =
  'f="$1"; max="$2"; [ -f "$f" ] || { echo "not a regular file: $f" >&2; exit 3; }; ' +
  's=$(stat -c %s -- "$f") || exit 3; [ "$s" -le "$max" ] || { echo "file too large: $s bytes" >&2; exit 4; }; exec cat -- "$f"';
const WRITE_FILE_SCRIPT = 'f="$1"; d=$(dirname -- "$f"); mkdir -p -- "$d" && cat >"$f"';

/**
 * Paths reach the container as an argument, never a script, but control
 * characters still have no business in one — and a newline would let a path
 * the model chose forge extra lines in the command's stderr.
 */
function checkPath(path: string): void {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (!path || /[\x00-\x1f\x7f]/.test(path) || path.length > 4096) {
    throw new ComputerDockerError('failed', 'Invalid file path');
  }
}

/** An aborted file command: a take-over/purge as the unavailable error it means, a stopped turn as an AbortError. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof ComputerActionsAbortedError) throw signal.reason.toUnavailable();
  if (signal.reason instanceof ComputerUnavailableError) throw signal.reason;
  const err = new Error('Stopped');
  err.name = 'AbortError';
  throw err;
}

/**
 * Read a file as uid `agent` (relative paths are under /home/agent). The agent
 * uid cannot read the browser's profile, so neither can this.
 */
export async function readComputerFile(
  userId: string,
  path: string,
  opts: { maxBytes: number; signal?: AbortSignal },
): Promise<Buffer> {
  checkPath(path);
  const row = await ensureRunningRow(userId, { signal: opts.signal });
  const { host } = requireComputerRuntime();
  const action = trackAction(userId, opts.signal);
  try {
    const result = await host.exec({
      container: row.container_name,
      user: 'agent',
      cwd: '/home/agent',
      env: { HOME: '/home/agent' },
      argv: ['sh', '-c', READ_FILE_SCRIPT, 'gh-read', path, String(opts.maxBytes)],
      timeoutMs: 60_000,
      maxStdoutBytes: opts.maxBytes,
      signal: action.signal,
    });
    throwIfAborted(action.signal);
    if (result.code === 4) throw new ComputerDockerError('too_large', result.stderr.trim() || 'File too large');
    if (result.code !== 0) throw new ComputerDockerError('failed', result.stderr.trim() || `Cannot read ${path}`);
    return result.stdout;
  } catch (err) {
    return await containerFailed(userId, err);
  } finally {
    action.done();
    void touchComputer(userId);
  }
}

/** Write a file as uid `agent` (parents created; relative paths under /home/agent). */
export async function writeComputerFile(
  userId: string,
  path: string,
  content: Buffer,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  checkPath(path);
  if (content.length > MAX_WRITE_BYTES) {
    throw new ComputerDockerError('too_large', `Files up to ${MAX_WRITE_BYTES / 1024 / 1024} MiB can be written`);
  }
  const row = await ensureRunningRow(userId, { signal: opts.signal });
  const { host } = requireComputerRuntime();
  const action = trackAction(userId, opts.signal);
  try {
    const result = await host.exec({
      container: row.container_name,
      user: 'agent',
      cwd: '/home/agent',
      env: { HOME: '/home/agent' },
      argv: ['sh', '-c', WRITE_FILE_SCRIPT, 'gh-write', path],
      input: content,
      timeoutMs: 120_000,
      maxStdoutBytes: 4096,
      signal: action.signal,
    });
    throwIfAborted(action.signal);
    if (result.code !== 0) throw new ComputerDockerError('failed', result.stderr.trim() || `Cannot write ${path}`);
  } catch (err) {
    await containerFailed(userId, err);
  } finally {
    action.done();
    void touchComputer(userId);
  }
}

/** Environment of the API-side helpers that talk to the X display as uid `browser`. */
const DESKTOP_ENV = { DISPLAY: ':0', XAUTHORITY: '/home/browser/.Xauthority', HOME: '/home/browser' };

/**
 * Full-desktop PNG (what the member's viewer shows), taken as uid `browser`.
 * Never starts the computer and never counts as activity: a page polling for
 * a thumbnail must not keep a computer alive (or wake it).
 */
export async function captureDesktop(userId: string): Promise<Buffer> {
  const { host } = requireComputerRuntime();
  const row = await getDb().botComputers.get(userId);
  if (row?.state !== 'running') throw new ComputerUnavailableError('stopped', 'The computer is not running');
  try {
    const result = await host.exec({
      container: row.container_name,
      user: 'browser',
      env: DESKTOP_ENV,
      argv: ['import', '-window', 'root', 'png:-'],
      timeoutMs: 30_000,
      maxStdoutBytes: 32 * 1024 * 1024,
    });
    if (result.code !== 0 || result.stdout.length === 0) {
      throw new ComputerDockerError('failed', result.stderr.trim() || 'Screenshot failed');
    }
    return result.stdout;
  } catch (err) {
    return await containerFailed(userId, err);
  }
}

/**
 * Bring the browser window back (`gh-window restore`, as uid `browser`):
 * every Chromium window mapped and raised, a new one opened when none is
 * left. Backs the "back to the browser" button and every hand-back: a
 * minimised or closed window otherwise leaves the member watching a bare
 * desktop. Never starts the computer (`stopped` when it is not running).
 */
export async function restoreBrowserWindow(userId: string): Promise<void> {
  const { host } = requireComputerRuntime();
  const row = await getDb().botComputers.get(userId);
  if (row?.state !== 'running') throw new ComputerUnavailableError('stopped', 'The computer is not running');
  try {
    const result = await host.exec({
      container: row.container_name,
      user: 'browser',
      env: DESKTOP_ENV,
      argv: ['gh-window', 'restore'],
      timeoutMs: 20_000,
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
    });
    if (result.code !== 0) {
      const reason = result.stderr.trim().split('\n').pop() || `exit ${result.code}`;
      throw new ComputerDockerError('failed', `gh-window restore failed: ${reason}`);
    }
  } catch (err) {
    await containerFailed(userId, err);
  }
  void touchComputer(userId);
}

export async function touchComputer(userId: string): Promise<void> {
  try {
    await getDb().botComputers.touch(userId);
  } catch (err) {
    logger.warn(`[bots-computer] touch failed: ${toErrorMessage(err)}`);
  }
}

export async function currentLease(userId: string): Promise<ComputerLease> {
  const row = await getDb().botComputers.get(userId);
  return { controller: row?.lease_controller ?? 'bot', epoch: row?.lease_epoch ?? 0 };
}

// ─── Filled-secret redaction ──────────────────────────────

/**
 * Values the server typed into the member's browser (vault fills, secure
 * sign-in, "type text" during take-over), redacted from every later Bot
 * observation for at least 15 minutes. Deliberately in-process: values never
 * touch the DB, so another API slot or the Runtime worker does not see them —
 * the structured snapshot redaction of password/OTP fields (browser layer) is
 * the durable defence; this map covers the window in which a filled value can
 * still show up as plain text (a field echoing it, a confirmation page).
 */
const SECRET_TTL_MS = 15 * 60_000;
/** Shorter values would redact ordinary words and numbers out of every snapshot. */
const MIN_SECRET_LENGTH = 4;
const REDACTED = '••••••';
const filledSecrets = new Map<string, Map<string, number>>();

function liveSecrets(userId: string): string[] {
  const secrets = filledSecrets.get(userId);
  if (!secrets) return [];
  const now = Date.now();
  for (const [value, expiresAt] of secrets) if (expiresAt <= now) secrets.delete(value);
  if (secrets.size === 0) filledSecrets.delete(userId);
  return [...secrets.keys()];
}

/**
 * Remember a value the server just filled into a page (vault fill, secure
 * sign-in, "type text" during take-over) so every later Bot observation of this
 * member's computer redacts it. TTL ≥ 10 minutes.
 */
export function rememberFilledSecret(userId: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return;
  let secrets = filledSecrets.get(userId);
  if (!secrets) filledSecrets.set(userId, (secrets = new Map()));
  const expiresAt = Date.now() + SECRET_TTL_MS;
  for (const variant of new Set([trimmed, encodeURIComponent(trimmed), JSON.stringify(trimmed).slice(1, -1)])) {
    if (variant.length >= MIN_SECRET_LENGTH) secrets.set(variant, expiresAt);
  }
}

/** Redact remembered secrets from text about to be shown to a Bot. */
export function redactFilledSecrets(userId: string, text: string): string {
  const secrets = liveSecrets(userId);
  if (secrets.length === 0 || !text) return text;
  // Longest first, so a value never leaves a redacted fragment of a longer one behind.
  let out = text;
  for (const secret of secrets.sort((a, b) => b.length - a.length)) out = out.split(secret).join(REDACTED);
  return out;
}

// ─── Lifecycle wiring ─────────────────────────────────────

computerLifecycleHooks.onStopped((userId) => {
  dropBrowser(userId);
  // The container is gone: nothing to keep the other slot waiting for.
  void ownership.release(userId);
});
computerLifecycleHooks.onPurged((userId) => {
  abortComputerActions(userId, 'purge');
  dropBrowser(userId);
  void ownership.release(userId);
  filledSecrets.delete(userId);
});
computerLifecycleHooks.onShutdown(async () => {
  const entries = [...browsers.keys()];
  for (const userId of entries) dropBrowser(userId);
  await ownership.releaseAll();
});
