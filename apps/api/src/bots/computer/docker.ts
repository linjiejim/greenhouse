/**
 * Docker CLI access for Bot computers.
 *
 * Shells out to the `docker` binary like the Mission runner (cloud-agent/
 * docker.ts) but through `spawn`, not `execFile`: computers stream (VNC and
 * DevTools tunnels), move binary files and run Bot commands for minutes, so
 * neither a 15 s cap nor a 1 MB buffer fits. Every call has its own deadline
 * and output caps instead.
 *
 * Two error classes keep one member's broken computer from closing the feature
 * for everyone (review R12):
 * - ComputerRuntimeError — the host itself (no docker CLI, daemon down,
 *   runtime/image/network missing). The runtime goes `unavailable` and
 *   re-checks every 60 s.
 * - ComputerDockerError — one container (gone, not running, name conflict,
 *   timeout). Only that member's row is marked; the next use rebuilds it.
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md §6.3.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';

import { computerLabels } from './namespace.js';

/** safeJsonParse with the caller's expected shape (still validated field by field). */
function parseJson<T>(text: string): T | null {
  return safeJsonParse(text, null) as T | null;
}

// ─── docker run argv ──────────────────────────────────────

export interface ComputerRunSpec {
  name: string;
  namespace: string;
  userId: string;
  image: string;
  volume: string;
  network: string;
  runtime: string;
  memory: string;
  cpus: string;
  proxy: string | null;
  /** Extra Chromium URLBlocklist patterns (greenhouse's own origins). */
  urlBlocklist: string[];
  /** The member's own IANA zone, else the deployment default. */
  timezone: string;
  /** Browser language (BCP 47): the operator override, else the member's locale. */
  lang: string | null;
}

/**
 * Proxy variables the docker CLI copies from ~/.docker/config.json into every
 * container it creates. A developer proxy on 127.0.0.1 is unreachable from a
 * container, so an inherited value breaks every page; production must not
 * route the computer through an operator proxy by accident either. They are
 * always passed explicitly empty (review R3).
 */
export const CLEARED_PROXY_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

/**
 * The exact `docker run` argv of a computer. Pure so a unit test pins every
 * hardening flag: rootfs read-only, no capabilities, no new privileges, no
 * swap, bounded pids/shm/tmp/logs, an OOM score above the host's services,
 * the runtime and network always explicit, no published port, ever.
 */
export function buildComputerRunArgs(spec: ComputerRunSpec): string[] {
  const args = ['run', '-d', '--name', spec.name];
  for (const [key, value] of Object.entries(computerLabels(spec.namespace, spec.userId))) {
    args.push('--label', `${key}=${value}`);
  }
  args.push(
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512',
    '--memory',
    spec.memory,
    '--memory-swap',
    spec.memory,
    '--cpus',
    spec.cpus,
    '--shm-size',
    '1g',
    '--oom-score-adj',
    '500',
    '--tmpfs',
    // `exec`: Docker's default tmpfs is noexec, which breaks venvs and source
    // builds that run test programs from /tmp — while /home (a volume) runs
    // anything anyway, so noexec here protected nothing.
    '/tmp:rw,exec,nosuid,nodev,size=1g',
    '--log-driver',
    'local',
    '--log-opt',
    'max-size=10m',
    '--log-opt',
    'max-file=3',
    '--network',
    spec.network,
    '--runtime',
    spec.runtime,
    '-v',
    `${spec.volume}:/home`,
  );
  for (const key of CLEARED_PROXY_ENV) args.push('-e', `${key}=`);
  args.push(
    '-e',
    `GH_COMPUTER_PROXY=${spec.proxy ?? ''}`,
    '-e',
    `GH_COMPUTER_URL_BLOCKLIST=${spec.urlBlocklist.join(',')}`,
    '-e',
    `TZ=${spec.timezone}`,
  );
  if (spec.lang) args.push('-e', `GH_COMPUTER_LANG=${spec.lang}`);
  args.push(spec.image);
  return args;
}

// ─── Errors ───────────────────────────────────────────────

