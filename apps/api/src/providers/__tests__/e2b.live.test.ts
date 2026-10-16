/**
 * The E2B sandbox adapter against a real E2B-protocol provider, the way the API uses it (the
 * registry's adapter, a fetch pinned to its endpoints). Opt-in, it spends provider credit:
 *
 *   E2B_API_KEY=… [E2B_DOMAIN=cn-beijing-1.sandbox.ppio.com] [E2B_TEMPLATE=gh-computer-…] \
 *   npx vitest run --project unit apps/api/src/providers/__tests__/e2b.live.test.ts
 *
 * Without E2B_TEMPLATE the template of this checkout is built first when the provider lacks it (a
 * few minutes). One computer in a namespace of its own; it is removed at the end, whatever happens.
 * Covers: start (network rules applied and probed), commands as the agent and as root with the
 * deadline inside, the agent kept off the browser's side, bytes both ways, the screen and
 * DevTools, pause and resume with processes and files intact, a restart that ends processes and
 * keeps the home, and removal.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdapter, pinnedFetch, type SandboxClient, type SandboxStream } from '@greenhouse/providers';
import { buildComputerTemplate, computerTemplateName, templateState } from '../e2b-template.js';

const API_KEY = process.env.E2B_API_KEY?.trim() ?? '';
const DOMAIN = process.env.E2B_DOMAIN?.trim() || undefined;
const NAME = `gh-cmp-live-${randomBytes(4).toString('hex')}`;
const SPEC = { name: NAME, labels: { 'greenhouse.computer': 'live' }, timezone: 'Asia/Shanghai' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The first bytes a stream sends (until `done` says enough), or null when it ended first. */
function firstBytes(stream: SandboxStream, done: (bytes: Buffer) => boolean, ms = 10_000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => resolve(null), ms);
    stream.output.on('data', (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (done(bytes)) {
        clearTimeout(timer);
        resolve(bytes);
      }
    });
    void stream.exited.then(() => {
      clearTimeout(timer);
      resolve(done(bytes) ? bytes : null);
    });
  });
}

