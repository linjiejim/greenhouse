/**
 * Where a member's computer runs — the seam between the lifecycle controller
 * (controller.ts: the DB state machine, capacity, idle, reconcile) and the
 * machine underneath. Two hosts (BOTS_COMPUTER_DRIVER):
 *
 * - docker (docker-host.ts): a container on the API's own Docker daemon,
 *   gVisor-hardened, reached through `docker exec`. The home is a named
 *   volume; a stop removes the container, every start is a fresh `docker run`.
 * - e2b (e2b-host.ts): a sandbox at an E2B-protocol provider (E2B abroad,
 *   PPIO in China), reached through the two bridges inside it (one per uid).
 *   The home lives in the sandbox; a stop is a pause (memory kept), a start a
 *   resume — or a new sandbox the home moves into when the template changed.
 *
 * Everything above the controller (shell, files, terminal, viewer, browser)
 * only sees the exec surface: commands as `agent` or `browser`, streams, and
 * the two tunnels (VNC, DevTools). `ExecSpec.container` is always the row's
 * `container_name`: the container (docker) or the sandbox id (e2b).
 */

import type { Readable, Writable } from 'node:stream';
import type { BotComputerRow } from '@greenhouse/db';

import type { BotsComputerConfig } from './config.js';

export type ComputerUser = 'agent' | 'browser';
export type ComputerHostKind = 'docker' | 'e2b';

// ─── Exec surface (every consumer) ────────────────────────

export interface ExecSpec {
  /** The row's `container_name` (docker container / e2b sandbox id). */
  container: string;
  user: ComputerUser;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Attached as stdin, bytes or a stream; omitted = no stdin. */
  input?: Buffer | Readable;
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
}

/** A finished command (docker: the `docker exec` client's exit; e2b: the process's, reported by the bridge). */
export interface ExecOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  stdoutTruncated: boolean;
  /** Killed at `timeoutMs`. */
  timedOut: boolean;
  /** Killed because `signal` aborted. */
  aborted: boolean;
}

/**
 * A long-lived process inside the computer, as its callers use it — the
 * subset of a ChildProcess the tunnels, the terminal and downloads touch (the
 * docker host hands out the real `docker exec` child).
 */
export interface ComputerProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  once(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (err: Error) => void): this;
}

export type ComputerTunnel = 'vnc' | 'cdp';

export interface ComputerExec {
  /** Run to completion; resolves with the process status, throws only for host-side failures. */
  exec(spec: ExecSpec): Promise<ExecOutcome>;
  /** A streaming process (terminal, file downloads); the caller kills it when its side closes. */
  execStream(
    container: string,
    user: ComputerUser,
    argv: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): ComputerProcess;
  /**
   * A raw byte tunnel to the browser's VNC or DevTools socket (uid `browser`
   * only). Ends like a process: 'exit' when either side closes.
   */
  openTunnel(container: string, target: ComputerTunnel): ComputerProcess;
  /**
   * A raw TCP connection to 127.0.0.1:`port` inside the computer, as uid `agent` (what its
   * shell can reach anyway) — a port preview (preview.ts). Callers check the port first
   * (previewPortAllowed). Ends like a process.
   */
  openPort(container: string, port: number): ComputerProcess;
}

// ─── Lifecycle (controller and runtime only) ──────────────

/** What one start needs besides the row. */
export interface ComputerStartSpec {
  config: BotsComputerConfig;
  /** The image (docker) / template (e2b) the prechecks found ready. */
  image: string | null;
  /** Chromium URLBlocklist patterns (greenhouse's own origins). */
  urlBlocklist: string[];
  /** The member's own IANA zone, else the deployment default. */
  timezone: string;
  /** Browser language (BCP 47). */
  lang: string;
  /**
   * The member reset the computer (keeping their files): everything but the
   * home starts over. Docker always does (a fresh container); e2b then moves
   * the home into a new sandbox instead of resuming the old one.
   */
  fresh: boolean;
  /**
   * The member had a computer before (backups.ts): called only when the host has to
   * make a home from nothing — e2b: the recorded sandbox is gone (deleted, another
   * provider); docker: no home volume (another driver before) — to fill it from the
   * newest backup before anything runs in it. Null = no backup to restore.
   */
  restore?: () => Promise<HomeRestore | null>;
}

