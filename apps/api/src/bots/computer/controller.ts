/**
 * Computer lifecycle — DB-authoritative, safe with two blue/green API slots on
 * one daemon (spec §6.3, review R12).
 *
 * - What a computer physically is belongs to the host (host.ts): a fresh
 *   container on a named home volume (docker-host.ts — every start a new
 *   `docker run` with the CURRENT argv) or a sandbox at an E2B-protocol
 *   provider that pauses and resumes (e2b-host.ts). The row's
 *   `container_name` is the host's handle for it; a start may change it.
 * - Every transition is a compare-and-set on `bot_computers.version`; starts
 *   and stops of one member run under that member's advisory lock, the
 *   capacity decision under one global lock (always taken in that order, and
 *   never held while waiting for anything slow but the member's own start).
 *   Because a start only ever happens under the member's lock, a row found in
 *   `starting` while holding that lock belongs to a starter that died.
 * - Starts are for members who may use a computer right now (active,
 *   internal, `bots` on), checked under that lock — so a suspend or a
 *   feature-off purge can never be undone by a Bot action already in flight.
 * - Capacity: at most `maxRunning` computers in starting/running/stopping.
 *   When full, the least recently used idle computer is stopped to make room
 *   (never one whose Bot waits on a sign-in or take-over card younger than
 *   HUMAN_WAIT_HOLD_MS); otherwise the caller waits in line (≤45 s) and then
 *   gets `busy`.
 * - Each start carries the member's own settings: their timezone
 *   (`bot_computers.timezone`, else the deployment default) and a browser
 *   language from their account locale (unless BOTS_COMPUTER_LANG overrides
 *   it for everyone).
 * - Loops (scheduled by runtime.ts): idle (60 s) stops computers nobody used
 *   for `idleMinutes` — unless background jobs still run on one, which keeps
 *   it up to BOTS_COMPUTER_JOB_MAX_HOURS after its last activity; health
 *   (30 s) settles starts/stops whose process died
 *   and reconciles running rows against ONE host listing; disk (hourly, every
 *   2 min for a home over the soft limit) measures the homes; reconcile (boot
 *   and every time the host comes back) clears orphans inside this namespace.
 * - Host disk (docker only — spec D16: named volumes have no hard quota, so
 *   the Docker disk itself is guarded): free space is read with `df` from inside a
 *   running computer — its home volume lives on that disk — right after each
 *   start, with every disk measurement, and from the health loop while a
 *   reading is old or low. Below HOST_DISK_MIN_FREE_RATIO no new computer
 *   starts (`over_quota`, reason `host_disk`); running ones keep running. A
 *   reading expires after HOST_DISK_READING_TTL_MS, so a host cleaned up while
 *   nothing ran is not refused forever: the next start measures again.
 * - Sweeps only act on a member's row while holding that member's lock, and
 *   never wait for it: a held lock means someone is at work on it.
 * - Errors are classified (docker.ts): a broken computer marks only its row;
 *   a broken host reports through `onRuntimeError` and closes the runtime.
 */

import { nowIso } from '@greenhouse/utils/date';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { BotComputerRow, BotComputerService } from '@greenhouse/db';

import { computerLang, parseTimezone, type BotsComputerConfig } from './config.js';
import { ComputerDockerError, ComputerRuntimeError } from './docker.js';
import { ComputerUnavailableError } from './errors.js';
import {
  ComputerStartError,
  type ComputerHost,
  type HomeRestore,
  type HostInstance,
  type StartedComputer,
  type StopVerdict,
} from './host.js';
import { computerIdentity } from './namespace.js';

/** safeJsonParse with the caller's expected shape (still validated field by field). */
function parseJson<T>(text: string): T | null {
  return safeJsonParse(text, null) as T | null;
}

export type TryLockResult<T> = { acquired: true; value: T } | { acquired: false };

export type ComputerStore = Pick<
  BotComputerService,
  | 'get'
  | 'ensure'
  | 'list'
  | 'listByStates'
  | 'transition'
  | 'touch'
  | 'listIdle'
  | 'setDisk'
  | 'delete'
  | 'withUserLock'
  | 'withCapacityLock'
> & {
  /**
   * Run `fn` holding the member's lock only if it is free right now
   * (pg_try_advisory_xact_lock; db.botComputers ships it). Optional so a store
   * without it still works: the sweeps then take the blocking lock, and only
   * for rows past the deadline by which any live holder must have finished.
   */
  tryWithUserLock?<T>(userId: string, fn: () => Promise<T>): Promise<TryLockResult<T>>;
};

/** What the controller needs to know right now (config and knobs can change at runtime). */
export interface ControllerEnvironment {
  config: BotsComputerConfig;
  /** Effective concurrency (knob clamped by host memory). */
  maxRunning: number;
  idleMinutes: number;
  /** Chromium URLBlocklist patterns passed to new containers. */
  urlBlocklist: string[];
  /**
   * Hardened hosts: URLs a fresh computer must NOT be able to connect to (the
   * host's API port on the bridge gateway, cloud metadata). Checked after every
   * start as defence in depth behind the egress precheck; empty = no probe.
   */
  egressProbe?: string[];
  /** The image (docker) / template (e2b) the prechecks found ready; recorded as `image_id`. */
  imageId: string | null;
  /** The latest free-space reading of the Docker disk (null = not measured yet; docker only). */
  hostDisk?: HostDiskReading | null;
}

/** Free space on the Docker host's disk, read from inside a running computer. */
export interface HostDiskReading {
  /** available / size, 0–1. */
  freeRatio: number;
  availableBytes: number;
  totalBytes: number;
  /** Epoch ms of the reading. */
  measuredAt: number;
}

/** Below this share of free space on the Docker disk, no new computer starts. */
export const HOST_DISK_MIN_FREE_RATIO = 0.1;
/** A reading older than this no longer refuses starts (the next start measures again). */
export const HOST_DISK_READING_TTL_MS = 15 * 60_000;
/** While computers run, the reading is refreshed at least this often… */
const HOST_DISK_REMEASURE_MS = 5 * 60_000;
/** …and this often while it is low, so a cleanup reopens starts quickly. */
const HOST_DISK_LOW_REMEASURE_MS = 2 * 60_000;