describe.skipIf(!API_KEY)('the E2B sandbox (live provider)', () => {
  let client: SandboxClient;

  const agent = (command: string, timeoutMs = 60_000) =>
    client.exec(NAME, { argv: ['sh', '-c', command], user: 'agent', timeoutMs });

  /** The RFB greeting of the screen, once the desktop is up. */
  async function screenGreeting(): Promise<string> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const screen = client.screen(NAME);
      const bytes = await firstBytes(screen, (data) => data.length >= 12);
      screen.kill();
      if (bytes) return bytes.subarray(0, 12).toString('latin1');
      if (Date.now() > deadline) throw new Error('the screen did not come up');
      await sleep(1_000);
    }
  }

  /** Chromium's product through DevTools, once the browser is up. */
  async function browserProduct(): Promise<string> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const devtools = client.devtools(NAME);
      const answer = firstBytes(devtools, (data) => data.includes(0));
      devtools.input.write(Buffer.from('{"id":1,"method":"Browser.getVersion"}\0'));
      const bytes = await answer;
      devtools.kill();
      const product = bytes ? JSON.parse(bytes.subarray(0, bytes.indexOf(0)).toString())?.result?.product : null;
      if (typeof product === 'string') return product;
      if (Date.now() > deadline) throw new Error('the browser did not come up');
      await sleep(1_000);
    }
  }

  beforeAll(async () => {
    let template = process.env.E2B_TEMPLATE?.trim();
    if (!template) {
      const size = { cpuCount: 2, memoryMB: 2048 };
      template = await computerTemplateName(size);
      const conn = { apiKey: API_KEY, ...(DOMAIN ? { domain: DOMAIN } : {}) };
      if ((await templateState(conn, template)).state !== 'ready') {
        await buildComputerTemplate(conn, size, () => undefined);
      }
    }
    const adapter = getAdapter('sandbox', 'e2b')!;
    const config = adapter.configSchema.parse({
      template,
      namespace: `livetest-${randomBytes(3).toString('hex')}`,
      timeoutMinutes: 15,
      ...(DOMAIN ? { domain: DOMAIN } : {}),
    });
    client = adapter.create({
      config,
      secrets: { apiKey: API_KEY },
      fetch: pinnedFetch(adapter.endpoints(config)),
    }) as SandboxClient;
    // What 测试连接 does: the key and the template, before any computer starts.
    await adapter.test!(client, config);
  }, 20 * 60_000);

  afterAll(async () => {
    await client?.remove(NAME, { keepHome: false });
  }, 120_000);

  it('starts a computer and runs commands as the agent and as root, the deadline inside', async () => {
    await client.ensure(SPEC);
    expect(await client.status(NAME)).toBe('running');
    expect((await agent('id -un; date +%Z')).stdout).toBe('agent\nCST\n');
    expect((await client.exec(NAME, { argv: ['id', '-u'], user: 'root', timeoutMs: 30_000 })).stdout).toBe('0\n');
    const started = Date.now();
    expect(await agent('sleep 60', 2_000)).toMatchObject({ exitCode: 124, timedOut: true });
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 300_000);

  it('keeps the agent off the browser’s side and away from root', async () => {
    const checks = [
      'cat /etc/gh-bridge/browser.secret >/dev/null 2>&1 && echo LEAK_secret',
      'ls /tmp/browser >/dev/null 2>&1 && echo LEAK_run',
      'ls /home/browser >/dev/null 2>&1 && echo LEAK_home',
      'sudo -n true >/dev/null 2>&1 && echo LEAK_sudo',
      'curl -s -m 5 -o /dev/null http://169.254.169.254/ && echo LEAK_mmds',
      'curl -s -m 5 -o /dev/null http://127.0.0.1:49983/health && echo LEAK_envd',
      'echo checked',
    ];
    expect((await agent(checks.join('; '))).stdout).toBe('checked\n');
  }, 120_000);

  it('streams bytes both ways and serves the screen and DevTools', async () => {
    const bytes = randomBytes(1024 * 1024);
    const cat = client.stream(NAME, { argv: ['cat'], user: 'agent' });
    const echoed = firstBytes(cat, (data) => data.length >= bytes.length, 60_000);
    cat.input.end(bytes);
    expect((await echoed)?.equals(bytes)).toBe(true);
    expect(await cat.exited).toBe(0);
    expect(await screenGreeting()).toMatch(/^RFB 003\.00\d\n$/);
    expect(await browserProduct()).toMatch(/^Chrome\//);
  }, 300_000);

  it('pauses and resumes with its processes and files intact', async () => {
    const pid = (await agent('echo kept > ~/work/live.txt; nohup sleep 3000 >/dev/null 2>&1 & echo $!')).stdout.trim();
    await client.stop(NAME);
    expect(await client.status(NAME)).toBe('stopped');
    await client.ensure(SPEC);
    expect(await client.status(NAME)).toBe('running');
    expect((await agent(`kill -0 ${pid} && echo alive; cat ~/work/live.txt`)).stdout).toBe('alive\nkept\n');
  }, 300_000);

  it('restarts in place: every process ends, the home stays, the desktop comes back', async () => {
    const pid = (await agent('nohup sleep 3000 >/dev/null 2>&1 & echo $!')).stdout.trim();
    await client.restart(NAME);
    expect((await agent(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone; cat ~/work/live.txt`)).stdout).toBe(
      'gone\nkept\n',
    );
    expect(await screenGreeting()).toMatch(/^RFB 003\.00\d\n$/);
  }, 300_000);

  it('removes the computer and its home', async () => {
    await client.remove(NAME, { keepHome: false });
    expect(await client.status(NAME)).toBe('missing');
  }, 120_000);
});
