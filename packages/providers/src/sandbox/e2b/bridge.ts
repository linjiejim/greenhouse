/**
 * The API side of gh-bridge (apps/bot-computer/e2b/gh-bridge.mjs, ported from v1): a hosted
 * computer's commands, streams and tunnels over one WebSocket each, shaped like the
 * SandboxStream a `docker exec` gives, so the terminal, the screen, DevTools and file transfers
 * need no second code path.
 *
 * Two bridges run in every computer under systemd: as `browser` on port 7681 (the VNC and
 * DevTools sockets, /vnc and /cdp) and as `agent` on 7682 (/exec). Every connection carries the
 * provider's traffic token, without which its edge refuses the port, and the account's bridge
 * secret, without which the bridge refuses the upgrade before it opens or spawns anything.
 *
 * /exec: the first message is text {"argv","cwd","env"}; binary messages are stdin, text
 * {"t":"eof"} closes it and {"t":"kill"} signals the process; back come binary messages with a
 * channel byte (1 stdout, 2 stderr) and, once the process ended and its output was sent, text
 * {"t":"exit","code","signal"}. Tunnels are raw bytes both ways.
 *
 * Backpressure goes both ways: a reader that pauses `output` pauses the socket, a full socket
 * holds back the input.
 */

import { constants as osConstants } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import WebSocket from 'ws';
import type { ExecResult, SandboxStream } from '../../types.js';

const CHANNEL_STDOUT = 1;
const CHANNEL_STDERR = 2;
/** Input frames are cut to this size. */
const INPUT_CHUNK = 1024 * 1024;
/** Stop taking input while this much waits in the socket. */
const INPUT_HIGH_WATER = 4 * 1024 * 1024;
/** DevTools messages carry screenshots and uploads; the bridge accepts the same. */
export const MAX_PAYLOAD = 256 * 1024 * 1024;
export const CONNECT_TIMEOUT_MS = 20_000;
const PING_MS = 20_000;
/** A killed process whose bridge never confirms it is cut off after this long. */
const KILL_GRACE_MS = 5_000;

/** Where one bridge answers and what it takes to get in. */
export interface BridgeTarget {
  /** wss://<port>-<id>.<domain> (no path). */
  url: string;
  headers: Record<string, string>;
}

/** Opens a WebSocket; tests point it at a local bridge. */
export type Connector = (url: string, headers: Record<string, string>) => WebSocket;

export const connectWebSocket: Connector = (url, headers) =>
  new WebSocket(url, {
    headers,
    perMessageDeflate: false,
    maxPayload: MAX_PAYLOAD,
    handshakeTimeout: CONNECT_TIMEOUT_MS,
    followRedirects: false,
  });

/** A connection the bridge, or the provider's edge in front of it, refused or dropped. */
export class BridgeError extends Error {
  constructor(
    message: string,
    /** HTTP status of a refused upgrade: 403 is a secret or a token that no longer fits. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export type BridgeMode =
  | { kind: 'exec'; argv: string[]; cwd?: string; env?: Record<string, string> }
  | { kind: 'tunnel'; path: '/vnc' | '/cdp' };

/** `128 + n` for a process a signal ended, as `docker exec` reports it. */
function codeOf(code: unknown, signal: unknown): number | null {
  if (typeof code === 'number') return code;
  const number = typeof signal === 'string' ? (osConstants.signals as Record<string, number>)[signal] : undefined;
  return number ? 128 + number : null;
}

/** One bridge connection as a SandboxStream. */
export class BridgeStream implements SandboxStream {
  readonly input: Writable;
  readonly output = new PassThrough();
  readonly errors = new PassThrough();
  readonly exited: Promise<number | null>;
  /** Why the connection failed, when it did before the process reported its exit. */
  failure: BridgeError | null = null;
  /** Whether the bridge reported the process's exit (false: the connection ended first). */
  exitReported = false;
  private resolveExit!: (code: number | null) => void;
  private ws: WebSocket | null = null;
  private ended = false;
  private killed = false;
  private killRequested = false;
  private exitCode: number | null = null;
  private ping: NodeJS.Timeout | null = null;
  private waiting: Array<() => void> = [];
  /** Readers that fell behind; the socket reads again once every one has drained. */
  private behind = new Set<PassThrough>();

  constructor(
    target: Promise<BridgeTarget>,
    private readonly mode: BridgeMode,
    private readonly connect: Connector,
  ) {
    this.exited = new Promise((resolve) => (this.resolveExit = resolve));
    this.input = new Writable({
      write: (chunk: Buffer, _encoding, callback) => this.whenOpen(() => this.sendInput(chunk, callback), callback),
      final: (callback) => {
        this.whenOpen(() => this.endInput());
        callback();
      },
    });
    // Writing to a stream that already ended is the writer's problem, never a crash.
    this.input.on('error', () => undefined);
    target.then(
      (resolved) => this.open(resolved),
      (error: unknown) => this.fail(error instanceof BridgeError ? error : new BridgeError(messageOf(error))),
    );
  }

  kill(): void {
    if (this.ended) return;
    this.killed = true;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CONNECTING) {
      this.killRequested = true;
      if (!ws) this.finish();
      return;
    }
    this.hangUp(ws);
  }

  private hangUp(ws: WebSocket) {
    if (this.mode.kind === 'tunnel' || ws.readyState !== WebSocket.OPEN) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify({ t: 'kill', signal: 'SIGKILL' }));
    // The bridge answers with the exit; a bridge that is gone never would.
    setTimeout(() => ws.terminate(), KILL_GRACE_MS).unref();
  }

