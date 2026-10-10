/**
 * Long jobs on a member's computer — a thin client of the image's `gh-jobs`
 * (apps/bot-computer, image contract 2).
 *
 * A Bot's shell call is capped at 120 s, so anything longer (a build, a
 * download, a data run) runs as a job: detached in its own session, its
 * stdout+stderr in a log under ~/.local/state/gh-jobs/<id>/ (the persistent
 * home volume), its exit code recorded when it ends. Jobs survive a take-over
 * (gh-agent-kill spares their sessions) and keep the computer awake while they
 * run (controller idle tick, up to BOTS_COMPUTER_JOB_MAX_HOURS); they die with
 * the container, after which `gh-jobs list` reports them as `lost`.
 *
 * Everything runs as uid `agent` — the same sandbox as the Bot's shell and the
 * member's terminal. Listing never starts a computer; acting on a job needs a
 * running one (its process lives there). The command and name reach the
 * container as argv, never as a script.
 */

import { getDb } from '@greenhouse/db';
import type { ComputerProcessLog, ComputerProcessStatus, ComputerProcessView } from '@greenhouse/types/bots';
import { safeJsonParse } from '@greenhouse/utils/json';

import { ComputerDockerError } from './docker.js';
import type { ComputerExec } from './host.js';
import { ComputerUnavailableError } from './errors.js';
import { requireComputerRuntime } from './runtime.js';
import { agentEnv } from './shell.js';

export const JOB_ID = /^j[0-9a-f]{8}$/;
export const JOB_COMMAND_MAX = 20_000;
export const JOB_NAME_MAX = 60;
export const JOB_LOG_DEFAULT_LINES = 200;
export const JOB_LOG_MAX_LINES = 2_000;
const LOG_MAX_BYTES = 512 * 1024;
const STATUSES: ReadonlySet<string> = new Set<ComputerProcessStatus>(['running', 'exited', 'lost']);

/** A job id a caller (model or member) gave, or null when it is not one. */
export function parseJobId(raw: unknown): string | null {
  return typeof raw === 'string' && JOB_ID.test(raw.trim()) ? raw.trim() : null;
}