export type ComputerRuntimeReason =
  | 'docker_cli_missing'
  | 'docker_unreachable'
  | 'runtime_missing'
  | 'image_missing'
  | 'image_outdated'
  | 'network_invalid';

/** The Docker host cannot run computers at all (see the file header). */
export class ComputerRuntimeError extends Error {
  constructor(
    readonly reason: ComputerRuntimeReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ComputerRuntimeError';
  }
}

export type ComputerDockerErrorCode = 'not_found' | 'not_running' | 'conflict' | 'timeout' | 'too_large' | 'failed';

/** One container failed; never a reason to close the runtime. */
export class ComputerDockerError extends Error {
  constructor(
    readonly code: ComputerDockerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ComputerDockerError';
  }
}

/** Map a failed docker CLI call (its stderr) to the error class that owns it. */
export function classifyDockerFailure(stderr: string, what: string): ComputerRuntimeError | ComputerDockerError {
  const text = stderr.trim();
  const detail = `${what}: ${text.split('\n').slice(-3).join(' ').slice(0, 400) || 'docker failed'}`;
  if (
    /Cannot connect to the Docker daemon|permission denied while trying to connect|error during connect/i.test(text)
  ) {
    return new ComputerRuntimeError('docker_unreachable', detail);
  }
  if (/unknown or invalid runtime name|runtime .* not found|exec: "runsc"/i.test(text)) {
    return new ComputerRuntimeError('runtime_missing', detail);
  }
  if (/Unable to find image|No such image|pull access denied|manifest unknown/i.test(text)) {
    return new ComputerRuntimeError('image_missing', detail);
  }
  if (/network .* not found|No such network/i.test(text)) {
    return new ComputerRuntimeError('network_invalid', detail);
  }
  if (/No such container|No such object/i.test(text)) return new ComputerDockerError('not_found', detail);
  if (/is not running|is restarting|is paused/i.test(text)) return new ComputerDockerError('not_running', detail);
  if (/Conflict\. The container name|is already in use/i.test(text)) return new ComputerDockerError('conflict', detail);
  return new ComputerDockerError('failed', detail);
}

/** `spawn docker ENOENT` — the CLI is not installed (e.g. the compose API image). */
export function isDockerExecutableMissing(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    const e = current as { code?: unknown; cause?: unknown };
    if (e.code === 'ENOENT') return true;
    current = e.cause;
  }
  return false;
}

// ─── spawn ────────────────────────────────────────────────

export interface DockerSpawnOptions {
  /** Stdin: bytes, or a stream piped through (an upload); a stream that fails kills the CLI. */
  input?: Buffer | string | Readable;
  /** Kill the docker CLI after this long (default 60 s). */
  timeoutMs?: number;
  /** Captured stdout cap; the rest is drained and dropped (default 1 MiB). */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
}

export interface DockerSpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  stdoutTruncated: boolean;
  /** The CLI was killed at `timeoutMs`. */
  timedOut: boolean;
  /** The CLI was killed because `signal` aborted. */
  aborted: boolean;
}

export type DockerSpawner = (args: string[], options?: DockerSpawnOptions) => Promise<DockerSpawnResult>;

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run `docker <args>` to completion. Resolves with the exit status whatever it
 * is; rejects only when the CLI itself cannot be started (ENOENT →
 * ComputerRuntimeError('docker_cli_missing')).
 */
export const spawnDocker: DockerSpawner = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const maxStdout = options.maxStdoutBytes ?? 1024 * 1024;
    const maxStderr = options.maxStderrBytes ?? 64 * 1024;
    let child: ChildProcess;
    try {
      child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(toSpawnError(err));
      return;
    }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    child.stdout!.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= maxStdout) {
        stdoutTruncated = true;
        return;
      }
      const room = maxStdout - stdoutBytes;
      if (chunk.length > room) {
        stdout.push(chunk.subarray(0, room));
        stdoutBytes = maxStdout;
        stdoutTruncated = true;
      } else {
        stdout.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < maxStderr) stderr += chunk.toString('utf8').slice(0, maxStderr - stderr.length);
    });
    // A closed stdin (the process exited first) must not crash the API.
    child.stdin!.on('error', () => {});

    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(toSpawnError(err));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr,
        stdoutTruncated,
        timedOut,
        aborted,
      });
    });

    if (options.input instanceof Readable) {
      // The caller's stream broke (a client aborting an upload): stop the
      // command rather than let it take a short read for the whole input.
      options.input.once('error', kill);
      options.input.pipe(child.stdin!);
    } else if (options.input !== undefined) child.stdin!.end(options.input);
    else child.stdin!.end();
  });