  private open(target: BridgeTarget) {
    if (this.ended) return;
    const path = this.mode.kind === 'exec' ? '/exec' : this.mode.path;
    let ws: WebSocket;
    try {
      ws = this.connect(`${target.url}${path}`, target.headers);
    } catch (error) {
      this.fail(error instanceof BridgeError ? error : new BridgeError(messageOf(error)));
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      if (this.mode.kind === 'exec') {
        const { argv, cwd, env } = this.mode;
        ws.send(JSON.stringify({ argv, ...(cwd ? { cwd } : {}), env: env ?? {} }));
      }
      if (this.killRequested) this.hangUp(ws);
      const waiting = this.waiting;
      this.waiting = [];
      for (const run of waiting) run();
    });
    ws.on('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? null;
      this.fail(new BridgeError(`The computer refused the connection (HTTP ${status})`, status));
      response.resume();
      ws.terminate();
    });
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      const buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer);
      if (!isBinary) return this.onControl(buffer.toString('utf8'));
      if (this.mode.kind === 'tunnel') return this.push(this.output, buffer);
      const payload = buffer.subarray(1);
      if (buffer[0] === CHANNEL_STDOUT) this.push(this.output, payload);
      else if (buffer[0] === CHANNEL_STDERR) this.push(this.errors, payload);
    });
    ws.on('close', (code: number) => {
      if (this.mode.kind === 'tunnel') this.exitCode = code === 1000 || code === 1005 ? 0 : 1;
      this.finish();
    });
    ws.on('error', (error: Error) => this.fail(new BridgeError(error.message)));
    // A connection that died without closing (a network path gone) is noticed within two pings.
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    this.ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        this.fail(new BridgeError('The computer stopped answering'));
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, PING_MS);
    this.ping.unref();
  }

  /** Runs `fn` once the socket is open; `dropped` instead when it never will be. */
  private whenOpen(fn: () => void, dropped?: () => void) {
    if (this.ended) return dropped?.();
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) fn();
    else this.waiting.push(() => (this.ws?.readyState === WebSocket.OPEN ? fn() : dropped?.()));
  }

  private sendInput(chunk: Buffer, callback: (error?: Error | null) => void) {
    const ws = this.ws!;
    for (let offset = 0; offset < chunk.length; offset += INPUT_CHUNK) {
      ws.send(chunk.subarray(offset, offset + INPUT_CHUNK), { binary: true });
    }
    // Hold the writer back while the socket is full (the stream's own buffer then fills).
    const wait = () => {
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount < INPUT_HIGH_WATER) callback();
      else setTimeout(wait, 20);
    };
    wait();
  }

  private endInput() {
    const ws = this.ws!;
    if (this.mode.kind === 'exec') ws.send(JSON.stringify({ t: 'eof' }));
    // A tunnel has no half-close: ending the input ends it.
    else ws.close(1000);
  }

  private push(stream: PassThrough, chunk: Buffer) {
    if (stream.destroyed || stream.writableEnded) return;
    if (stream.write(chunk) || this.behind.has(stream)) return;
    this.behind.add(stream);
    this.ws?.pause();
    stream.once('drain', () => {
      this.behind.delete(stream);
      if (!this.behind.size) this.ws?.resume();
    });
  }

  private onControl(text: string) {
    let message: { t?: unknown; code?: unknown; signal?: unknown } | null;
    try {
      message = JSON.parse(text) as { t?: unknown; code?: unknown; signal?: unknown } | null;
    } catch {
      return;
    }
    if (!message || message.t !== 'exit') return;
    this.exitReported = true;
    this.exitCode = codeOf(message.code, message.signal);
  }

  private fail(error: BridgeError) {
    if (this.ended) return;
    this.failure = error;
    if (!this.errors.writableEnded) this.errors.write(`${error.message}\n`);
    this.finish();
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    if (this.ping) clearInterval(this.ping);
    const waiting = this.waiting;
    this.waiting = [];
    for (const run of waiting) run();
    // Writes still waiting for a connection that never came are released.
    this.input.destroy();
    this.output.end();
    this.errors.end();
    const code = this.killed ? null : this.mode.kind === 'tunnel' || this.exitReported ? this.exitCode : null;
    // After the output's last 'data' event, as a child process's 'close' comes after its pipes.
    setImmediate(() => this.resolveExit(code));
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs a command to its end through a bridge, like `docker exec`: output past the cap is read and
 * dropped, and past `deadlineMs` the process is killed (`timedOut`, exit -1). Rejects with
 * BridgeError when the connection failed before the process reported its exit.
 */
export function bridgeRun(
  stream: BridgeStream,
  options: { deadlineMs: number; maxOutputBytes: number; input?: Uint8Array },
): Promise<ExecResult & { elapsedMs: number }> {
  const started = Date.now();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const sizes = { out: 0, err: 0 };
  const keep = (into: Buffer[], key: 'out' | 'err') => (chunk: Buffer) => {
    if (sizes[key] < options.maxOutputBytes) into.push(chunk.subarray(0, options.maxOutputBytes - sizes[key]));
    sizes[key] += chunk.length;
  };
  stream.output.on('data', keep(out, 'out'));
  stream.errors.on('data', keep(err, 'err'));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stream.kill();
  }, options.deadlineMs);
  if (options.input) stream.input.end(Buffer.from(options.input));
  else stream.input.end();
  return stream.exited
    .then((code) => {
      if (!timedOut && !stream.exitReported) {
        throw stream.failure ?? new BridgeError('The connection to the computer ended before the command did');
      }
      return {
        exitCode: timedOut ? -1 : (code ?? -1),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        elapsedMs: Date.now() - started,
      };
    })
    .finally(() => clearTimeout(timer));
}