/** A short single-line label for a job; defaults to the command's first word. */
export function jobName(name: string | undefined, command: string): string {
  const clean = (value: string) =>
    value
      // eslint-disable-next-line no-control-regex -- control characters never belong in a label
      .replace(/[\x00-\x1f\x7f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const given = name ? clean(name) : '';
  const fallback = clean(command).split(' ')[0] || 'job';
  return (given || fallback).slice(0, JOB_NAME_MAX);
}

/** One `gh-jobs list` entry, validated field by field (the output comes from the container). */
export function toProcessView(raw: unknown): ComputerProcessView | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = parseJobId(row.id);
  const status =
    typeof row.status === 'string' && STATUSES.has(row.status) ? (row.status as ComputerProcessStatus) : null;
  if (!id || !status || typeof row.started_at !== 'string') return null;
  const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
  return {
    id,
    name: text(row.name, JOB_NAME_MAX) || id,
    command: text(row.command, JOB_COMMAND_MAX),
    cwd: text(row.cwd, 4096),
    status,
    exit_code: typeof row.exit_code === 'number' && Number.isInteger(row.exit_code) ? row.exit_code : null,
    started_at: row.started_at,
    ended_at: typeof row.ended_at === 'string' ? row.ended_at : null,
    log_bytes: typeof row.log_bytes === 'number' && row.log_bytes >= 0 ? Math.floor(row.log_bytes) : 0,
  };
}

/** Parse `gh-jobs list` output; anything unreadable is dropped, never thrown. */
export function parseJobList(stdout: string): ComputerProcessView[] {
  const parsed = safeJsonParse(stdout.trim() || '[]', null) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map(toProcessView).filter((job): job is ComputerProcessView => job !== null);
}

interface JobsDeps {
  host: () => Pick<ComputerExec, 'exec'>;
  /** BOTS_COMPUTER_PROXY: a job reaches the same internet as a Bot's shell call. */
  proxy?: () => string | null;
  /** The member's running container, or null when the computer is not running. */
  runningContainer: (userId: string) => Promise<string | null>;
}

const defaultDeps: JobsDeps = {
  host: () => requireComputerRuntime().host,
  proxy: () => requireComputerRuntime().config.proxy,
  runningContainer: async (userId) => {
    const row = await getDb().botComputers.get(userId);
    return row?.state === 'running' ? row.container_name : null;
  },
};

async function requireContainer(userId: string, deps: JobsDeps): Promise<string> {
  const container = await deps.runningContainer(userId);
  if (!container) throw new ComputerUnavailableError('stopped', 'The computer is not running');
  return container;
}

async function ghJobs(
  deps: Pick<JobsDeps, 'host' | 'proxy'>,
  container: string,
  args: string[],
  opts: { timeoutMs?: number; maxStdoutBytes?: number; signal?: AbortSignal } = {},
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  const result = await deps.host().exec({
    container,
    user: 'agent',
    cwd: '/home/agent',
    env: agentEnv(deps.proxy?.() ?? null),
    argv: ['gh-jobs', ...args],
    timeoutMs: opts.timeoutMs ?? 20_000,
    maxStdoutBytes: opts.maxStdoutBytes ?? 256 * 1024,
    maxStderrBytes: 16 * 1024,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return {
    code: result.code ?? -1,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.trim(),
    timedOut: result.timedOut,
  };
}

function failed(what: string, result: { code: number; stderr: string }): never {
  if (result.code === 3) throw new ComputerDockerError('not_found', result.stderr || `${what}: no such job`);
  throw new ComputerDockerError('failed', result.stderr || `${what} failed (exit ${result.code})`);
}

/** Start a detached job in ~/work (or `cwd`, which must be under /home/agent). */
export async function startJob(
  userId: string,
  input: { command: string; name?: string; cwd?: string },
  opts: { signal?: AbortSignal } = {},
  deps: JobsDeps = defaultDeps,
): Promise<{ id: string; name: string; pid: number; started_at: string }> {
  const command = input.command.trim();
  if (!command) throw new ComputerDockerError('failed', 'A job needs a command');
  if (command.length > JOB_COMMAND_MAX) throw new ComputerDockerError('too_large', 'The command is too long');
  const cwd = input.cwd ?? '/home/agent/work';
  if (cwd !== '/home/agent' && !cwd.startsWith('/home/agent/')) {
    throw new ComputerDockerError('failed', 'Jobs run inside /home/agent');
  }
  const container = await requireContainer(userId, deps);
  const name = jobName(input.name, command);
  const result = await ghJobs(deps, container, ['start', '--name', name, '--cwd', cwd, '--', command], opts);
  if (result.code !== 0) failed('Starting the job', result);
  const parsed = safeJsonParse(result.stdout.trim(), null) as Record<string, unknown> | null;
  const id = parseJobId(parsed?.id);
  if (!parsed || !id) throw new ComputerDockerError('failed', 'gh-jobs gave no job id');
  return {
    id,
    name: typeof parsed.name === 'string' ? parsed.name : name,
    pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
    started_at: typeof parsed.started_at === 'string' ? parsed.started_at : new Date().toISOString(),
  };
}

/** The member's jobs, newest first; empty when the computer is not running (never starts it). */
export async function listJobs(userId: string, deps: JobsDeps = defaultDeps): Promise<ComputerProcessView[]> {
  return (await listJobsIfRunning(userId, deps)) ?? [];
}

/** Like listJobs, but null when the computer is not running — "no jobs" and "could not look" differ. */
export async function listJobsIfRunning(
  userId: string,
  deps: JobsDeps = defaultDeps,
): Promise<ComputerProcessView[] | null> {
  const container = await deps.runningContainer(userId);
  if (!container) return null;
  const result = await ghJobs(deps, container, ['list']);
  if (result.code !== 0) failed('Listing jobs', result);
  return parseJobList(result.stdout);
}

/** The tail of a job's log (text; the caller redacts). */
export async function jobLog(
  userId: string,
  id: string,
  opts: { lines?: number; signal?: AbortSignal } = {},
  deps: JobsDeps = defaultDeps,
): Promise<ComputerProcessLog> {
  const jobId = parseJobId(id);
  if (!jobId) throw new ComputerDockerError('not_found', 'No such job');
  const lines = Math.min(Math.max(Math.floor(opts.lines ?? JOB_LOG_DEFAULT_LINES), 1), JOB_LOG_MAX_LINES);
  const container = await requireContainer(userId, deps);
  const result = await ghJobs(deps, container, ['log', jobId, '--lines', String(lines)], {
    maxStdoutBytes: LOG_MAX_BYTES,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (result.code !== 0) failed('Reading the log', result);
  const text = result.stdout;
  const returned = text.length === 0 ? 0 : text.replace(/\n$/, '').split('\n').length;
  return { id: jobId, text, truncated: returned >= lines || Buffer.byteLength(text) >= LOG_MAX_BYTES };
}

/** Stop a job (SIGTERM, then SIGKILL after 3 s). */
export async function stopJob(
  userId: string,
  id: string,
  deps: JobsDeps = defaultDeps,
): Promise<{ id: string; stopped: boolean }> {
  const jobId = parseJobId(id);
  if (!jobId) throw new ComputerDockerError('not_found', 'No such job');
  const container = await requireContainer(userId, deps);
  const result = await ghJobs(deps, container, ['stop', jobId], { timeoutMs: 15_000 });
  if (result.code !== 0) failed('Stopping the job', result);
  const parsed = safeJsonParse(result.stdout.trim(), null) as Record<string, unknown> | null;
  return { id: jobId, stopped: parsed?.stopped === true };
}

/**
 * Running jobs on a container (the idle tick's keep-awake check). An answer
 * that cannot be read (gh-jobs failed, garbage on stdout) counts as none, so a
 * broken image cannot keep computers awake. A computer that could not be
 * ASKED (the exec itself failed — unreachable, timed out) throws: that is no
 * answer at all, and the controller gives it a bounded reprieve rather than
 * stopping it on top of work in progress (controller.ts jobsKeepAwake).
 */
export async function runningJobCount(container: string, deps: Pick<JobsDeps, 'host'> = defaultDeps): Promise<number> {
  const result = await ghJobs({ host: deps.host }, container, ['running'], {
    timeoutMs: 10_000,
    maxStdoutBytes: 64,
  });
  // A computer too busy or too far away to answer a trivial question in 10 s did not answer.
  if (result.timedOut) throw new ComputerDockerError('failed', 'Asking for the running jobs timed out');
  const count = Number.parseInt(result.stdout.trim(), 10);
  return result.code === 0 && Number.isFinite(count) && count > 0 ? count : 0;
}

export type { JobsDeps };
