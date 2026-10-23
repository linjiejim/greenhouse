/**
 * The E2B driver against a scripted fetch (never the network): the API key
 * only ever goes to api.<domain>, a computer is created private with the
 * private ranges denied, commands stream back through envd's Connect envelopes
 * with the deadline enforced inside the computer, a missing sandbox is not an
 * error to kill, and a file larger than asked for is refused while streaming.
 */

import { describe, expect, it, vi } from 'vitest';
import { createE2bDriver, PROVIDER_DENY_OUT } from '../e2b/driver.js';
import { envelope } from '../e2b/envd.js';

const CONFIG = { apiKey: 'e2b_secret_key', domain: 'e2b.app', template: 'base' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stream(...messages: Array<{ message: unknown; flags?: number }>) {
  return new Response(Buffer.concat(messages.map(({ message, flags }) => envelope(message, flags))), { status: 200 });
}

describe('E2B driver', () => {
  it('creates a private computer and keeps the API key on the control plane', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url === 'https://api.e2b.app/v2/sandboxes') {
        return json({ sandboxID: 'sbx1', envdAccessToken: 'envd-token' });
      }
      if (url === 'https://49983-sbx1.e2b.app/process.Process/Start') {
        return stream(
          { message: { event: { start: { pid: 7 } } } },
          { message: { event: { data: { stdout: Buffer.from('hello\n').toString('base64') } } } },
          { message: { event: { end: { exitCode: 0, exited: true } } } },
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    const driver = createE2bDriver(CONFIG, fetchImpl as unknown as typeof fetch);

    const { sandboxId } = await driver.create({ computerId: 'cmp_1', userId: 'u1', timeoutSeconds: 1020 });
    expect(sandboxId).toBe('sbx1');
    const created = JSON.parse(String(calls[0]!.init.body));
    expect(created).toMatchObject({
      templateID: 'base',
      timeout: 1020,
      autoPause: false,
      metadata: { gh_computer: 'cmp_1', gh_member: 'u1' },
      network: { allowPublicTraffic: false, denyOut: PROVIDER_DENY_OUT },
    });
    expect((calls[0]!.init.headers as Record<string, string>)['X-API-Key']).toBe('e2b_secret_key');

    const result = await driver.exec(sandboxId, { command: 'echo hello', timeoutMs: 30_000, maxOutputBytes: 1000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'hello\n', timedOut: false });
    const start = calls[1]!;
    const headers = start.init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBeUndefined();
    expect(headers['X-Access-Token']).toBe('envd-token');
    const body = Buffer.from(start.init.body as Uint8Array);
    const process = JSON.parse(body.subarray(5).toString('utf8')).process;
    expect(process.cmd).toBe('/usr/bin/timeout');
    expect(process.args).toEqual(['-k', '5', '30.000', '/bin/bash', '-lc', 'echo hello']);
    expect(process.cwd).toBe('/home/user');
  });

  it('treats a sandbox that is already gone as stopped, and redacts the key from errors', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'DELETE') return json({ message: 'not found' }, 404);
      return json({ message: 'bad key e2b_secret_key' }, 401);
    });
    const driver = createE2bDriver(CONFIG, fetchImpl as unknown as typeof fetch);
    await expect(driver.kill('sbx1')).resolves.toBeUndefined();
    const failure = await driver.create({ computerId: 'c', userId: 'u', timeoutSeconds: 60 }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('e2b_secret_key');
    expect((failure as { statusCode?: number }).statusCode).toBe(401);
  });

  it('reaches a sandbox another process created, and refuses a file over the limit', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://api.e2b.app/v2/sandboxes/sbx9/connect') return json({ sandboxID: 'sbx9' });
      if (url.startsWith('https://49983-sbx9.e2b.app/files?')) return new Response('x'.repeat(2048), { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    const driver = createE2bDriver(CONFIG, fetchImpl as unknown as typeof fetch);
    await expect(driver.readFile('sbx9', { path: '/home/user/big.log', maxBytes: 1024 })).rejects.toThrow(
      /larger than 1024 bytes/,
    );
    expect((await driver.readFile('sbx9', { path: '/home/user/big.log', maxBytes: 4096 })).length).toBe(2048);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/connect'))).toHaveLength(1);
  });
});