function toSpawnError(err: unknown): Error {
  if (isDockerExecutableMissing(err)) {
    return new ComputerRuntimeError('docker_cli_missing', 'The docker CLI is not installed on the API host', {
      cause: err,
    });
  }
  return new ComputerRuntimeError('docker_unreachable', `Cannot run docker: ${toErrorMessage(err)}`, { cause: err });
}

/**
 * A long-lived `docker <args>` with piped stdio (tunnels). The caller owns the
 * process: it must kill it when its side closes. Errors (ENOENT) surface as the
 * child's 'error' event.
 */
export function spawnDockerStream(args: string[]): ChildProcess {
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin!.on('error', () => {});
  return child;
}

// ─── Parsers (pure, unit-tested) ──────────────────────────

/** `k=v,k2=v2` (docker ps/volume ls label column) → record. */
export function parseLabelColumn(value: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const part of (value ?? '').split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) labels[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return labels;
}

export interface ContainerSummary {
  id: string;
  name: string;
  /** created | running | paused | restarting | removing | exited | dead */
  state: string;
  status: string;
  labels: Record<string, string>;
}

/** `docker ps --format '{{json .}}'` output → summaries. */
export function parsePsOutput(stdout: string): ContainerSummary[] {
  const rows: ContainerSummary[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const row = parseJson<Record<string, string> | null>(line);
    if (!row) continue;
    rows.push({
      id: row.ID ?? '',
      name: (row.Names ?? '').split(',')[0] ?? '',
      state: (row.State ?? '').toLowerCase(),
      status: row.Status ?? '',
      labels: parseLabelColumn(row.Labels),
    });
  }
  return rows;
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** `123.4MiB / 2GiB` (docker stats MemUsage) → used bytes; null when unreadable. */
export function parseMemUsage(value: string): number | null {
  const match = /^\s*([\d.]+)\s*([a-z]+)/i.exec(value);
  if (!match) return null;
  const unit = SIZE_UNITS[match[2]!.toLowerCase()];
  if (!unit) return null;
  const bytes = Math.round(Number(match[1]) * unit);
  return Number.isFinite(bytes) ? bytes : null;
}

// ─── Client (the controller's narrow surface; tests fake it) ─

export interface ContainerState {
  running: boolean;
  status: string;
  exitCode: number;
  oomKilled: boolean;
}

export interface ImageInfo {
  id: string;
  labels: Record<string, string>;
  created: string;
}

export interface NetworkInfo {
  name: string;
  driver: string;
  ipv6: boolean;
  icc: boolean;
  internal: boolean;
  gateways: string[];
}

export interface VolumeSummary {
  name: string;
  labels: Record<string, string>;
}

export interface ExecSpec {
  container: string;
  user: 'agent' | 'browser';
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Attached as stdin (`docker exec -i`), bytes or a stream; omitted = no stdin. */
  input?: Buffer | Readable;
  timeoutMs: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
}

export interface DockerClient {
  /** Daemon version; throws ComputerRuntimeError when docker is missing or unreachable. */
  version(): Promise<string>;
  info(): Promise<{ memTotal: number | null; runtimes: string[] }>;
  imageInspect(image: string): Promise<ImageInfo | null>;
  networkInspect(name: string): Promise<NetworkInfo | null>;
  /** A bridge with inter-container traffic and IPv6 off. */
  networkCreate(name: string, labels: Record<string, string>): Promise<void>;
  volumeCreate(name: string, labels: Record<string, string>): Promise<void>;
  /** Idempotent. */
  volumeRemove(name: string): Promise<void>;
  volumeList(labelFilter: string): Promise<VolumeSummary[]>;
  /** Creation time of a volume (ISO), null when unknown or gone. */
  volumeCreatedAt(name: string): Promise<string | null>;
  run(args: string[]): Promise<string>;
  /** `docker stop -t <s>`; idempotent for a missing/stopped container. */
  stop(name: string, timeoutSec: number): Promise<void>;
  /** `docker rm -f`; idempotent. */
  remove(name: string): Promise<void>;
  inspectState(name: string): Promise<ContainerState | null>;
  /** One `docker ps -a` filtered by label. */
  ps(labelFilter: string): Promise<ContainerSummary[]>;
  /** One `docker stats --no-stream`: container name → memory bytes. */
  memoryUsage(names: string[]): Promise<Map<string, number>>;
  /** `docker exec`; resolves with the process status, throws only for docker-side failures. */
  exec(spec: ExecSpec): Promise<DockerSpawnResult>;
  /** A streaming `docker exec -i` (tunnels, file downloads). */
  execStream(
    container: string,
    user: 'agent' | 'browser',
    argv: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): ChildProcess;
}

function ensureOk(result: DockerSpawnResult, what: string): DockerSpawnResult {
  if (result.timedOut) throw new ComputerDockerError('timeout', `${what}: docker did not answer in time`);
  if (result.code !== 0) throw classifyDockerFailure(result.stderr, what);
  return result;
}

/**
 * A docker exec that LOOKS like it never reached the process: the docker CLI
 * writes its own error first, before any process output could exist. Only a
 * hint — stderr belongs to the process too (a Bot command, or a file path the
 * model chose being echoed back), so `exec` confirms with the daemon before it
 * believes it (see below).
 */
function looksLikeDaemonExecFailure(result: DockerSpawnResult): boolean {
  if (result.code === 0 || result.stdout.length !== 0) return false;
  const firstLine = result.stderr.trimStart().split('\n', 1)[0] ?? '';
  return (
    /^Error(?: response from daemon)?:/.test(firstLine) &&
    /No such container|is not running|is restarting|is paused|Cannot connect|permission denied while trying/i.test(
      firstLine,
    )
  );
}

export function createDockerClient(
  run: DockerSpawner = spawnDocker,
  stream: (args: string[]) => ChildProcess = spawnDockerStream,
): DockerClient {
  /**
   * Is a daemon-looking exec failure real? A process that prints
   * "Error: x is not running" must never get a healthy computer marked broken
   * (and removed): the container's actual state decides, and "cannot connect"
   * is only believed when the daemon is really unreachable.
   */
  async function confirmDaemonFailure(
    container: string,
    failure: ComputerRuntimeError | ComputerDockerError,
  ): Promise<ComputerRuntimeError | ComputerDockerError | null> {
    if (failure instanceof ComputerRuntimeError) {
      try {
        await client.version();
        return null;
      } catch {
        return failure;
      }
    }
    const state = await client.inspectState(container);
    if (!state) return new ComputerDockerError('not_found', failure.message);
    if (!state.running) return new ComputerDockerError('not_running', failure.message);
    return null;
  }

  const client: DockerClient = {
    async version() {
      const result = await run(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
      if (result.timedOut) throw new ComputerRuntimeError('docker_unreachable', 'docker version timed out');
      if (result.code !== 0) {
        throw new ComputerRuntimeError(
          'docker_unreachable',
          `Docker daemon is unreachable: ${result.stderr.trim().slice(0, 300) || `exit ${result.code}`}`,
        );
      }
      return result.stdout.toString('utf8').trim();
    },

    async info() {
      const result = ensureOk(
        await run(['info', '--format', '{"mem":{{json .MemTotal}},"runtimes":{{json .Runtimes}}}'], {
          timeoutMs: 15_000,
        }),
        'docker info',
      );
      const parsed = parseJson<{ mem?: unknown; runtimes?: Record<string, unknown> } | null>(
        result.stdout.toString('utf8'),
      );
      return {
        memTotal: typeof parsed?.mem === 'number' ? parsed.mem : null,
        runtimes: Object.keys(parsed?.runtimes ?? {}),
      };
    },

    async imageInspect(image) {
      const result = await run(
        [
          'image',
          'inspect',
          '--format',
          '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"created":{{json .Created}}}',
          image,
        ],
        { timeoutMs: 15_000 },
      );
      if (result.code !== 0) {
        if (/No such image|No such object/i.test(result.stderr)) return null;
        throw classifyDockerFailure(result.stderr, 'docker image inspect');
      }
      const parsed = parseJson<{ id?: string; labels?: Record<string, string> | null; created?: string } | null>(
        result.stdout.toString('utf8'),
      );
      if (!parsed?.id) return null;
      return { id: parsed.id, labels: parsed.labels ?? {}, created: parsed.created ?? '' };
    },

    async networkInspect(name) {
      const result = await run(['network', 'inspect', '--format', '{{json .}}', name], { timeoutMs: 15_000 });
      if (result.code !== 0) {
        if (/not found|No such network/i.test(result.stderr)) return null;
        throw classifyDockerFailure(result.stderr, 'docker network inspect');
      }
      const raw = parseJson<{
        Name?: string;
        Driver?: string;
        EnableIPv6?: boolean;
        Internal?: boolean;
        Options?: Record<string, string> | null;
        IPAM?: { Config?: Array<{ Gateway?: string }> | null };
      } | null>(result.stdout.toString('utf8'));
      if (!raw) return null;
      return {
        name: raw.Name ?? name,
        driver: raw.Driver ?? '',
        ipv6: raw.EnableIPv6 === true,
        // Docker's default for a new bridge is ICC on; only an explicit "false" turns it off.
        icc: raw.Options?.['com.docker.network.bridge.enable_icc'] !== 'false',
        internal: raw.Internal === true,
        gateways: (raw.IPAM?.Config ?? []).map((c) => c.Gateway ?? '').filter(Boolean),
      };
    },

    async networkCreate(name, labels) {
      const args = ['network', 'create', '--driver', 'bridge', '--opt', 'com.docker.network.bridge.enable_icc=false'];
      for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
      args.push(name);
      const result = await run(args, { timeoutMs: 30_000 });
      if (result.code !== 0 && !/already exists/i.test(result.stderr)) {
        throw new ComputerRuntimeError('network_invalid', `Cannot create network ${name}: ${result.stderr.trim()}`);
      }
    },

    async volumeCreate(name, labels) {
      const args = ['volume', 'create'];
      for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
      args.push(name);
      ensureOk(await run(args, { timeoutMs: 30_000 }), 'docker volume create');
    },

    async volumeRemove(name) {
      const result = await run(['volume', 'rm', '-f', name], { timeoutMs: 60_000 });
      if (result.code !== 0 && !/no such volume/i.test(result.stderr)) {
        throw classifyDockerFailure(result.stderr, 'docker volume rm');
      }
    },

    async volumeList(labelFilter) {
      const result = ensureOk(
        await run(['volume', 'ls', '--filter', `label=${labelFilter}`, '--format', '{{json .}}'], {
          timeoutMs: 30_000,
        }),
        'docker volume ls',
      );
      const volumes: VolumeSummary[] = [];
      for (const line of result.stdout.toString('utf8').split('\n')) {
        const row = parseJson<{ Name?: string; Labels?: string } | null>(line);
        if (row?.Name) volumes.push({ name: row.Name, labels: parseLabelColumn(row.Labels) });
      }
      return volumes;
    },

    async volumeCreatedAt(name) {
      const result = await run(['volume', 'inspect', '--format', '{{json .CreatedAt}}', name], { timeoutMs: 15_000 });
      if (result.code !== 0) return null;
      const value = parseJson<string | null>(result.stdout.toString('utf8'));
      return typeof value === 'string' && value ? value : null;
    },

    async run(args) {
      const result = ensureOk(await run(args, { timeoutMs: 90_000 }), 'docker run');
      return result.stdout.toString('utf8').trim();
    },

    async stop(name, timeoutSec) {
      const result = await run(['stop', '-t', String(timeoutSec), name], { timeoutMs: (timeoutSec + 30) * 1000 });
      if (result.code !== 0 && !/No such container/i.test(result.stderr)) {
        throw classifyDockerFailure(result.stderr, 'docker stop');
      }
    },

    async remove(name) {
      const result = await run(['rm', '-f', name], { timeoutMs: 60_000 });
      if (result.code !== 0 && !/No such container/i.test(result.stderr)) {
        throw classifyDockerFailure(result.stderr, 'docker rm');
      }
    },

    async inspectState(name) {
      const result = await run(
        [
          'inspect',
          '--type',
          'container',
          '--format',
          '{"running":{{json .State.Running}},"status":{{json .State.Status}},"exit":{{json .State.ExitCode}},"oom":{{json .State.OOMKilled}}}',
          name,
        ],
        { timeoutMs: 15_000 },
      );
      if (result.code !== 0) {
        if (/No such container|No such object/i.test(result.stderr)) return null;
        throw classifyDockerFailure(result.stderr, 'docker inspect');
      }
      const parsed = parseJson<{ running?: boolean; status?: string; exit?: number; oom?: boolean } | null>(
        result.stdout.toString('utf8'),
      );
      if (!parsed) return null;
      return {
        running: parsed.running === true,
        status: parsed.status ?? '',
        exitCode: typeof parsed.exit === 'number' ? parsed.exit : 0,
        oomKilled: parsed.oom === true,
      };
    },

    async ps(labelFilter) {
      const result = ensureOk(
        await run(['ps', '-a', '--no-trunc', '--filter', `label=${labelFilter}`, '--format', '{{json .}}'], {
          timeoutMs: 30_000,
        }),
        'docker ps',
      );
      return parsePsOutput(result.stdout.toString('utf8'));
    },

    async memoryUsage(names) {
      const usage = new Map<string, number>();
      if (names.length === 0) return usage;
      const result = await run(['stats', '--no-stream', '--format', '{{json .}}', ...names], { timeoutMs: 30_000 });
      // A container that stopped between ps and stats fails the whole call; the
      // admin page then just shows no memory figures.
      if (result.code !== 0 && result.stdout.length === 0) return usage;
      for (const line of result.stdout.toString('utf8').split('\n')) {
        const row = parseJson<{ Name?: string; MemUsage?: string } | null>(line);
        if (!row?.Name || !row.MemUsage) continue;
        const bytes = parseMemUsage(row.MemUsage);
        if (bytes !== null) usage.set(row.Name, bytes);
      }
      return usage;
    },

    async exec(spec) {
      const args = ['exec'];
      if (spec.input !== undefined) args.push('-i');
      args.push('-u', spec.user);
      if (spec.cwd) args.push('-w', spec.cwd);
      for (const [key, value] of Object.entries(spec.env ?? {})) args.push('-e', `${key}=${value}`);
      args.push(spec.container, ...spec.argv);
      const result = await run(args, {
        input: spec.input,
        timeoutMs: spec.timeoutMs,
        maxStdoutBytes: spec.maxStdoutBytes,
        maxStderrBytes: spec.maxStderrBytes,
        signal: spec.signal,
      });
      if (looksLikeDaemonExecFailure(result)) {
        const confirmed = await confirmDaemonFailure(
          spec.container,
          classifyDockerFailure(result.stderr, 'docker exec'),
        );
        if (confirmed) throw confirmed;
      }
      return result;
    },

    execStream(container, user, argv, opts = {}) {
      const args = ['exec', '-i', '-u', user];
      if (opts.cwd) args.push('-w', opts.cwd);
      for (const [key, value] of Object.entries(opts.env ?? {})) args.push('-e', `${key}=${value}`);
      return stream([...args, container, ...argv]);
    },
  };
  return client;
}
