/**
 * The API side of gh-bridge (apps/bot-computer/e2b/gh-bridge.mjs): a hosted
 * computer's commands, streams and tunnels over one WebSocket each, shaped
 * like the `docker exec` child the docker host hands out — so the viewer, the
 * terminal, downloads and the shell need no second code path.
 *
 * Every connection carries the provider's traffic token (its edge refuses the
 * port without it) and the uid's bridge secret (the bridge refuses the upgrade
 * without it). Backpressure goes both ways: a reader that pauses `stdout`
 * pauses the socket, a full socket pauses the input.
 */

import { EventEmitter } from 'node:events';
import { constants as osConstants } from 'node:os';
import { PassThrough, Readable, Writable } from 'node:stream';
import * as wsModule from 'ws';

import { ComputerDockerError } from './docker.js';
import type { ComputerProcess, ExecOutcome, ExecSpec } from './host.js';

// ws is CJS; the namespace import works under both tsx and the compiled build (as in cdp-bridge.ts).
const WebSocketCtor = (wsModule.WebSocket ??
  (wsModule as unknown as { default: typeof wsModule }).default.WebSocket) as typeof wsModule.WebSocket;
type WsSocket = wsModule.WebSocket;

/** Where one bridge answers and what it takes to get in. */
export interface BridgeTarget {
  /** `wss://<port>-<sandbox>.<domain>` (no path). */
  origin: string;
  headers: Record<string, string>;
}

const CHANNEL_STDOUT = 1;
const CHANNEL_STDERR = 2;
/** Input frames are cut to this size. */
const INPUT_CHUNK = 1024 * 1024;
/** Stop feeding input while this much waits in the socket. */
const INPUT_HIGH_WATER = 4 * 1024 * 1024;
/** DevTools messages carry file uploads (the bridge accepts the same). */
const MAX_PAYLOAD = 256 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 20_000;
const PING_MS = 20_000;

/** A connection the bridge (or the provider's edge in front of it) refused or dropped. */
export class BridgeConnectionError extends Error {
  constructor(
    message: string,
    /** HTTP status of a refused upgrade (403 = secret, 502/404 = the sandbox is not there). */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'BridgeConnectionError';
  }
}

/** `128 + n` for a process killed by signal n — what `docker exec` reports. */
export function exitCodeOf(code: number | null, signal: string | null): number | null {
  if (code !== null) return code;
  if (!signal) return null;
  const number = (osConstants.signals as Record<string, number>)[signal];
  return number ? 128 + number : null;
}

type Mode =
  | { kind: 'exec'; argv: string[]; cwd?: string; env?: Record<string, string> }
  | { kind: 'tunnel'; path: string };

/** One bridge connection as a process: stdin, stdout, stderr, exit. */
export class BridgeProcess extends EventEmitter implements ComputerProcess {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** Set once the process (or the tunnel) has ended. */
  private ended = false;
  private exitReported = false;
  /** null until the target is known and the socket exists. */
  private ws: WsSocket | null = null;
  private ping: NodeJS.Timeout | null = null;
  private killRequested = false;
  /** Input waiting for the socket to open. */
  private readonly opened = new EventEmitter();