/** Whether a reading refuses new starts right now. */
export function hostDiskRefusesStarts(reading: HostDiskReading | null | undefined, now: number): boolean {
  return (
    !!reading && now - reading.measuredAt < HOST_DISK_READING_TTL_MS && reading.freeRatio < HOST_DISK_MIN_FREE_RATIO
  );
}

/**
 * `df -P -k <path>` → the reading, or null when the output makes no sense
 * (POSIX mode keeps each filesystem on one line: name, 1024-blocks, used,
 * available, capacity, mount point).
 */
export function parseDfOutput(stdout: string, measuredAt: number): HostDiskReading | null {
  const line = stdout.trim().split('\n').pop() ?? '';
  const fields = line.trim().split(/\s+/);
  if (fields.length < 6) return null;
  const totalKib = Number(fields[1]);
  const availableKib = Number(fields[3]);
  if (!Number.isFinite(totalKib) || !Number.isFinite(availableKib) || totalKib <= 0 || availableKib < 0) return null;
  return {
    freeRatio: Math.min(availableKib / totalKib, 1),
    availableBytes: availableKib * 1024,
    totalBytes: totalKib * 1024,
    measuredAt,
  };
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

export type StopReason = 'idle' | 'lru' | 'reset' | 'suspend' | 'admin' | 'user' | 'purge';

export interface ComputerControllerDeps {
  store: ComputerStore;
  host: ComputerHost;
  environment(): Promise<ControllerEnvironment>;
  /** true = active internal user with `bots` on, false = exists but may not use it, null = gone. */
  userIsActive(userId: string): Promise<boolean | null>;
  /**
   * A Bot of this member waits on a secure sign-in or take-over card younger
   * than HUMAN_WAIT_HOLD_MS (limits.ts): its page must survive until the member answers.
   */
  awaitingHuman?(userId: string): Promise<boolean>;
  clock?: Clock;
  /** A row changed state or reason (pushed to the owner over WS). */
  onState?(row: BotComputerRow): void;
  /** The computer went away (drop cached DevTools connections, viewers die with their tunnels). */
  onStopped?(userId: string, reason: string): void;
  /** The host itself failed; the runtime goes unavailable and re-checks. */
  onRuntimeError?(err: ComputerRuntimeError): void;
  /** A new free-space reading of the Docker disk (the runtime keeps the latest). */
  onHostDisk?(reading: HostDiskReading): void;
  /** The member's account locale (the browser language follows it); null = unknown. */
  memberLocale?(userId: string): Promise<string | null>;
  /** Background jobs running on a computer (gh-jobs, by `container_name`); never throws, 0 when unreadable. */
  runningJobs?(container: string): Promise<number>;
  /** Encrypted backups of the homes (backups.ts), when the deployment keeps them. */
  backups?: ControllerBackups;
}

/** What the controller asks of backups.ts. */
export interface ControllerBackups {
  /** Before an idle stop: 'wait' while the computer's backup runs (starting one when due). */
  beforeSleep(row: BotComputerRow, idleMinutes: number): Promise<'go' | 'wait'>;
  /** The newest backup, for a start that has to make the member's home from nothing. */
  restoreSource(userId: string): Promise<HomeRestore | null>;
  /** A start put this backup into a new home (called once the computer runs). */
  restored(backupId: string): Promise<void>;
  /** The member's home was wiped: its backups go too. */
  deleteAll(userId: string): Promise<void>;
}

export interface EnsureRunningOptions {
  signal?: AbortSignal;
  onQueued?: (position: number) => void;
  /** A member opening their own computer may start it over the soft disk limit (to clean up). */
  allowOverQuota?: boolean;
}

/** How long a caller waits for a free slot before `busy`. */
export const QUEUE_WAIT_MS = 45_000;
/** How long a started computer may take until DevTools answers. */
export const READY_TIMEOUT_MS = 45_000;
/** Transitional rows younger than this belong to someone at work; never second-guess them. */
export const STALE_TRANSITION_MS = 60_000;
/**
 * The longest a docker start can keep a row in `starting` (volume create 30 s,
 * rm 60 s, run 90 s, ready 45 s, egress probe 30 s, each bounded by its own
 * deadline): past it the starter is certainly gone, even without a try-lock.
 * A start that moves a home (e2b, bounded at 10 minutes) or restores one from a
 * backup (15) can take longer; stores with a try-lock (the real one) never rely
 * on this deadline — they see the starter's lock.
 */
export const START_DEADLINE_MS = 5 * 60_000;
/** A home over the soft limit is re-measured this often while running, so a cleanup unblocks quickly. */
export const OVER_QUOTA_REMEASURE_MS = 2 * 60_000;
/** A computer is evictable once its Bots and viewers have been quiet this long. */
export const EVICT_MIN_IDLE_MS = 2 * 60_000;
const VIEWER_FRESH_MS = 60_000;
/** Soft per-member disk limit (spec D16): beyond it, no automatic starts until cleaned up. */
export const DISK_SOFT_LIMIT_BYTES = 5 * 1024 ** 3;
const TOUCH_THROTTLE_MS = 15_000;
/** Idle rounds a computer that cannot answer "any jobs running?" is given before it is stopped anyway. */
const JOB_QUERY_GRACE = 3;

/** Asks Chromium for its version through the relay, from inside the computer as `browser`. */
const READY_PROBE = [
  'import socket, sys',
  's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
  's.settimeout(4)',
  "s.connect('/tmp/browser/cdp.sock')",
  's.sendall(b\'{"id":1,"method":"Browser.getVersion"}\\0\')',
  "buf = b''",
  "while b'\\0' not in buf:",
  '    chunk = s.recv(65536)',
  '    if not chunk:',
  '        break',
  '    buf += chunk',
  "sys.stdout.write(buf.split(b'\\0', 1)[0].decode('utf-8', 'replace'))",
].join('\n');

/** In-process FIFO per key (one ensure per member at a time; later callers hit the fast path). */
class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    try {
      await previous.catch(() => {});
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/**
 * In-process limiter. Advisory locks hold a pooled connection while they wait
 * (the DB pool has 20), so a burst of starts must queue here, not in Postgres.
 */
class Semaphore {
  private waiting: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** Concurrent start attempts per process (each pins ≤2 connections while it runs). */
const START_CONCURRENCY = 4;

/**
 * Probes each URL with curl from inside the computer (as `agent`, no proxy)
 * and prints "<curl exit code> <url>". 7 (refused) and 28 (timed out) mean no
 * connection was made; anything else — a reply, an empty reply, a reset after
 * connecting, or curl missing — means the rules are not proven in force.
 */
const EGRESS_PROBE_SCRIPT =
  'for u in "$@"; do curl -sS -m 3 --noproxy "*" -o /dev/null "$u" 2>/dev/null; echo "$? $u"; done';
const EGRESS_BLOCKED_CODES = new Set([7, 28]);

type Attempt = { kind: 'running'; row: BotComputerRow } | { kind: 'queued' } | { kind: 'wait' };
type SlotDecision =
  | { kind: 'claimed'; row: BotComputerRow }
  | { kind: 'evict'; victim: BotComputerRow }
  | { kind: 'queued' }
  | { kind: 'lost' };

export function createComputerController(deps: ComputerControllerDeps) {
  const { store, host } = deps;
  const clock = deps.clock ?? systemClock;
  const ensureMutex = new KeyedMutex();
  const startSlots = new Semaphore(START_CONCURRENCY);
  /** One capacity decision at a time per process: one connection waits on the global lock, not N. */
  const capacityGate = new Semaphore(1);
  const lastTouch = new Map<string, number>();
  /** Consecutive idle rounds whose job query failed, per member (jobsKeepAwake). */
  const jobQueryFailures = new Map<string, number>();
  /** Members waiting for a slot in this process, in arrival order. */
  const waiters: string[] = [];

  const iso = (ms: number) => new Date(ms).toISOString();
  const ageMs = (value: string | null | undefined) => (value ? clock.now() - Date.parse(value) : Infinity);

  const emitState = (row: BotComputerRow | undefined) => {
    if (row) deps.onState?.(row);
  };

  function reportRuntime(err: unknown): void {
    if (err instanceof ComputerRuntimeError) deps.onRuntimeError?.(err);
  }

  /**
   * The member's lock for a sweep: taken only when free (a held lock means a
   * start or stop is at work on the row). Stores without a try-lock fall back
   * to the blocking lock; callers then only come here for rows past the
   * deadline of whatever could still hold it.
   */
  async function withFreeUserLock<T>(userId: string, fn: () => Promise<T>): Promise<TryLockResult<T>> {
    if (store.tryWithUserLock) return await store.tryWithUserLock(userId, fn);
    return { acquired: true, value: await store.withUserLock(userId, fn) };
  }

  /** See `awaitingHuman`; a failed lookup protects the computer (stopping it would lose the page). */
  async function isAwaitingHuman(userId: string): Promise<boolean> {
    if (!deps.awaitingHuman) return false;
    try {
      return await deps.awaitingHuman(userId);
    } catch (err) {
      logger.warn(`[bots-computer] pending-request lookup failed for ${userId}: ${toErrorMessage(err)}`);
      return true;
    }
  }

  async function touchThrottled(userId: string): Promise<void> {
    const now = clock.now();
    if (now - (lastTouch.get(userId) ?? 0) < TOUCH_THROTTLE_MS) return;
    lastTouch.set(userId, now);
    await store.touch(userId);
  }

  async function ensureRow(userId: string, namespace: string): Promise<BotComputerRow> {
    return await store.ensure(computerIdentity(namespace, userId));
  }

  /** The browser language for the member's next start (a failed lookup falls back like an unknown locale). */
  async function langFor(userId: string, config: BotsComputerConfig): Promise<string> {
    if (config.lang || !deps.memberLocale) return computerLang(config.lang, null);
    try {
      return computerLang(null, await deps.memberLocale(userId));
    } catch (err) {
      logger.warn(`[bots-computer] could not read the locale of ${userId}: ${toErrorMessage(err)}`);
      return computerLang(null, null);
    }
  }

  /** host.discard without throwing: a broken or interrupted computer goes, the member's files stay. */
  async function discardQuietly(ref: string): Promise<void> {
    try {
      await host.discard(ref);
    } catch (err) {
      reportRuntime(err);
      logger.warn(`[bots-computer] could not remove ${ref}: ${toErrorMessage(err)}`);
    }
  }

  /** host.stop without throwing (the row moves on either way; reconcile clears what is left). */
  async function stopQuietly(ref: string): Promise<void> {
    try {
      await host.stop(ref);
    } catch (err) {
      reportRuntime(err);
      logger.warn(`[bots-computer] could not stop ${ref}: ${toErrorMessage(err)}`);
    }
  }

  async function abandonQuietly(started: StartedComputer): Promise<void> {
    try {
      await started.abandon();
    } catch (err) {
      reportRuntime(err);
      logger.warn(`[bots-computer] could not undo the start of ${started.ref}: ${toErrorMessage(err)}`);
    }
  }

  /** Why a computer whose row says `running` is not; a host that cannot tell says `exited`. */
  async function verdictFor(ref: string, instance: HostInstance | undefined): Promise<StopVerdict> {
    try {
      return await host.verdict(ref, instance);
    } catch (err) {
      reportRuntime(err);
      return { state: 'error', reason: 'exited' };
    }
  }

  async function waitReady(container: string): Promise<string> {
    const deadline = clock.now() + READY_TIMEOUT_MS;
    let lastError = 'no answer';
    while (clock.now() < deadline) {
      try {
        const result = await host.exec({
          container,
          user: 'browser',
          argv: ['python3', '-c', READY_PROBE],
          timeoutMs: 8_000,
          maxStdoutBytes: 16 * 1024,
        });
        const reply = parseJson<{ result?: { product?: string } } | null>(result.stdout.toString('utf8'));
        if (result.code === 0 && reply?.result?.product) return reply.result.product;
        lastError = result.stderr.trim().split('\n').pop() || `exit ${result.code}`;
      } catch (err) {
        if (err instanceof ComputerDockerError && err.code === 'not_running') throw err;
        if (err instanceof ComputerRuntimeError) throw err;
        lastError = toErrorMessage(err);
      }
      await clock.sleep(500);
    }
    throw new ComputerDockerError('timeout', `The browser did not come up within 45 s (${lastError})`);
  }

  /**
   * Hardened hosts: the egress precheck verified the iptables rules; this
   * proves them from inside the fresh computer before anyone uses it. A
   * connection that succeeds is a host failure (the rules are gone or
   * shadowed): the start fails and the runtime closes until it re-checks.
   */
  async function verifyEgress(container: string, targets: string[]): Promise<void> {
    if (targets.length === 0) return;
    const result = await host.exec({
      container,
      user: 'agent',
      argv: ['sh', '-c', EGRESS_PROBE_SCRIPT, 'gh-egress', ...targets],
      timeoutMs: 30_000,
      maxStdoutBytes: 16 * 1024,
    });
    const codes = new Map<string, number>();
    for (const line of result.stdout.toString('utf8').split('\n')) {
      const match = /^(\d+) (\S+)$/.exec(line.trim());
      if (match) codes.set(match[2]!, Number(match[1]));
    }
    const open = targets.filter((url) => !EGRESS_BLOCKED_CODES.has(codes.get(url) ?? -1));
    if (open.length > 0) {
      const detail = open.map((url) => `${url} (curl ${codes.get(url) ?? 'gave no answer'})`).join(', ');
      throw new ComputerRuntimeError(
        'network_invalid',
        `A new computer could reach ${detail}; the egress rules for the computers' network are not in force`,
      );
    }
  }

  async function pickEvictable(active: BotComputerRow[]): Promise<BotComputerRow | undefined> {
    const now = clock.now();
    const candidates = active
      .filter(
        (row) =>
          row.state === 'running' &&
          row.lease_controller === 'bot' &&
          now - Date.parse(row.last_active_at) >= EVICT_MIN_IDLE_MS &&
          ageMs(row.viewer_heartbeat_at) >= VIEWER_FRESH_MS,
      )
      .sort((a, b) => Date.parse(a.last_active_at) - Date.parse(b.last_active_at));
    // Least recently used first, skipping computers whose Bot waits on the member.
    for (const row of candidates) if (!(await isAwaitingHuman(row.user_id))) return row;
    return undefined;
  }

  async function claimSlot(row: BotComputerRow, env: ControllerEnvironment): Promise<SlotDecision> {
    const active = (await store.listByStates(['starting', 'running', 'stopping'])).filter(
      (r) => r.user_id !== row.user_id,
    );
    if (active.length < env.maxRunning) {
      const claimed = await store.transition(row.user_id, row.version, ['absent', 'error'], {
        state: 'starting',
        state_reason: null,
      });
      return claimed ? { kind: 'claimed', row: claimed } : { kind: 'lost' };
    }
    const victim = await pickEvictable(active);
    if (victim) {
      const stopping = await store.transition(victim.user_id, victim.version, ['running'], {
        state: 'stopping',
        state_reason: 'lru',
      });
      if (stopping) return { kind: 'evict', victim: stopping };
    }
    return { kind: 'queued' };
  }

  async function finishStop(row: BotComputerRow, reason: StopReason, startedAt: number): Promise<void> {
    await stopQuietly(row.container_name);
    const absent = await store.transition(row.user_id, row.version, ['stopping'], {
      state: 'absent',
      state_reason: reason,
    });
    lastTouch.delete(row.user_id);
    logger.info('[bots-computer] stop', {
      user_id: row.user_id,
      container: row.container_name,
      reason,
      duration_ms: clock.now() - startedAt,
    });
    deps.onStopped?.(row.user_id, reason);
    emitState(absent);
  }

  async function startContainer(
    row: BotComputerRow,
    env: ControllerEnvironment,
    opts: { fresh: boolean },
  ): Promise<BotComputerRow> {
    const startedAt = clock.now();
    const { config } = env;
    let started: StartedComputer | null = null;
    try {
      started = await host.start(row, {
        config,
        image: env.imageId,
        urlBlocklist: env.urlBlocklist,
        // Validated when stored; re-checked here because it becomes the computer's TZ.
        timezone: parseTimezone(row.timezone) ?? config.timezone,
        lang: await langFor(row.user_id, config),
        fresh: opts.fresh,
        // Only for a member who had a computer before: a first computer starts empty.
        ...(deps.backups && row.last_started_at ? { restore: () => deps.backups!.restoreSource(row.user_id) } : {}),
      });
      const product = await waitReady(started.ref);
      await verifyEgress(started.ref, env.egressProbe ?? []);
      const running = await store.transition(row.user_id, row.version, ['starting'], {
        state: 'running',
        state_reason: null,
        last_started_at: nowIso(),
        image_id: started.imageId,
        container_name: started.ref,
      });
      if (!running) {
        // Purged or reset while starting: the newer decision wins.
        await abandonQuietly(started);
        throw new ComputerUnavailableError('stopped', 'The computer was stopped while it was starting');
      }
      lastTouch.delete(row.user_id);
      await touchThrottled(row.user_id);
      // After `last_started_at`: the member's view tells this run began from the backup.
      if (started.restoredFrom) {
        await deps.backups?.restored(started.restoredFrom).catch((err) => {
          logger.warn(
            `[bots-computer] could not mark backup ${started?.restoredFrom} restored: ${toErrorMessage(err)}`,
          );
        });
      }
      logger.info('[bots-computer] start', {
        user_id: row.user_id,
        container: running.container_name,
        duration_ms: clock.now() - startedAt,
        browser: product,
        host: host.kind,
        ...(host.kind === 'docker' ? { runtime: config.runtime } : {}),
      });
      emitState(running);
      // Started on a stale over-quota reading (or to clean up): measure now, so
      // the next automatic start is decided on what is really on disk.
      if (running.disk_bytes !== null && running.disk_bytes > DISK_SOFT_LIMIT_BYTES) void measureDisk(running);
      // Every start re-reads the Docker disk (cheap): it decides the next start.
      if (host.sharedDisk) void measureHostDisk(running);
      return running;
    } catch (err) {
      if (err instanceof ComputerUnavailableError) throw err;
      // A start that got nowhere may still have left something behind under the row's name.
      if (started) await abandonQuietly(started);
      else await discardQuietly(row.container_name);
      const reason =
        err instanceof ComputerRuntimeError || err instanceof ComputerStartError ? err.reason : 'start_failed';
      emitState(
        await store.transition(row.user_id, row.version, ['starting'], { state: 'error', state_reason: reason }),
      );
      logger.warn('[bots-computer] start failed', {
        user_id: row.user_id,
        container: started?.ref ?? row.container_name,
        reason,
        error: toErrorMessage(err),
        duration_ms: clock.now() - startedAt,
      });
      if (err instanceof ComputerRuntimeError) {
        reportRuntime(err);
        throw new ComputerUnavailableError('unavailable', 'Computers are unavailable on this server right now');
      }
      throw new ComputerUnavailableError('start_failed', `The computer could not start: ${toErrorMessage(err)}`);
    }
  }

  /**
   * Settle a transitional row whose worker is gone (the caller holds the
   * member's lock and has just re-read `row`): finish a half-done stop, or
   * clear a start whose starter died. Shared by attemptStart and the sweeps so
   * the two can never drift apart.
   */
  async function settleDead(row: BotComputerRow): Promise<BotComputerRow | undefined> {
    const stopping = row.state === 'stopping';
    if (stopping) await stopQuietly(row.container_name);
    else await discardQuietly(row.container_name);
    const settled = await store.transition(row.user_id, row.version, [row.state], {
      state: 'absent',
      state_reason: stopping ? row.state_reason : 'start_interrupted',
    });
    if (!settled) return undefined;
    lastTouch.delete(row.user_id);
    logger.info('[bots-computer] settled an interrupted transition', {
      user_id: row.user_id,
      from: row.state,
      reason: settled.state_reason,
    });
    deps.onStopped?.(row.user_id, settled.state_reason ?? 'interrupted');
    emitState(settled);
    return settled;
  }

  /**
   * A home over the soft limit blocks automatic starts — but only on a fresh
   * reading. Once the computer has run since the last measurement (the member
   * opened it to clean up), the reading may be stale: let the start through
   * and measure again while it runs.
   */
  function overQuota(row: BotComputerRow): boolean {
    if (row.disk_bytes === null || row.disk_bytes <= DISK_SOFT_LIMIT_BYTES) return false;
    if (!row.disk_measured_at) return false;
    if (row.last_started_at && Date.parse(row.last_started_at) > Date.parse(row.disk_measured_at)) return false;
    return true;
  }

  /** One attempt under the member's lock: running, start it, or report why not yet. */
  async function attemptStart(
    userId: string,
    env: ControllerEnvironment,
    opts: EnsureRunningOptions,
  ): Promise<Attempt> {
    // Under the lock, so ordered after a suspend / feature-off and its purge:
    // a Bot action already in flight cannot bring the computer back.
    const active = await deps.userIsActive(userId);
    if (active !== true) {
      throw new ComputerUnavailableError(
        'disabled',
        'Bots are not enabled for this account, so its computer cannot start',
      );
    }
    let row: BotComputerRow | undefined = await ensureRow(userId, env.config.namespace);
    if (row.state === 'running') return { kind: 'running', row };
    if (row.state === 'stopping' && ageMs(row.updated_at) < STALE_TRANSITION_MS) return { kind: 'wait' };
    if (row.state === 'stopping' || row.state === 'starting') {
      // A stop whose process died half-way, or a start (starts only happen
      // under the lock we now hold, so its starter died): settle it first.
      row = await settleDead(row);
      if (!row) return { kind: 'wait' };
    }

    // The Docker disk is nearly full: nobody's start goes through, not even a
    // member opening their own computer — that is the host's problem to fix.
    if (hostDiskRefusesStarts(env.hostDisk, clock.now())) {
      throw new ComputerUnavailableError(
        'over_quota',
        'The server is almost out of disk space, so computers cannot start right now. An administrator needs to free space.',
        'host_disk',
      );
    }

    if (!opts.allowOverQuota && overQuota(row)) {
      if (row.state_reason !== 'over_quota') {
        emitState(await store.transition(userId, row.version, ['absent', 'error'], { state_reason: 'over_quota' }));
      }
      throw new ComputerUnavailableError(
        'over_quota',
        'The computer is out of disk space. Open it from the Bots page and clear Downloads, or reset it.',
      );
    }

    // A reset's stop left this reason on the row; the claim below clears it, so it is read now: the
    // member asked for everything but their files to start over (e2b: a new sandbox around the home).
    const fresh = row.state_reason === 'reset';
    for (let round = 0; round < 3; round++) {
      const current: BotComputerRow = row;
      const decision = await capacityGate.run(() => store.withCapacityLock(() => claimSlot(current, env)));
      if (decision.kind === 'claimed') {
        emitState(decision.row);
        return { kind: 'running', row: await startContainer(decision.row, env, { fresh }) };
      }
      if (decision.kind === 'lost') return { kind: 'wait' };
      if (decision.kind === 'queued') return { kind: 'queued' };
      // Make room: stop the least recently used idle computer, then claim again.
      const stopStartedAt = clock.now();
      emitState(decision.victim);
      await finishStop(decision.victim, 'lru', stopStartedAt);
      const refreshed = await store.get(userId);
      if (!refreshed) return { kind: 'wait' };
      row = refreshed;
    }
    return { kind: 'queued' };
  }

  async function ensureRunning(userId: string, opts: EnsureRunningOptions = {}): Promise<BotComputerRow> {
    const existing = await store.get(userId);
    if (existing?.state === 'running') {
      await touchThrottled(userId);
      return existing;
    }
    return await ensureMutex.run(userId, async () => {
      const env = await deps.environment();
      const deadline = clock.now() + QUEUE_WAIT_MS;
      try {
        for (;;) {
          if (opts.signal?.aborted) throw abortError();
          const attempt = await startSlots.run(() => store.withUserLock(userId, () => attemptStart(userId, env, opts)));
          if (attempt.kind === 'running') {
            await touchThrottled(userId);
            return attempt.row;
          }
          if (clock.now() >= deadline) {
            throw new ComputerUnavailableError(
              'busy',
              'All computers on this server are busy right now. Try again in a minute.',
            );
          }
          if (attempt.kind === 'queued') {
            if (!waiters.includes(userId)) waiters.push(userId);
            opts.onQueued?.(waiters.indexOf(userId) + 1);
          }
          await clock.sleep(attempt.kind === 'queued' ? 2_000 : 1_000, opts.signal);
        }
      } finally {
        const index = waiters.indexOf(userId);
        if (index >= 0) waiters.splice(index, 1);
      }
    });
  }

  /**
   * Stop the member's computer; the caller holds the member's lock. A young `stopping` row belongs to a stop at work (an LRU eviction
   * runs under the requester's lock, not this member's) — unless `force`,
   * where finishing it here is safe: stop and remove are idempotent and the
   * row only moves by compare-and-set.
   */
  async function stopLocked(userId: string, reason: StopReason, opts: { force?: boolean } = {}): Promise<void> {
    const row = await store.get(userId);
    if (!row || row.state === 'absent') return;
    if (row.state === 'stopping' && !opts.force && ageMs(row.updated_at) < STALE_TRANSITION_MS) return;
    const startedAt = clock.now();
    const stopping = await store.transition(userId, row.version, ['running', 'starting', 'error', 'stopping'], {
      state: 'stopping',
      state_reason: reason,
    });
    if (!stopping) return;
    emitState(stopping);
    await finishStop(stopping, reason, startedAt);
  }

  /** Stop the member's computer (their files kept). Safe to call in any state. */
  async function stop(userId: string, reason: StopReason): Promise<void> {
    await store.withUserLock(userId, () => stopLocked(userId, reason));
  }

  /**
   * Remove the computer; `wipe` also deletes the home (files, logins) and the
   * row. One critical section under the member's lock: a start that was
   * waiting either ran before (its computer is removed here) or runs after the
   * row is gone (and gets a fresh row and a fresh, empty home).
   */
  async function purge(userId: string, opts: { wipe: boolean; reason?: StopReason }): Promise<void> {
    const reason = opts.reason ?? 'purge';
    await store.withUserLock(userId, async () => {
      await stopLocked(userId, reason, { force: opts.wipe });
      if (!opts.wipe) return;
      const row = await store.get(userId);
      if (!row) return;
      await host.wipe(row);
      await store.delete(userId);
      // A wiped home is never restored: its backups go with it (a member deleted while the host was down is swept).
      await deps.backups?.deleteAll(userId);
      logger.info('[bots-computer] wiped', { user_id: userId, container: row.container_name, host: host.kind });
    });
    lastTouch.delete(userId);
  }

  /** Rebuild from scratch: stop, optionally wipe the home, start again (current image and settings). */
  async function reset(userId: string, opts: { wipe: boolean }): Promise<BotComputerRow> {
    if (opts.wipe) await purge(userId, { wipe: true, reason: 'reset' });
    else await stop(userId, 'reset');
    return await ensureRunning(userId, { allowOverQuota: true });
  }

  /** An exec found the computer gone or stopped: mark the row so the next use rebuilds it. */
  async function markBroken(userId: string, reason: string): Promise<void> {
    const row = await store.get(userId);
    if (!row || row.state !== 'running') return;
    const broken = await store.transition(userId, row.version, ['running'], { state: 'error', state_reason: reason });
    if (!broken) return;
    await discardQuietly(row.container_name);
    lastTouch.delete(userId);
    logger.warn('[bots-computer] exited', { user_id: userId, container: row.container_name, reason });
    deps.onStopped?.(userId, reason);
    emitState(broken);
  }

  /**
   * Background jobs keep an otherwise idle computer awake, for at most
   * `jobMaxHours` after its last activity (a job that never ends must not
   * hold one of the organisation's few slots for ever). One exec, asked only
   * of a computer that is idle by every other measure, and outside the
   * member's lock (an exec is slow; the lock re-checks idleness anyway).
   *
   * An unanswered question is not an answer: a computer whose job list cannot
   * be read keeps running for the next few rounds rather than being stopped on
   * top of work in progress. It is only a reprieve — a computer that never
   * answers is stopped after `JOB_QUERY_GRACE` tries (and one that is really
   * gone is settled by the health loop, which asks the provider, not the
   * computer).
   */
  async function jobsKeepAwake(row: BotComputerRow, env: ControllerEnvironment): Promise<boolean> {
    const maxMs = env.config.jobMaxHours * 3_600_000;
    if (!deps.runningJobs || maxMs <= 0 || clock.now() - Date.parse(row.last_active_at) >= maxMs) {
      jobQueryFailures.delete(row.user_id);
      return false;
    }
    try {
      const running = (await deps.runningJobs(row.container_name)) > 0;
      jobQueryFailures.delete(row.user_id);
      return running;
    } catch (err) {
      const failures = (jobQueryFailures.get(row.user_id) ?? 0) + 1;
      jobQueryFailures.set(row.user_id, failures);
      logger.warn(
        `[bots-computer] could not read the background jobs of ${row.user_id} (${failures}/${JOB_QUERY_GRACE}): ${toErrorMessage(err)}`,
      );
      return failures < JOB_QUERY_GRACE;
    }
  }

  /**
   * A computer going to sleep is backed up first when its backup is due (backups.ts): it
   * stays awake while the backup runs, for at most BACKUP_DEFER_MS past its idle time.
   * Outside the member's lock, like the job query: a backup only reads the home. A
   * backup that cannot even be asked about never holds a computer awake.
   */
  async function backupKeepsAwake(row: BotComputerRow, env: ControllerEnvironment): Promise<boolean> {
    if (!deps.backups) return false;
    try {
      return (await deps.backups.beforeSleep(row, env.idleMinutes)) === 'wait';
    } catch (err) {
      logger.warn(`[bots-computer] backup check for ${row.user_id} failed: ${toErrorMessage(err)}`);
      return false;
    }
  }

  async function idleTick(): Promise<void> {
    const env = await deps.environment();
    const cutoff = iso(clock.now() - env.idleMinutes * 60_000);
    for (const candidate of await store.listIdle(cutoff)) {
      if (await jobsKeepAwake(candidate, env)) continue;
      if (await backupKeepsAwake(candidate, env)) continue;
      await store.withUserLock(candidate.user_id, async () => {
        // Re-check under the lock: a Bot or a viewer may have just used it.
        const row = await store.get(candidate.user_id);
        // Timestamps come back in Postgres' text format: compare instants, never strings.
        const cutoffMs = Date.parse(cutoff);
        if (
          !row ||
          row.state !== 'running' ||
          row.lease_controller !== 'bot' ||
          Date.parse(row.last_active_at) >= cutoffMs ||
          (row.viewer_heartbeat_at !== null && Date.parse(row.viewer_heartbeat_at) >= cutoffMs)
        ) {
          return;
        }
        // A Bot waits on the member (sign-in or take-over card): keep its page.
        if (await isAwaitingHuman(row.user_id)) return;
        const startedAt = clock.now();
        const stopping = await store.transition(row.user_id, row.version, ['running'], {
          state: 'stopping',
          state_reason: 'idle',
        });
        if (!stopping) return;
        emitState(stopping);
        await finishStop(stopping, 'idle', startedAt);
      });
    }
  }

  /**
   * Settle a transitional row whose worker died (a slot stopped mid-start or
   * mid-stop during a deploy): otherwise it holds a capacity slot forever.
   * `starting` — a free member lock proves the starter is gone (starts only
   * run under it); `stopping` — LRU stops run under the REQUESTER's lock, so
   * only age tells, as in attemptStart. Returns whether it settled the row.
   */
  async function settleIfDead(snapshot: BotComputerRow): Promise<boolean> {
    const age = ageMs(snapshot.updated_at);
    if (snapshot.state === 'stopping' && age < STALE_TRANSITION_MS) return false;
    if (snapshot.state === 'starting' && !store.tryWithUserLock && age < START_DEADLINE_MS) return false;
    const result = await withFreeUserLock(snapshot.user_id, async () => {
      const row = await store.get(snapshot.user_id);
      if (!row || row.version !== snapshot.version || row.state !== snapshot.state) return false;
      return (await settleDead(row)) !== undefined;
    });
    return result.acquired && result.value;
  }

  async function settleTransitional(): Promise<void> {
    for (const row of await store.listByStates(['starting', 'stopping'])) {
      try {
        await settleIfDead(row);
      } catch (err) {
        reportRuntime(err);
        logger.warn(`[bots-computer] could not settle ${row.user_id} (${row.state}): ${toErrorMessage(err)}`);
      }
    }
  }

  async function healthTick(): Promise<void> {
    const env = await deps.environment();
    await settleTransitional();
    // Rows first, then the listing: a row that is `running` now had a running
    // computer before the snapshot, so a missing one really died.
    const rows = await store.listByStates(['running']);
    if (rows.length === 0) return;
    let instances: HostInstance[];
    try {
      instances = await host.list(env.config.namespace);
    } catch (err) {
      reportRuntime(err);
      throw err;
    }
    const byRef = new Map(instances.map((i) => [i.ref, i]));
    // Keep the Docker disk reading fresh while computers run (one df, from
    // the first running computer; more often while it is low).
    if (host.sharedDisk) {
      const reading = env.hostDisk ?? null;
      const remeasureAfter =
        reading && reading.freeRatio < HOST_DISK_MIN_FREE_RATIO ? HOST_DISK_LOW_REMEASURE_MS : HOST_DISK_REMEASURE_MS;
      if (!reading || clock.now() - reading.measuredAt >= remeasureAfter) {
        const probe = rows.find((row) => byRef.get(row.container_name)?.running);
        if (probe) void measureHostDisk(probe);
      }
    }
    for (const row of rows) {
      const instance = byRef.get(row.container_name);
      if (instance?.running) {
        if (host.keepAlive) {
          void host.keepAlive(row, env.idleMinutes).catch((err: unknown) => {
            reportRuntime(err);
            logger.warn(`[bots-computer] keep-alive failed for ${row.user_id}: ${toErrorMessage(err)}`);
          });
        }
        // Over the soft limit: re-measure often, so a cleanup unblocks automatic starts.
        if (
          row.disk_bytes !== null &&
          row.disk_bytes > DISK_SOFT_LIMIT_BYTES &&
          ageMs(row.disk_measured_at) >= OVER_QUOTA_REMEASURE_MS
        ) {
          void measureDisk(row);
        }
        continue;
      }
      const verdict = await verdictFor(row.container_name, instance);
      const settled = await store.transition(row.user_id, row.version, ['running'], {
        state: verdict.state,
        state_reason: verdict.reason,
      });
      if (!settled) continue;
      if (instance) await discardQuietly(instance.ref);
      lastTouch.delete(row.user_id);
      if (verdict.state === 'error') {
        logger.warn(`[bots-computer] ${verdict.reason}`, { user_id: row.user_id, container: row.container_name });
      } else {
        logger.info('[bots-computer] went to sleep on its own', {
          user_id: row.user_id,
          container: row.container_name,
          reason: verdict.reason,
        });
      }
      deps.onStopped?.(row.user_id, verdict.reason);
      emitState(settled);
    }
  }

  /**
   * Clear what this namespace left behind: containers no row points at, rows
   * whose member may no longer use a computer, rows whose container is gone,
   * old orphan volumes. Runs at boot and whenever the host comes back. Every
   * per-member decision is made under that member's (free) lock on a fresh
   * read, and the row moves by compare-and-set BEFORE its container is
   * removed — so it can never kill another slot's start in progress.
   */
  async function reconcile(): Promise<void> {
    const env = await deps.environment();
    const namespace = env.config.namespace;
    const rows = await store.list();
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    const instances = await host.list(namespace);
    const byRef = new Map(instances.map((i) => [i.ref, i]));
    let removedContainers = 0;
    let settledRows = 0;

    // Computers no row points at (deleted member, crashed start under an old name).
    for (const instance of instances) {
      const userId = instance.userId;
      const snapshot = byUser.get(userId);
      if (snapshot && snapshot.container_name === instance.ref) continue;
      if (!userId) {
        if (await removeOrphanQuietly(instance, instances)) removedContainers++;
        continue;
      }
      const result = await withFreeUserLock(userId, async () => {
        const row = await store.get(userId);
        if (row && row.container_name === instance.ref) return false; // started meanwhile: it is theirs
        return await removeOrphanQuietly(instance, instances);
      });
      if (result.acquired && result.value) removedContainers++;
    }

    for (const snapshot of rows) {
      if (snapshot.state === 'absent') continue;
      const active = await deps.userIsActive(snapshot.user_id);
      if (active !== true) {
        await stop(snapshot.user_id, 'suspend');
        removedContainers++;
        continue;
      }
      if (snapshot.state === 'starting' || snapshot.state === 'stopping') {
        if (await settleIfDead(snapshot)) settledRows++;
        continue;
      }
      // Consistent in the snapshot: nothing to look at more closely.
      const seen = byRef.get(snapshot.container_name);
      if (snapshot.state === 'running' && seen?.running) continue;
      if (snapshot.state === 'error' && !seen) continue;
      // Without a try-lock, a row touched in the last minute may have its lock
      // held by a start at work; leave it to the next pass rather than wait.
      if (!store.tryWithUserLock && ageMs(snapshot.updated_at) < STALE_TRANSITION_MS) continue;
      const result = await withFreeUserLock(snapshot.user_id, async () => {
        const row = await store.get(snapshot.user_id);
        if (!row || row.version !== snapshot.version) return false;
        const state = await host.inspect(row.container_name);
        if (row.state === 'running' && state?.running) return false;
        if (row.state === 'error' && !state) return false;
        const verdict: StopVerdict =
          row.state === 'running'
            ? await verdictFor(
                row.container_name,
                state ? { ref: row.container_name, userId: row.user_id, running: false } : undefined,
              )
            : { state: 'error', reason: row.state_reason ?? 'interrupted' };
        const settled = await store.transition(row.user_id, row.version, [row.state], {
          state: row.state === 'error' ? 'error' : verdict.state === 'error' ? 'absent' : verdict.state,
          state_reason: verdict.reason,
        });
        if (!settled) return false;
        if (state) await discardQuietly(row.container_name);
        lastTouch.delete(row.user_id);
        if (row.state === 'running') deps.onStopped?.(row.user_id, verdict.reason);
        emitState(settled);
        return true;
      });
      if (result.acquired && result.value) settledRows++;
    }
    // Storage no row points at, after a grace period (docker: home volumes). A
    // member who still exists keeps their row (and so their files) even while
    // suspended; deleting the member cascades the row away, and the files follow.
    let removedVolumes = 0;
    try {
      removedVolumes = await host.sweepStorage(namespace, (userId) => store.get(userId));
    } catch (err) {
      reportRuntime(err);
      logger.warn(`[bots-computer] could not sweep orphan storage: ${toErrorMessage(err)}`);
    }
    if (removedContainers || removedVolumes || settledRows) {
      logger.info('[bots-computer] reconcile', {
        namespace,
        removed_containers: removedContainers,
        removed_volumes: removedVolumes,
        settled_rows: settledRows,
      });
    }
  }

  async function removeOrphanQuietly(instance: HostInstance, all: HostInstance[]): Promise<boolean> {
    try {
      return await host.removeOrphan(instance, all);
    } catch (err) {
      reportRuntime(err);
      logger.warn(`[bots-computer] could not remove orphan ${instance.ref}: ${toErrorMessage(err)}`);
      return false;
    }
  }

  /** In-flight measurements (a `du` can take minutes; never run two for one member). */
  const measuring = new Set<string>();
  let measuringHost = false;

  /**
   * Read the Docker disk's free space from inside a running computer: its
   * home is a named volume on that disk, so `df` on the home sees the disk's
   * own size and free space (as uid agent — it reads nothing but statfs).
   * Docker only: an e2b computer's disk is its own.
   */
  async function measureHostDisk(row: BotComputerRow): Promise<void> {
    if (measuringHost || !host.sharedDisk) return;
    measuringHost = true;
    try {
      const result = await host.exec({
        container: row.container_name,
        user: 'agent',
        argv: ['df', '-P', '-k', '/home/agent'],
        timeoutMs: 15_000,
        maxStdoutBytes: 4096,
      });
      const reading = result.code === 0 ? parseDfOutput(result.stdout.toString('utf8'), clock.now()) : null;
      if (!reading) {
        logger.warn('[bots-computer] could not read the Docker disk free space', { user_id: row.user_id });
        return;
      }
      if (reading.freeRatio < HOST_DISK_MIN_FREE_RATIO) {
        logger.warn('[bots-computer] the Docker disk is nearly full; new computers will not start', {
          free_percent: Math.floor(reading.freeRatio * 100),
          available_bytes: reading.availableBytes,
        });
      }
      deps.onHostDisk?.(reading);
    } catch (err) {
      reportRuntime(err);
      logger.warn(`[bots-computer] Docker disk measurement failed: ${toErrorMessage(err)}`);
    } finally {
      measuringHost = false;
    }
  }

  /**
   * Measure one running computer's home (both uids, each reading only its
   * own). No reason to clear afterwards: the start that made it `running`
   * already cleared any "disk full" reason, and the next automatic start
   * decides on this reading.
   */
  async function measureDisk(row: BotComputerRow): Promise<void> {
    if (measuring.has(row.user_id)) return;
    measuring.add(row.user_id);
    // The Docker disk first: one cheap df, before the du that can take minutes.
    await measureHostDisk(row);
    try {
      let total = 0;
      for (const [user, path] of [
        ['agent', '/home/agent'],
        ['browser', '/home/browser'],
      ] as const) {
        const result = await host.exec({
          container: row.container_name,
          user,
          argv: ['du', '-sxb', path],
          timeoutMs: 120_000,
          maxStdoutBytes: 4096,
        });
        const bytes = Number(/^(\d+)/.exec(result.stdout.toString('utf8'))?.[1] ?? NaN);
        if (Number.isFinite(bytes)) total += bytes;
      }
      await store.setDisk(row.user_id, total);
      if (total > DISK_SOFT_LIMIT_BYTES) {
        logger.warn('[bots-computer] over the soft disk limit', { user_id: row.user_id, disk_bytes: total });
      }
    } catch (err) {
      reportRuntime(err);
      // Stopped since the loop listed it: the next running start measures again.
      const gone = err instanceof ComputerDockerError && (err.code === 'not_running' || err.code === 'not_found');
      if (!gone) logger.warn(`[bots-computer] disk measurement failed for ${row.user_id}: ${toErrorMessage(err)}`);
    } finally {
      measuring.delete(row.user_id);
    }
  }

  /** Measure each running computer's home. */
  async function diskTick(): Promise<void> {
    for (const row of await store.listByStates(['running'])) await measureDisk(row);
  }

  return {
    ensureRunning,
    stop,
    purge,
    reset,
    markBroken,
    idleTick,
    healthTick,
    reconcile,
    diskTick,
    /** 1-based position among this process's waiting members; null when not waiting. */
    queuePosition(userId: string): number | null {
      const index = waiters.indexOf(userId);
      return index >= 0 ? index + 1 : null;
    },
  };
}

export type ComputerController = ReturnType<typeof createComputerController>;
