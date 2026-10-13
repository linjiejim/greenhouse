/**
 * Commands through envd, the provider's agent inside every E2B sandbox: its process API over the
 * Connect protocol with JSON messages, plain fetch. The adapter uses it only as root, for what
 * runs before or around the member's processes (the network rules, the boot script, a restart)
 * and for `exec` as root; the member's commands, terminal, screen and DevTools go through the
 * bridges (bridge.ts).
 *
 * Start is a server stream of enveloped messages (one flag byte, a 32-bit big-endian length,
 * JSON): start {pid}, data {stdout|stderr base64}, end {exitCode, status}, keepalive; then an
 * end-of-stream envelope (flag 2) that may carry an error. envd ends the process at the
 * `Connect-Timeout-Ms` deadline on its own, which backs the `timeout` the caller wraps around argv.
 */

import { ProviderRequestError, redact } from '../../http.js';
import { EndpointViolation } from '../../pinned-fetch.js';
import type { ExecResult } from '../../types.js';

export const ENVD_PORT = 49983;
/** An envelope larger than this is not one envd sends. */
const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;
const FLAG_COMPRESSED = 0x01;
const FLAG_END_STREAM = 0x02;
/** After the caller's deadline, how long envd and the network get before the request is cut. */
const DEADLINE_GRACE_MS = 10_000;
const SIGNAL_TIMEOUT_MS = 10_000;

/** Exit statuses Go reports for a process ended by a signal, as `128 + n` (what docker exec says). */
const SIGNALS: Record<string, number> = {
  hangup: 1,
  interrupt: 2,
  quit: 3,
  aborted: 6,
  killed: 9,
  'segmentation fault': 11,
  'broken pipe': 13,
  terminated: 15,
};

export interface EnvdTarget {
  /** https://49983-<id>.<domain> */
  origin: string;
  sandboxId: string;
  accessToken?: string;
}