  /** `target` may still be resolving (the host looks the sandbox up first); a rejection is this process's 'error'. */
  constructor(
    target: BridgeTarget | Promise<BridgeTarget>,
    private readonly mode: Mode,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => this.sendInput(chunk, callback),
      final: (callback) => {
        if (this.mode.kind === 'exec') this.whenOpen(() => this.sendControl({ t: 'eof' }));
        callback();
      },
    });
    this.stdin.on('error', () => {});
    Promise.resolve(target).then(
      (resolved) => this.connect(resolved),
      (err: unknown) => this.fail(err instanceof Error ? err : new Error(String(err))),
    );
  }

  private connect(target: BridgeTarget): void {
    if (this.ended) return;
    const mode = this.mode;
    const path = mode.kind === 'exec' ? '/exec' : mode.path;
    const ws = new WebSocketCtor(`${target.origin}${path}`, {
      headers: target.headers,
      perMessageDeflate: false,
      maxPayload: MAX_PAYLOAD,
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
    this.ws = ws;
    ws.on('open', () => {
      if (mode.kind === 'exec') {
        ws.send(JSON.stringify({ argv: mode.argv, ...(mode.cwd ? { cwd: mode.cwd } : {}), env: mode.env ?? {} }));
      }
      if (this.killRequested) {
        if (mode.kind === 'tunnel') ws.terminate();
        else this.sendKill('SIGKILL');
      }
      this.opened.emit('open');
      this.emit('spawn');
    });
    ws.on('unexpected-response', (_req, res) => {
      this.fail(
        new BridgeConnectionError(
          `The computer refused the connection (HTTP ${res.statusCode})`,
          res.statusCode ?? null,
        ),
      );
      res.resume();
      ws.terminate();
    });
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (!isBinary) {
        this.onControl(buffer.toString('utf8'));
        return;
      }
      if (mode.kind === 'tunnel') {
        this.push(this.stdout, buffer);
        return;
      }
      const channel = buffer[0];
      const payload = buffer.subarray(1);
      if (channel === CHANNEL_STDOUT) this.push(this.stdout, payload);
      else if (channel === CHANNEL_STDERR) this.push(this.stderr, payload);
    });
    ws.on('close', (code) => {
      if (mode.kind === 'tunnel' && !this.exitReported) {
        this.exitCode = code === 1000 || code === 1005 ? 0 : 1;
      }
      this.finish();
    });
    ws.on('error', (err) => this.fail(new BridgeConnectionError(err.message)));
    this.ping = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
    }, PING_MS);
    this.ping.unref?.();
  }

  get connected(): boolean {
    return this.ws?.readyState === this.ws?.OPEN;
  }

  kill(signal: NodeJS.Signals | number = 'SIGKILL'): boolean {
    if (this.ended) return false;
    const ws = this.ws;
    if (!ws || ws.readyState === ws.CONNECTING) {
      this.killRequested = true;
      return true;
    }
    if (this.mode.kind === 'tunnel') {
      ws.terminate();
      return true;
    }
    this.sendKill(typeof signal === 'number' ? 'SIGKILL' : signal);
    // The bridge answers with the exit; a bridge that is gone never would.
    const hard = setTimeout(() => ws.terminate(), 5_000);
    hard.unref?.();
    return true;
  }

  private whenOpen(fn: () => void): void {
    const ws = this.ws;
    if (ws && ws.readyState === ws.OPEN) fn();
    else if (!this.ended) this.opened.once('open', fn);
  }

  private sendKill(signal: string): void {
    this.sendControl({ t: 'kill', signal });
  }

  private sendControl(message: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  private sendInput(chunk: Buffer, callback: (err?: Error | null) => void): void {
    this.whenOpen(() => {
      const ws = this.ws!;
      if (ws.readyState !== ws.OPEN) {
        callback();
        return;
      }
      for (let offset = 0; offset < chunk.length; offset += INPUT_CHUNK) {
        ws.send(chunk.subarray(offset, offset + INPUT_CHUNK), { binary: true });
      }
      // Hold the writer back while the socket is full (the stream's own buffer then fills).
      const wait = () => {
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount < INPUT_HIGH_WATER) callback();
        else setTimeout(wait, 20);
      };
      wait();
    });
  }

  private push(stream: PassThrough, chunk: Buffer): void {
    if (stream.destroyed) return;
    if (!stream.write(chunk)) {
      this.ws?.pause();
      stream.once('drain', () => this.ws?.resume());
    }
  }

  private onControl(text: string): void {
    let message: { t?: unknown; code?: unknown; signal?: unknown } | null;
    try {
      message = JSON.parse(text) as { t?: unknown; code?: unknown; signal?: unknown } | null;
    } catch {
      return;
    }
    if (message?.t !== 'exit') return;
    this.exitReported = true;
    this.signalCode = typeof message.signal === 'string' ? (message.signal as NodeJS.Signals) : null;
    this.exitCode = exitCodeOf(typeof message.code === 'number' ? message.code : null, this.signalCode);
  }

  private fail(err: Error): void {
    if (this.ended) return;
    if (this.listenerCount('error') > 0) this.emit('error', err);
    this.finish();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.ping) clearInterval(this.ping);
    this.opened.removeAllListeners();
    // Writes still waiting for a connection that never came are released.
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    // Nobody reads stderr: let it end anyway (stdout is the caller's to drain, as with a child).
    if (this.stderr.listenerCount('data') === 0) this.stderr.resume();
    this.emit('exit', this.exitCode, this.signalCode);
    // 'close' once both output streams have ended, like a ChildProcess.
    let open = 2;
    const done = () => {
      if (--open === 0) this.emit('close', this.exitCode, this.signalCode);
    };
    for (const stream of [this.stdout, this.stderr]) {
      if (stream.readableEnded) done();
      else stream.once('end', done);
    }
  }

  /** Whether the bridge reported the process's exit (false = the connection broke first). */
  get exited(): boolean {
    return this.exitReported;
  }
}

