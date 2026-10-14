/**
 * The E2B sandbox adapter against a provider in memory (fake-e2b.ts) and the real bridges on
 * loopback: which sandbox a start creates or wakes and how it boots, commands as the agent and as
 * root with their deadline inside, streams both ways, stop / restart / remove, the refusals (a
 * provider that would kill on timeout or open the ports, network rules not in force, another
 * domain), error mapping, the bridge secrets after a key change and the template check.
 */

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getAdapter } from '../registry.js';
import { EndpointViolation, pinnedFetch } from '../pinned-fetch.js';
import {
  bridgeSecret,
  createE2bSandbox,
  e2bAdapter,
  e2bConfigSchema,
  e2bEndpoints,
  settingsOf,
  type E2bConfig,
} from '../sandbox/e2b/adapter.js';
import { PROVIDER_DENY_OUT } from '../sandbox/e2b/egress.js';
import type { SandboxClient, SandboxSpec } from '../types.js';
import { FakeE2b } from './fake-e2b.js';
import { startBridges, type BridgeHarness } from './gh-bridge-harness.js';

let bridges: BridgeHarness;

beforeAll(async () => {
  bridges = await startBridges();
});

afterAll(async () => {
  await bridges?.stop();
});

afterEach(() => {
  writeFileSync(bridges.leakFile, '');
});

const NAME = 'gh-cmp-agt_01abc';
const SPEC: SandboxSpec = {
  name: NAME,
  labels: { 'greenhouse.computer': 'cmp_1', 'greenhouse.agent': 'agt_1' },
  timezone: 'Asia/Shanghai',
};

function setup(overrides: Partial<E2bConfig> = {}, clock?: { now: number }) {
  // A key of its own per test, so no test sees another's computers.
  const apiKey = `e2b_${randomBytes(12).toString('hex')}`;
  const fake = new FakeE2b(apiKey, bridges);
  const config = e2bConfigSchema.parse({ domain: 'e2b.test', template: 'gh-computer-abc', ...overrides });
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const client = createE2bSandbox(config, apiKey, {
    fetch: pinnedFetch(e2bEndpoints(config), fake.fetch),
    connect: fake.connector(seen),
    ...(clock ? { now: () => clock.now } : {}),
  });
  return { fake, client, config, apiKey, seen };
}