/** A backup to put into a new home (backups.ts). */
export interface HomeRestore {
  backupId: string;
  /** ISO time the backup was taken. */
  takenAt: string;
  /** One uid's home, a verified gzip'd tar stream (home-archive.ts). */
  open(user: ComputerUser): Promise<Readable>;
}

/** A computer a start brought up (its browser may still be coming up). */
export interface StartedComputer {
  /** The row's `container_name` from now on (docker: unchanged; e2b: the sandbox it runs on). */
  ref: string;
  /** Recorded as `image_id` (docker: the image id; e2b: the template). */
  imageId: string | null;
  /** The backup this start put into a new home (ComputerStartSpec.restore), if it did. */
  restoredFrom?: string;
  /**
   * Undo the start: it lost to a newer decision (purge, reset) or never
   * became usable. Keeps the member's data — a sandbox created by this start
   * is only removed while the one it replaces still exists.
   */
  abandon(): Promise<void>;
}

/** One computer the host knows about in a namespace. */
export interface HostInstance {
  /** What a row's `container_name` points at. */
  ref: string;
  /** The member it belongs to ('' when the host cannot tell). */
  userId: string;
  running: boolean;
}

/**
 * A start that failed for this member's computer alone, with the reason the member is
 * shown (`state_reason`). Unlike ComputerRuntimeError it never takes the runtime down.
 */
export class ComputerStartError extends Error {
  constructor(
    /**
     * move_failed: the home could not be moved into a new sandbox; it is intact in the old one.
     * restore_failed: a backup could not be put into the new home; the next start tries again.
     * egress_open: the computer's egress rules were not in force (e2b-egress.ts); it is not used.
     */
    readonly reason: 'move_failed' | 'restore_failed' | 'egress_open',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ComputerStartError';
  }
}

/** Why a computer whose row says `running` is not. */
export interface StopVerdict {
  /** `error` = it died (shown as a fault); `absent` = it went to sleep on its own. */
  state: 'error' | 'absent';
  reason: string;
}

export interface ComputerHost extends ComputerExec {
  readonly kind: ComputerHostKind;
  /**
   * Whether every computer's home lives on one disk the hosts share (docker:
   * the daemon's disk, guarded by the host-disk check); false when each
   * computer has its own (e2b).
   */
  readonly sharedDisk: boolean;

  /** Bring the member's computer up (fresh container / resume or new sandbox). */
  start(row: BotComputerRow, spec: ComputerStartSpec): Promise<StartedComputer>;
  /** Stop it, keeping the member's files (docker: stop + remove the container; e2b: pause). */
  stop(ref: string): Promise<void>;
  /** Like `stop`, without the grace period (a broken or interrupted computer). */
  discard(ref: string): Promise<void>;
  /** Delete the computer and the member's files. */
  wipe(row: BotComputerRow): Promise<void>;

  /** Everything this namespace has on the host (one call). */
  list(namespace: string): Promise<HostInstance[]>;
  /** One computer's state; null when the host has no such computer. */
  inspect(ref: string): Promise<{ running: boolean } | null>;
  /** Why a computer whose row says `running` is not (`instance` from the same `list`). */
  verdict(ref: string, instance: HostInstance | undefined): Promise<StopVerdict>;
  /**
   * Remove a computer no row points at. The caller holds that member's lock
   * and has re-read the row; `all` is the namespace's full listing (an e2b
   * sandbox replaced by a newer one is kept a few days). Returns whether it
   * removed anything.
   */
  removeOrphan(instance: HostInstance, all: HostInstance[]): Promise<boolean>;
  /**
   * Storage no row points at (docker: home volumes past a grace period).
   * `owner(userId)` re-reads the row right before a removal.
   */
  sweepStorage(namespace: string, owner: (userId: string) => Promise<BotComputerRow | undefined>): Promise<number>;
  /** Called by the health loop for every running computer (e2b: renews the provider's timeout). */
  keepAlive?(row: BotComputerRow, idleMinutes: number): Promise<void>;
  /** Memory in use per ref (the admin page); missing = unknown. */
  memoryUsage(refs: string[]): Promise<Map<string, number>>;
  /**
   * One uid's home out of a running computer, as a gzip'd tar on stdout (a backup:
   * home-archive.ts, caches left out). The caller reads it and checks the exit code.
   */
  exportHome(ref: string, user: ComputerUser): ComputerProcess;
}
