/**
 * Root commands through envd (sandbox/e2b/envd.ts): the Connect envelopes in pieces, output and
 * exit codes (a signal as 128 + n), the cap, a deadline that cuts the request and kills the
 * process, and the failures: a refused request, an error at the end of the stream, a stream that
 * stops short. Tokens never appear in an error.
 */

import { describe, expect, it, vi } from 'vitest';
import { EnvelopeReader, envdRun, envelope, exitCodeOf, type EnvdTarget } from '../sandbox/e2b/envd.js';

const TARGET: EnvdTarget = {
  origin: 'https://49983-sbx1.e2b.test',
  sandboxId: 'sbx1',
  accessToken: 'envd-token-123456',
};
const COMMAND = { argv: ['/bin/bash', '-c', 'true'], user: 'root', timeoutMs: 5_000, maxOutputBytes: 1024 };

const event = (body: Record<string, unknown>) => envelope({ event: body });

function streamOf(chunks: Buffer[], options: { open?: boolean; signal?: AbortSignal | null } = {}) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      if (!options.open) controller.close();
      options.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  });
}

function wire(chunks: Buffer[], options: { open?: boolean; status?: number } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/SendSignal')) return new Response('{}');
    if (options.status)
      return new Response('{"code":"unauthenticated","message":"bad token envd-token-123456"}', {
        status: options.status,
      });
    return new Response(streamOf(chunks, { open: options.open ?? false, signal: init?.signal ?? null }), {
      headers: { 'content-type': 'application/connect+json' },
    });
  });
}

describe('envd commands', () => {
  it('reads envelopes cut anywhere', () => {
    const bytes = Buffer.concat([event({ start: { pid: 1 } }), envelope({}, 2)]);
    const reader = new EnvelopeReader();
    const out = [
      ...reader.push(bytes.subarray(0, 3)),
      ...reader.push(bytes.subarray(3, 11)),
      ...reader.push(bytes.subarray(11)),
    ];
    expect(out.map((entry) => [entry.flags, JSON.parse(entry.data.toString())])).toEqual([
      [0, { event: { start: { pid: 1 } } }],
      [2, {}],
    ]);
    expect(reader.pending).toBe(0);
  });

  it('sends the command as the user with its token and deadline, and returns output and exit code', async () => {
    const fetch = wire([
      event({ start: { pid: 7 } }),
      event({ data: { stdout: Buffer.from('out\n').toString('base64') } }),
      event({ data: { stderr: Buffer.from('err\n').toString('base64') } }),
      event({ keepalive: {} }),
      event({ end: { exitCode: 2, exited: true, status: 'exit status 2' } }),
      envelope({}, 2),
    ]);
    const result = await envdRun(fetch as unknown as typeof globalThis.fetch, TARGET, {
      ...COMMAND,
      envs: { A: 'b' },
      cwd: '/',
    });
    expect(result).toEqual({ exitCode: 2, stdout: 'out\n', stderr: 'err\n', timedOut: false });
    const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://49983-sbx1.e2b.test/process.Process/Start');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Basic ${Buffer.from('root:').toString('base64')}`);
    expect(headers.get('x-access-token')).toBe('envd-token-123456');
    expect(headers.get('content-type')).toBe('application/connect+json');
    expect(Number(headers.get('connect-timeout-ms'))).toBeGreaterThan(5_000);
    const body = Buffer.from(init.body as Uint8Array);
    expect(JSON.parse(body.subarray(5).toString())).toEqual({
      process: { cmd: '/bin/bash', args: ['-c', 'true'], envs: { A: 'b' }, cwd: '/' },
    });
  });

  it('reads a clean exit without a code as 0 and a signal as 128 + n', () => {
    expect(exitCodeOf({ exited: true, status: 'exit status 0' })).toBe(0);
    expect(exitCodeOf({ exitCode: -1, status: 'signal: killed' })).toBe(137);
    expect(exitCodeOf({ exitCode: -1, status: 'signal: terminated' })).toBe(143);
    expect(exitCodeOf({ exitCode: -1, status: 'signal: something else' })).toBe(-1);
  });

  it('keeps output up to the cap', async () => {
    const fetch = wire([
      event({ start: { pid: 7 } }),
      event({ data: { stdout: Buffer.alloc(3000, 97).toString('base64') } }),
      event({ end: { exited: true } }),
    ]);
    const result = await envdRun(fetch as unknown as typeof globalThis.fetch, TARGET, COMMAND);
    expect(result.stdout).toBe('a'.repeat(1024));
  });

  it('cuts the request at the deadline and kills the process it started', async () => {
    const fetch = wire([event({ start: { pid: 42 } })], { open: true });
    const result = await envdRun(fetch as unknown as typeof globalThis.fetch, TARGET, { ...COMMAND, timeoutMs: 100 });
    expect(result).toMatchObject({ exitCode: -1, timedOut: true });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const [url, init] = fetch.mock.calls[1]! as [string, RequestInit];
    expect(url).toBe('https://49983-sbx1.e2b.test/process.Process/SendSignal');
    expect(JSON.parse(String(init.body))).toEqual({ process: { pid: 42 }, signal: 'SIGNAL_SIGKILL' });
  });

  it('fails without repeating the token when envd refuses, errs at the end, or stops short', async () => {
    const refused = await envdRun(wire([], { status: 401 }) as unknown as typeof fetch, TARGET, COMMAND).catch(
      (e: Error) => e,
    );
    expect(refused).toMatchObject({ statusCode: 401 });
    expect((refused as Error).message).toContain('HTTP 401');
    expect((refused as Error).message).not.toContain('envd-token-123456');

    const failed = wire([envelope({ error: { code: 'not_found', message: 'no such user' } }, 2)]);
    await expect(envdRun(failed as unknown as typeof fetch, TARGET, COMMAND)).rejects.toThrow(
      'not_found: no such user',
    );

    const short = wire([event({ start: { pid: 1 } })]);
    await expect(envdRun(short as unknown as typeof fetch, TARGET, COMMAND)).rejects.toThrow(
      'ended before the command did',
    );
  });
});