/** Everything a stream writes until `n` bytes arrived. */
async function readBytes(stream: ReturnType<SandboxClient['stream']>, n: number) {
  const parts: Buffer[] = [];
  stream.output.on('data', (chunk: Buffer) => parts.push(chunk));
  const deadline = Date.now() + 5_000;
  while (Buffer.concat(parts).length < n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return Buffer.concat(parts);
}

async function rejection(call: Promise<unknown>): Promise<Error & { statusCode?: number }> {
  try {
    await call;
  } catch (error) {
    return error as Error & { statusCode?: number };
  }
  throw new Error('Expected the call to fail');
}

describe('the E2B sandbox settings', () => {
  it('restricts background egress to declared domains, can seal it offline, and restores only normal deny rules', async () => {
    const { fake, client } = setup();
    await client.ensure(SPEC);
    await client.setEgress!(NAME, ['example.com']);
    await client.setEgress!(NAME, []);
    await client.setEgress!(NAME, null);
    expect(fake.networks.map(({ id: _id, ...rules }) => rules)).toEqual([
      { allowOut: ['example.com'], denyOut: ['0.0.0.0/0', '::/0'] },
      { allowOut: [], denyOut: ['0.0.0.0/0', '::/0'] },
      { denyOut: PROVIDER_DENY_OUT },
    ]);
  });
  it('is registered with E2B and PPIO presets, the API key as its one secret', () => {
    const adapter = getAdapter('sandbox', 'e2b')!;
    expect(adapter).toBe(e2bAdapter);
    expect(adapter.secretKeys).toEqual(['apiKey']);
    expect(adapter.requiredSecrets).toEqual(['apiKey']);
    expect(adapter.presets!.map((preset) => [preset.id, preset.config.domain])).toEqual([
      ['e2b', 'e2b.app'],
      ['ppio', 'cn-beijing-1.sandbox.ppio.com'],
    ]);
  });

  it('needs a template, defaults the rest and checks the domain', () => {
    expect(e2bConfigSchema.parse({ template: 'gh-computer-abc' })).toEqual({
      domain: 'e2b.app',
      template: 'gh-computer-abc',
      namespace: 'greenhouse',
      timeoutMinutes: 60,
    });
    expect(e2bConfigSchema.safeParse({}).success).toBe(false);
    for (const domain of ['https://e2b.app', 'e2b', 'e2b.app/x', 'E2B.app '])
      expect(e2bConfigSchema.safeParse({ template: 't', domain }).success).toBe(false);
    expect(e2bConfigSchema.safeParse({ template: 't', timeoutMinutes: 5 }).success).toBe(false);
  });

  it('gives 管理 → 服务 a form: the template required, the rest with defaults', () => {
    const schema = z.toJSONSchema(e2bConfigSchema, { io: 'input', unrepresentable: 'any' }) as {
      properties: Record<string, { default?: unknown; type?: string }>;
      required?: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['domain', 'template', 'namespace', 'timeoutMinutes']);
    expect(schema.required).toEqual(['template']);
    expect(schema.properties.domain!.default).toBe('e2b.app');
    expect(schema.properties.timeoutMinutes!.type).toBe('integer');
  });

  it('may reach only the API and the computers under its domain', () => {
    expect(
      e2bAdapter.endpoints(e2bConfigSchema.parse({ template: 't', domain: 'cn-beijing-1.sandbox.ppio.com' })),
    ).toEqual(['https://api.cn-beijing-1.sandbox.ppio.com', 'https://*.cn-beijing-1.sandbox.ppio.com']);
  });

  it('gives the computer the time zone and no proxy, and refuses a zone that could carry anything else', () => {
    const settings = settingsOf({ timezone: 'America/Argentina/Buenos_Aires' });
    expect(settings.split('\n')).toContain('TZ=America/Argentina/Buenos_Aires');
    expect(settings.split('\n')).toContain('HTTPS_PROXY=');
    expect(() => settingsOf({ timezone: 'UTC\nLD_PRELOAD=/tmp/x' })).toThrow('time zone');
  });
});

describe('the E2B sandbox', () => {
  it('creates a computer with private ports, boots it as root and proves its network rules', async () => {
    const { fake, client, apiKey, seen } = setup();
    expect(await client.status(NAME)).toBe('missing');
    await client.ensure(SPEC);

    expect(fake.creates).toHaveLength(1);
    const [created] = fake.creates;
    expect(created).toMatchObject({
      templateID: 'gh-computer-abc',
      timeout: 3600,
      autoPause: true,
      autoResume: { enabled: false },
      network: { allowPublicTraffic: false, denyOut: PROVIDER_DENY_OUT },
      metadata: { gh_ns: 'greenhouse', gh_name: NAME, greenhouse_computer: 'cmp_1', greenhouse_agent: 'agt_1' },
    });
    const id = [...fake.sandboxes.keys()][0]!;
    // Network rules first, then the boot with the bridge secrets and the settings, all as root.
    expect(fake.kinds(id)).toEqual(['egress', 'boot']);
    const boot = fake.roots[1]!;
    expect(boot.user).toBe('root');
    expect(boot.argv.slice(0, 5)).toEqual(['/usr/bin/timeout', '-k', '5', '90.000', '/bin/bash']);
    expect(boot.envs.GH_BRIDGE_SECRET_AGENT).toBe(bridgeSecret(apiKey, id, 'agent'));
    expect(boot.envs.GH_BRIDGE_SECRET_BROWSER).toBe(bridgeSecret(apiKey, id, 'browser'));
    expect(Buffer.from(boot.envs.GH_COMPUTER_ENV_B64!, 'base64').toString()).toBe(settingsOf(SPEC));
    // Both bridges answered, and the probe ran from both accounts.
    expect(seen.map((entry) => new URL(entry.url).host)).toEqual(
      expect.arrayContaining([`7682-${id}.e2b.test`, `7681-${id}.e2b.test`]),
    );
    expect(await client.status(NAME)).toBe('running');

    // The key goes only to the API; envd gets its own token, the bridges the edge's and their secret.
    for (const request of fake.requests) {
      expect(request.headers.has('x-api-key')).toBe(request.url.hostname === 'api.e2b.test');
      if (request.url.hostname.startsWith('49983-')) expect(request.headers.get('x-access-token')).toBe(`envd-${id}`);
    }
    for (const connection of seen) {
      expect(Object.values(connection.headers)).not.toContain(apiKey);
      expect(connection.headers['e2b-traffic-access-token']).toBe(`traffic-${id}`);
    }
  });

  it('runs commands as the agent through its bridge, with the deadline enforced inside the computer', async () => {
    const { client, seen } = setup();
    await client.ensure(SPEC);
    seen.length = 0;
    const result = await client.exec(NAME, {
      argv: ['sh', '-c', 'echo "hi $GH_TEST_INHERITED"; echo oops >&2; exit 4'],
      user: 'agent',
      cwd: '/',
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ exitCode: 4, stdout: 'hi from-the-unit\n', stderr: 'oops\n', timedOut: false });
    expect(seen.map((entry) => entry.url)).toEqual([expect.stringMatching(/^wss:\/\/7682-sbx\d+\.e2b\.test\/exec$/)]);

    const started = Date.now();
    const late = await client.exec(NAME, { argv: ['sleep', '10'], user: 'agent', cwd: '/', timeoutMs: 1_000 });
    expect(late).toMatchObject({ exitCode: 124, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5_000);

    const capped = await client.exec(NAME, {
      argv: ['sh', '-c', 'head -c 5000 /dev/zero'],
      user: 'agent',
      cwd: '/',
      timeoutMs: 10_000,
      maxOutputBytes: 100,
    });
    expect(capped.stdout).toHaveLength(100);
  });

  it('runs root commands through envd, the deadline inside as well', async () => {
    const { fake, client } = setup();
    await client.ensure(SPEC);
    fake.answer = (call) => (call.kind === 'exec' ? { stdout: '0\n', stderr: 'warn\n', exitCode: 3 } : {});
    const result = await client.exec(NAME, { argv: ['id', '-u'], user: 'root', timeoutMs: 30_000 });
    expect(result).toEqual({ exitCode: 3, stdout: '0\n', stderr: 'warn\n', timedOut: false });
    const call = fake.roots.at(-1)!;
    expect(call).toMatchObject({
      kind: 'exec',
      user: 'root',
      argv: ['/usr/bin/timeout', '-k', '5', '30.000', 'id', '-u'],
    });
  });

  it('streams the terminal both ways, and tunnels the screen and DevTools as the browser account', async () => {
    const { client, seen } = setup();
    await client.ensure(SPEC);
    seen.length = 0;
    const bytes = randomBytes(256 * 1024);
    const terminal = client.stream(NAME, { argv: ['cat'], user: 'agent', cwd: '/' });
    const echoed = readBytes(terminal, bytes.length);
    terminal.input.write(bytes);
    expect((await echoed).equals(bytes)).toBe(true);
    terminal.input.end();
    expect(await terminal.exited).toBe(0);

    for (const [open, path] of [
      [client.screen, '/vnc'],
      [client.devtools, '/cdp'],
    ] as const) {
      const tunnel = open(NAME);
      const back = readBytes(tunnel, 1000);
      tunnel.input.write(Buffer.alloc(1000, 7));
      expect((await back).equals(Buffer.alloc(1000, 7))).toBe(true);
      tunnel.kill();
      expect(await tunnel.exited).toBeNull();
      expect(seen.at(-1)!.url).toMatch(new RegExp(`^wss://7681-sbx\\d+\\.e2b\\.test${path}$`));
    }
    expect(seen[0]!.url).toMatch(/^wss:\/\/7682-/);
  });

  it('stops by pausing, and the next start wakes the same computer with its settings', async () => {
    const { fake, client } = setup();
    await client.ensure(SPEC);
    const id = [...fake.sandboxes.keys()][0]!;
    await client.stop(NAME);
    expect(fake.sandboxes.get(id)!.state).toBe('paused');
    expect(await client.status(NAME)).toBe('stopped');
    await expect(client.exec(NAME, { argv: ['true'], user: 'agent', cwd: '/', timeoutMs: 5_000 })).rejects.toThrow(
      'not running',
    );
    const stream = client.stream(NAME, { argv: ['true'], user: 'agent', cwd: '/' });
    expect(await stream.exited).toBeNull();

    await client.ensure(SPEC);
    expect(fake.creates).toHaveLength(1);
    expect(fake.sandboxes.get(id)!.state).toBe('running');
    expect(fake.kinds(id)).toEqual(['egress', 'boot', 'egress', 'resume']);
    expect((await client.exec(NAME, { argv: ['true'], user: 'agent', cwd: '/', timeoutMs: 5_000 })).exitCode).toBe(0);
    // Stopping twice is not an error.
    await client.stop(NAME);
    await client.stop(NAME);
  });

  it('restarts in place when a woken computer cannot carry on as it was', async () => {
    const { fake, client } = setup();
    await client.ensure(SPEC);
    await client.stop(NAME);
    fake.answer = (call) => (call.kind === 'resume' ? { exitCode: 4, stderr: 'the desktop is not running' } : {});
    await client.ensure(SPEC);
    const reset = fake.roots.at(-1)!;
    expect(fake.kinds().slice(-3)).toEqual(['egress', 'resume', 'reset']);
    expect(Buffer.from(reset.envs.GH_COMPUTER_ENV_B64!, 'base64').toString()).toBe(settingsOf(SPEC));
    expect(await client.status(NAME)).toBe('running');
  });

  it('restart ends every process in place and keeps the settings it had', async () => {
    const { fake, client } = setup();
    await client.ensure(SPEC);
    await client.restart(NAME);
    const reset = fake.roots.at(-1)!;
    expect(fake.kinds().slice(-2)).toEqual(['egress', 'reset']);
    expect(reset.envs.GH_COMPUTER_ENV_B64).toBeUndefined();
    expect(reset.envs.GH_BRIDGE_SECRET_AGENT).toBeDefined();
    expect((await client.exec(NAME, { argv: ['true'], user: 'agent', cwd: '/', timeoutMs: 5_000 })).exitCode).toBe(0);
  });

  it('removes the computer with its home, or keeps the home by keeping it paused', async () => {
    const { fake, client } = setup();
    await client.ensure(SPEC);
    await client.remove(NAME, { keepHome: true });
    expect([...fake.sandboxes.values()].map((sandbox) => sandbox.state)).toEqual(['paused']);
    await client.remove(NAME, { keepHome: false });
    expect(fake.sandboxes.size).toBe(0);
    expect(await client.status(NAME)).toBe('missing');
    await client.remove(NAME, { keepHome: false });
  });

  it('starts one computer when two starts of it race in one process', async () => {
    const { fake, client } = setup();
    await Promise.all([client.ensure(SPEC), client.ensure(SPEC)]);
    expect(fake.creates).toHaveLength(1);
    expect(fake.sandboxes.size).toBe(1);
  });

  it('gives way to the computer another API process made at the same moment', async () => {
    const { fake, client } = setup();
    fake.duringCreate = () => {
      fake.seed({ gh_ns: 'greenhouse', gh_name: NAME, gh_created: '2000-01-01T00:00:00.000Z' }, 'running');
    };
    const error = await rejection(client.ensure(SPEC));
    expect(error.message).toContain('being started elsewhere');
    expect([...fake.sandboxes.values()].map((sandbox) => sandbox.metadata.gh_created)).toEqual([
      '2000-01-01T00:00:00.000Z',
    ]);
  });

  it('refuses a provider that would kill a computer on timeout, and leaves nothing behind', async () => {
    const { fake, client } = setup();
    fake.onTimeout = 'kill';
    expect((await rejection(client.ensure(SPEC))).message).toContain('would kill a computer on timeout');
    expect(fake.sandboxes.size).toBe(0);
  });

  it('refuses a provider that does not keep the ports private', async () => {
    const { fake, client, seen } = setup();
    fake.privatePorts = false;
    expect((await rejection(client.ensure(SPEC))).message).toContain('ports private');
    expect(fake.sandboxes.size).toBe(0);
    expect(seen).toEqual([]);
  });

  it('never uses a computer whose network rules are not in force', async () => {
    const { fake, client } = setup();
    writeFileSync(bridges.leakFile, 'http://169.254.169.254/');
    const error = await rejection(client.ensure(SPEC));
    expect(error.message).toContain('network rules are not in force');
    expect(error.message).toContain('http://169.254.169.254/');
    expect(fake.sandboxes.size).toBe(0);
  });

  it('puts a computer that was asleep back to sleep when waking it fails', async () => {
    const { fake, client } = setup();
    await client.ensure(SPEC);
    await client.stop(NAME);
    fake.answer = (call) => (call.kind === 'egress' ? { exitCode: 1, stderr: 'nft: command not found' } : {});
    const error = await rejection(client.ensure(SPEC));
    expect(error.message).toContain("Applying the computer's network rules failed (exit 1): nft: command not found");
    expect([...fake.sandboxes.values()].map((sandbox) => sandbox.state)).toEqual(['paused']);
  });

  it('rewrites the bridge secrets once when a bridge refuses them, then runs the command', async () => {
    const { fake, client } = setup();
    await client.ensure(SPEC);
    bridges.setSecret(bridges.agent, 'stale'.repeat(10));
    const result = await client.exec(NAME, { argv: ['echo', 'again'], user: 'agent', cwd: '/', timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'again\n' });
    expect(fake.kinds().at(-1)).toBe('secrets');
  });

  it('says why a command could not run when the computer was paused behind its back', async () => {
    const { fake, client } = setup();
    await client.ensure(SPEC);
    for (const sandbox of fake.sandboxes.values()) sandbox.state = 'paused';
    const error = await rejection(client.exec(NAME, { argv: ['true'], user: 'agent', cwd: '/', timeoutMs: 5_000 }));
    expect(error.message).toBe('The computer is not running.');
    expect(error.statusCode).toBe(409);
  });

  it('keeps every request on its domain, even when the provider names another one', async () => {
    const { fake, client, seen } = setup();
    fake.sandboxDomain = 'evil.example';
    const error = await rejection(client.ensure(SPEC));
    expect(error).toBeInstanceOf(EndpointViolation);
    expect(fake.requests.every((request) => request.url.hostname.endsWith('.e2b.test'))).toBe(true);
    expect(seen).toEqual([]);
    expect(fake.sandboxes.size).toBe(0);
  });

  it('maps provider errors to short messages that never repeat the key', async () => {
    const { client, apiKey } = setup();
    const refused = createE2bSandbox(e2bConfigSchema.parse({ domain: 'e2b.test', template: 't' }), `${apiKey}-wrong`, {
      fetch: pinnedFetch(e2bEndpoints({ domain: 'e2b.test' }), new FakeE2b(apiKey, bridges).fetch),
    });
    const auth = await rejection(refused.status(NAME));
    expect(auth.statusCode).toBe(401);
    expect(auth.message).toContain('Check the API key');
    expect(auth.message).not.toContain(apiKey);

    const down = new FakeE2b(apiKey, bridges);
    down.unreachable = true;
    const offline = createE2bSandbox(e2bConfigSchema.parse({ domain: 'e2b.test', template: 't' }), apiKey, {
      fetch: pinnedFetch(e2bEndpoints({ domain: 'e2b.test' }), down.fetch),
    });
    expect((await rejection(offline.ensure(SPEC))).message).toContain('could not reach api.e2b.test (ECONNREFUSED)');
    await expect(client.exec('Not A Name', { argv: ['true'], user: 'agent', timeoutMs: 1_000 })).rejects.toThrow(
      'Invalid computer name',
    );
  });

  it('renews the provider’s timeout while a computer is used, at most every five minutes', async () => {
    const clock = { now: Date.parse('2026-10-14T08:00:00Z') };
    const { fake, client } = setup({ timeoutMinutes: 45 }, clock);
    await client.ensure(SPEC);
    await client.status(NAME);
    expect(fake.timeouts).toEqual([]);
    clock.now += 6 * 60_000;
    await client.status(NAME);
    await client.status(NAME);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.timeouts).toEqual([{ id: expect.any(String), seconds: 45 * 60 }]);
  });

  it('checks the key and the template without starting a computer', async () => {
    const { fake, client } = setup();
    await e2bAdapter.test!(client, e2bConfigSchema.parse({ template: 'gh-computer-abc' }));
    fake.templates = [{ templateID: 'tpl2', names: ['gh-computer-abc'], buildID: '', buildStatus: 'building' }];
    await expect(e2bAdapter.test!(client, e2bConfigSchema.parse({ template: 'x' }))).rejects.toThrow(
      'has no finished build yet (building)',
    );
    fake.templates = [];
    await expect(e2bAdapter.test!(client, e2bConfigSchema.parse({ template: 'x' }))).rejects.toThrow(
      'There is no template "gh-computer-abc" at e2b.test',
    );
    expect(fake.creates).toEqual([]);
  });
});