export interface EnvdCommand {
  argv: string[];
  user: string;
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

interface ProcessEvent {
  start?: { pid?: number };
  data?: { stdout?: string; stderr?: string; pty?: string };
  end?: { exitCode?: number; exited?: boolean; status?: string; error?: string };
  keepalive?: Record<string, never>;
}

/** One Connect envelope around a JSON message. */
export function envelope(message: unknown, flags = 0): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(5);
  head.writeUInt8(flags, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** Cuts a byte stream into Connect envelopes. */
export class EnvelopeReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Array<{ flags: number; data: Buffer }> {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const out: Array<{ flags: number; data: Buffer }> = [];
    while (this.buffer.length >= 5) {
      const length = this.buffer.readUInt32BE(1);
      if (length > MAX_ENVELOPE_BYTES) throw new Error('The computer sent a message that is too large.');
      if (this.buffer.length < 5 + length) break;
      out.push({ flags: this.buffer[0]!, data: this.buffer.subarray(5, 5 + length) });
      this.buffer = this.buffer.subarray(5 + length);
    }
    return out;
  }

  get pending(): number {
    return this.buffer.length;
  }
}

/** The exit code of an end event: its own, or `128 + n` for a process a signal ended. */
export function exitCodeOf(end: NonNullable<ProcessEvent['end']>): number {
  const code = end.exitCode ?? 0;
  if (code !== -1) return code;
  const signal = /signal: (.+)$/
    .exec(end.status ?? '')?.[1]
    ?.trim()
    .toLowerCase();
  return signal && SIGNALS[signal] ? 128 + SIGNALS[signal] : -1;
}

function headers(target: EnvdTarget, extra: Record<string, string>): Record<string, string> {
  return {
    'Connect-Protocol-Version': '1',
    'E2b-Sandbox-Id': target.sandboxId,
    'E2b-Sandbox-Port': String(ENVD_PORT),
    ...(target.accessToken ? { 'X-Access-Token': target.accessToken } : {}),
    ...extra,
  };
}

/** Tells envd to kill a process; best effort, as the request that started it may be gone. */
async function kill(fetchImpl: typeof fetch, target: EnvdTarget, pid: number): Promise<void> {
  try {
    const response = await fetchImpl(`${target.origin}/process.Process/SendSignal`, {
      method: 'POST',
      headers: headers(target, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ process: { pid }, signal: 'SIGNAL_SIGKILL' }),
      signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // The process ends at its deadline anyway.
  }
}

function failure(message: string, secrets: readonly string[], statusCode?: number): ProviderRequestError {
  return new ProviderRequestError(redact(message, secrets), statusCode);
}

/**
 * Runs argv to its end as `user`. Output past the cap is read and dropped; at the deadline the
 * request is cut and the process killed (`timedOut`, exit -1). Throws when envd could not be
 * reached or the stream broke before the process ended.
 */
export async function envdRun(
  fetchImpl: typeof fetch,
  target: EnvdTarget,
  command: EnvdCommand,
  secrets: readonly string[] = [],
): Promise<ExecResult> {
  const [cmd, ...args] = command.argv;
  if (!cmd) throw new Error('A command needs at least one word.');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, command.timeoutMs);
  const known = [...secrets, target.accessToken ?? ''];
  let pid: number | null = null;
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const sizes = { out: 0, err: 0 };
  const keep = (into: Buffer[], key: 'out' | 'err', chunk: Buffer) => {
    if (sizes[key] < command.maxOutputBytes) into.push(chunk.subarray(0, command.maxOutputBytes - sizes[key]));
    sizes[key] += chunk.length;
  };
  const result = (exitCode: number): ExecResult => ({
    exitCode,
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
    timedOut,
  });
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${target.origin}/process.Process/Start`, {
        method: 'POST',
        headers: headers(target, {
          'Content-Type': 'application/connect+json',
          'Connect-Timeout-Ms': String(command.timeoutMs + DEADLINE_GRACE_MS),
          'Keepalive-Ping-Interval': '30',
          Authorization: `Basic ${Buffer.from(`${command.user}:`).toString('base64')}`,
        }),
        body: new Uint8Array(
          envelope({
            process: { cmd, args, envs: command.envs ?? {}, ...(command.cwd ? { cwd: command.cwd } : {}) },
          }),
        ),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) return result(-1);
      if (error instanceof EndpointViolation) throw error;
      const reason = (error as { cause?: { code?: unknown } }).cause?.code ?? (error as Error).message;
      throw failure(`The computer could not be reached (${String(reason)}).`, known);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
      throw failure(
        `The computer refused the command (HTTP ${response.status})${detail ? `: ${detail}` : ''}.`,
        known,
        response.status,
      );
    }
    if (!response.body) throw failure('The computer answered without a body.', known);
    const reader = new EnvelopeReader();
    const stream = response.body.getReader();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await stream.read();
      } catch (error) {
        if (timedOut) break;
        throw failure(`The connection to the computer broke: ${(error as Error).message}`, known);
      }
      if (chunk.done) break;
      for (const { flags, data } of reader.push(chunk.value)) {
        if (flags & FLAG_COMPRESSED) throw failure('The computer sent a compressed message.', known);
        const message = JSON.parse(data.toString('utf8') || '{}') as {
          event?: ProcessEvent;
          error?: { code?: string; message?: string };
        };
        if (flags & FLAG_END_STREAM) {
          if (message.error && !timedOut) {
            const why = [message.error.code, message.error.message].filter(Boolean).join(': ');
            throw failure(`The command could not run in the computer (${why}).`, known);
          }
          continue;
        }
        const event = message.event ?? {};
        if (event.start?.pid !== undefined) pid = event.start.pid;
        if (event.data?.stdout) keep(out, 'out', Buffer.from(event.data.stdout, 'base64'));
        if (event.data?.stderr) keep(err, 'err', Buffer.from(event.data.stderr, 'base64'));
        if (event.end) {
          await stream.cancel().catch(() => undefined);
          return result(exitCodeOf(event.end));
        }
      }
    }
    if (timedOut) {
      if (pid !== null) void kill(fetchImpl, target, pid);
      return result(-1);
    }
    throw failure('The connection to the computer ended before the command did.', known);
  } finally {
    clearTimeout(timer);
  }
}
