/**
 * Commands inside a computer: `<exec as user, in cwd> timeout -k 5 <s> setsid
 * bash -lc <cmd>` (docker exec, or the e2b bridge), with output caps and a real
 * kill on abort.
 *
 * Why every piece is there (review R2):
 * - The deadline lives INSIDE the container (`timeout`), so it holds even if
 *   the API process dies mid-command.
 * - Killing the local `docker exec` client does not stop the process in the
 *   container. `setsid` gives the command its own session; its first output
 *   line reports the session id, and an abort (Stop, take-over, timeout) runs a
 *   follow-up exec that kills the whole session — plus every process still
 *   carrying this call's GH_EXEC_ID, which also catches children that
 *   escaped into a session of their own, or a command aborted before it could
 *   report its sid.
 * - `ulimit -f` bounds any single file a command writes (the home volume has
 *   no hard quota, D16).
 * - Proxy variables are always explicit: empty, or BOTS_COMPUTER_PROXY.
 */

import { randomBytes } from 'node:crypto';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

import { CLEARED_PROXY_ENV } from './docker.js';
import type { ComputerExec, ExecOutcome } from './host.js';

/** Largest single file a Bot command may write: 2 GiB (bash `ulimit -f` counts KiB). */
const MAX_FILE_KIB = 2 * 1024 * 1024;
const SID_MARKER = '__GH_SID__=';
/** Grace past the in-container deadline before the API gives up on the docker client. */
const CLIENT_GRACE_MS = 15_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;

export interface ShellOptions {
  user: 'agent' | 'browser';
  timeoutSec: number;
  signal?: AbortSignal;
  cwd?: string;
  stdin?: Buffer;
  maxOutputBytes?: number;
  proxy: string | null;
}

export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

function homeOf(user: 'agent' | 'browser'): string {
  return user === 'agent' ? '/home/agent' : '/home/browser';
}

/** The exec env: identity of the uid (the image sets HOME for `browser`), proxies, and the call's kill tag. */
export function shellEnv(user: 'agent' | 'browser', execId: string, proxy: string | null): Record<string, string> {
  const env: Record<string, string> = {
    HOME: homeOf(user),
    USER: user,
    LOGNAME: user,
    GH_EXEC_ID: execId,
  };
  for (const key of CLEARED_PROXY_ENV) env[key] = '';
  if (proxy) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      env[key] = proxy;
    }
    env.NO_PROXY = 'localhost,127.0.0.1,::1';
    env.no_proxy = env.NO_PROXY;
  }
  return env;
}

/**
 * The env of everything else that runs as uid `agent` — the member's terminal
 * and long jobs: the identity and proxies of a Bot's shell call (without its
 * kill tag), so the three reach the same internet.
 */
export function agentEnv(proxy: string | null): Record<string, string> {
  const { GH_EXEC_ID: _killTag, ...env } = shellEnv('agent', '', proxy);
  return env;
}

/** argv after `docker exec … <container>`. The command is one argument — never interpolated. */
export function shellArgv(command: string, timeoutSec: number): string[] {
  const seconds = Math.max(1, Math.ceil(timeoutSec));
  const script = `printf '${SID_MARKER}%s\\n' "$$"; ulimit -f ${MAX_FILE_KIB}; ${command}`;
  return ['timeout', '-k', '5', String(seconds), 'setsid', 'bash', '-lc', script];
}

/**
 * Kill what one call left behind: its session (when known) and every process
 * whose environment still carries its GH_EXEC_ID. Runs as the same uid.
 */
export const KILL_SCRIPT = [
  'id="$1"; sid="$2"',
  'if [ -n "$sid" ]; then pkill -KILL -s "$sid" 2>/dev/null; fi',
  'for f in /proc/[0-9]*/environ; do',
  // Other uids' environ files are unreadable to us (and none of our business).
  '  [ -r "$f" ] || continue',
  '  if tr "\\000" "\\n" <"$f" 2>/dev/null | grep -qx "GH_EXEC_ID=$id"; then',
  '    p="${f#/proc/}"; kill -KILL "${p%/environ}" 2>/dev/null',
  '  fi',
  'done',
  'exit 0',
].join('\n');

/** Strip the sid line the prelude prints (a login shell may print before it). */
export function splitSidLine(stdout: string): { sid: string | null; rest: string } {
  const match = new RegExp(`(?:^|\\n)(${SID_MARKER}(\\d+)\\n)`).exec(stdout.slice(0, 8192));
  if (!match) return { sid: null, rest: stdout };
  const line = match[1]!;
  const lineStart = match.index + match[0].length - line.length;
  return { sid: match[2]!, rest: stdout.slice(0, lineStart) + stdout.slice(lineStart + line.length) };
}

export async function killExecSession(
  docker: Pick<ComputerExec, 'exec'>,
  container: string,
  user: 'agent' | 'browser',
  execId: string,
  sid: string | null,
): Promise<void> {
  try {
    await docker.exec({
      container,
      user,
      argv: ['sh', '-c', KILL_SCRIPT, 'gh-kill', execId, sid ?? ''],
      timeoutMs: 20_000,
      maxStdoutBytes: 1024,
    });
  } catch (err) {
    // The container may be gone already (that kills everything anyway).
    logger.warn(`[bots-computer] could not clean up an aborted command: ${toErrorMessage(err)}`);
  }
}

/** Run a shell command in `container`; see the file header. */
export async function runShell(
  docker: Pick<ComputerExec, 'exec'>,
  container: string,
  command: string,
  options: ShellOptions,
): Promise<ShellResult> {
  const execId = randomBytes(12).toString('hex');
  const startedAt = Date.now();
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  let result: ExecOutcome;
  try {
    result = await docker.exec({
      container,
      user: options.user,
      cwd: options.cwd ?? homeOf(options.user),
      env: shellEnv(options.user, execId, options.proxy),
      argv: shellArgv(command, options.timeoutSec),
      input: options.stdin,
      timeoutMs: options.timeoutSec * 1000 + CLIENT_GRACE_MS,
      // The sid line rides on stdout; leave it room so it never counts against the caller.
      maxStdoutBytes: maxOutput + 64,
      maxStderrBytes: maxOutput,
      signal: options.signal,
    });
  } catch (err) {
    if (options.signal?.aborted) await killExecSession(docker, container, options.user, execId, null);
    throw err;
  }

  const { sid, rest } = splitSidLine(result.stdout.toString('utf8'));
  const elapsedMs = Date.now() - startedAt;
  // timeout(1) exits 124 when the deadline hit, 137 when it had to SIGKILL.
  const timedOut =
    result.timedOut || result.code === 124 || (result.code === 137 && elapsedMs >= options.timeoutSec * 1000);
  if (result.aborted || timedOut) {
    // timeout(1) only signals its direct child; anything the command forked
    // (`cmd &`, pipelines in subshells) would outlive it.
    await killExecSession(docker, container, options.user, execId, sid);
  }

  let stdout = rest;
  let stderr = result.stderr;
  let truncated = result.stdoutTruncated || Buffer.byteLength(stderr) >= maxOutput;
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutput) {
    truncated = true;
    const stdoutBudget = Math.max(maxOutput - Math.min(Buffer.byteLength(stderr), maxOutput / 2), 0);
    stdout = Buffer.from(stdout).subarray(0, stdoutBudget).toString('utf8');
    stderr = Buffer.from(stderr)
      .subarray(0, maxOutput - Buffer.byteLength(stdout))
      .toString('utf8');
  }
  return {
    exitCode: result.aborted || result.timedOut ? null : result.code,
    stdout,
    stderr,
    truncated,
    timedOut,
  };
}
