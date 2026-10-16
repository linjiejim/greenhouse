/**
 * The browser's DevTools over a computer's byte stream (SandboxClient.devtools): the pipe
 * protocol, JSON messages each ended by a NUL byte. The computer's relay (gh-cdp-relay) serves
 * one client at a time and maps command ids, so every connection counts from 1.
 *
 * Nothing here logs what crosses the stream: pages send their content, and the vault types
 * secrets through `Input.insertText`. Errors name the method, never its parameters.
 */

import type { SandboxStream } from '@greenhouse/providers';

/** A screenshot or an accessibility tree of a big page fits; anything past this is refused. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
/** After its input ends, the tunnel gets this long to exit before it is killed. */
const HANG_UP_MS = 1_000;

export class CdpError extends Error {
  constructor(
    readonly method: string,
    message: string,
    /** Chromium's error code; null when the connection itself failed. */
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = 'CdpError';
  }
}

/** Splits a byte stream into the messages between NUL bytes. */
export class NulFramer {
  private parts: Buffer[] = [];
  private size = 0;

  constructor(private readonly max = MAX_MESSAGE_BYTES) {}

  /** The messages this chunk completes; throws once one grows past the limit. */
  push(chunk: Buffer): string[] {
    const messages: string[] = [];
    let start = 0;
    for (let end = chunk.indexOf(0, start); end >= 0; end = chunk.indexOf(0, start)) {
      this.add(chunk.subarray(start, end));
      // Decoded only when whole, so a character split across chunks stays intact.
      const message =
        this.parts.length === 1 ? this.parts[0]!.toString('utf8') : Buffer.concat(this.parts).toString('utf8');
      this.parts = [];
      this.size = 0;
      if (message) messages.push(message);
      start = end + 1;
    }
    if (start < chunk.length) this.add(chunk.subarray(start));
    return messages;
  }

  private add(piece: Buffer) {
    this.size += piece.length;
    if (this.size > this.max) throw new Error('A DevTools message was too large.');
    if (piece.length) this.parts.push(piece);
  }
}

/** One message on the wire; JSON escapes NUL inside strings, so the frame cannot split. */
export const frame = (message: Record<string, unknown>) => Buffer.from(`${JSON.stringify(message)}\0`, 'utf8');

export interface CdpEvent {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

export interface Cdp {
  /** A command to the browser, or to the page a session is attached to. */
  send<T = Record<string, any>>(
    method: string,
    params?: Record<string, unknown>,
    options?: { sessionId?: string; timeoutMs?: number },
  ): Promise<T>;
  /** Every event; returns the unsubscribe. */
  on(listener: (event: CdpEvent) => void): () => void;
  /** Ends the connection; commands still waiting fail. */
  close(): void;
  readonly closed: boolean;
}

interface Pending {
  method: string;
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export function openCdp(
  stream: SandboxStream,
  options: { timeoutMs?: number; maxMessageBytes?: number; signal?: AbortSignal } = {},
): Cdp {
  const framer = new NulFramer(options.maxMessageBytes ?? MAX_MESSAGE_BYTES);
  const pending = new Map<number, Pending>();
  const listeners = new Set<(event: CdpEvent) => void>();
  let nextId = 1;
  let closed = false;

  const fail = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new CdpError(entry.method, reason));
    }
    options.signal?.removeEventListener('abort', onAbort);
    stream.input.end();
    const kill = setTimeout(() => stream.kill(), HANG_UP_MS);
    kill.unref();
    void stream.exited.then(() => clearTimeout(kill));
  };

  const onAbort = () => fail('Stopped.');
  if (options.signal?.aborted) queueMicrotask(onAbort);
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  const onMessage = (text: string) => {
    let message: { id?: unknown; result?: unknown; error?: { message?: unknown; code?: unknown }; method?: unknown };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const reason = typeof message.error.message === 'string' ? message.error.message : 'The browser refused.';
        entry.reject(
          new CdpError(
            entry.method,
            reason.slice(0, 300),
            typeof message.error.code === 'number' ? message.error.code : null,
          ),
        );
      } else entry.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === 'string') {
      const event = message as unknown as CdpEvent;
      for (const listener of [...listeners]) {
        try {
          listener({ method: event.method, params: event.params ?? {}, sessionId: event.sessionId });
        } catch {
          // A listener's failure is its own.
        }
      }
    }
  };

  stream.output.on('data', (chunk: Buffer) => {
    if (closed) return;
    let messages: string[];
    try {
      messages = framer.push(chunk);
    } catch (error) {
      return fail((error as Error).message);
    }
    for (const text of messages) onMessage(text);
  });
  stream.output.on('error', () => fail('The browser connection failed.'));
  stream.errors.on('data', () => undefined);
  stream.errors.on('error', () => undefined);
  void stream.exited.then(() => fail('The browser connection closed.'));

  return {
    send(method, params = {}, sendOptions = {}) {
      if (closed) return Promise.reject(new CdpError(method, 'The browser connection is closed.'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => {
            pending.delete(id);
            reject(new CdpError(method, 'The browser did not answer in time.'));
          },
          sendOptions.timeoutMs ?? options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        );
        pending.set(id, { method, resolve, reject, timer });
        // `id` first: the relay rewrites it without parsing the message.
        stream.input.write(
          frame({ id, method, params, ...(sendOptions.sessionId ? { sessionId: sendOptions.sessionId } : {}) }),
        );
      });
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => fail('The browser connection is closed.'),
    get closed() {
      return closed;
    },
  };
}