export function bridgeStream(
  target: BridgeTarget | Promise<BridgeTarget>,
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): BridgeProcess {
  return new BridgeProcess(target, { kind: 'exec', argv, cwd: opts.cwd, env: opts.env });
}

export function bridgeTunnel(
  target: BridgeTarget | Promise<BridgeTarget>,
  path: '/vnc' | '/cdp' | `/port?n=${number}`,
): BridgeProcess {
  return new BridgeProcess(target, { kind: 'tunnel', path });
}

/**
 * Run to completion with `docker exec`'s contract (host.ts ExecOutcome):
 * output caps (the rest drained and dropped), a deadline, abort, stdin bytes
 * or a stream. Rejects with BridgeConnectionError when the connection fails
 * before the process reported its exit.
 */
export function bridgeExec(target: BridgeTarget, spec: Omit<ExecSpec, 'container' | 'user'>): Promise<ExecOutcome> {
  const maxStdout = spec.maxStdoutBytes ?? 1024 * 1024;
  const maxStderr = spec.maxStderrBytes ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    const child = bridgeStream(target, spec.argv, { cwd: spec.cwd, env: spec.env });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let failure: Error | null = null;

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= maxStdout) {
        stdoutTruncated = true;
        return;
      }
      const room = maxStdout - stdoutBytes;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) stdoutTruncated = true;
      stdout.push(part);
      stdoutBytes += part.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < maxStderr) stderr += chunk.toString('utf8').slice(0, maxStderr - stderr.length);
    });
    child.on('error', (err) => {
      failure = err;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, spec.timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (spec.signal) {
      if (spec.signal.aborted) onAbort();
      else spec.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('close', () => {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      if (!child.exited && !timedOut && !aborted) {
        reject(failure ?? new BridgeConnectionError('The connection to the computer ended before the command did'));
        return;
      }
      resolve({
        // As `docker exec` reports it: a process the caller killed has no code of its own.
        code: timedOut || aborted ? null : child.exitCode,
        signal: child.signalCode,
        stdout: Buffer.concat(stdout),
        stderr,
        stdoutTruncated,
        timedOut,
        aborted,
      });
    });

    const input = spec.input;
    if (input instanceof Readable) {
      // The caller's stream broke (a client aborting an upload): stop the command.
      input.once('error', () => child.kill('SIGKILL'));
      input.pipe(child.stdin);
    } else if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/** For tests and callers that only need to know a bridge answers. */
export function isBridgeRefusal(err: unknown): err is BridgeConnectionError {
  return err instanceof BridgeConnectionError;
}

/** A refused or broken bridge connection as the error class the controller understands. */
export function asComputerError(err: unknown, gone: 'not_found' | 'not_running' | null): Error {
  if (gone) return new ComputerDockerError(gone, err instanceof Error ? err.message : String(err));
  if (err instanceof BridgeConnectionError) return new ComputerDockerError('failed', err.message);
  return err instanceof Error ? err : new Error(String(err));
}
