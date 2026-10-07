import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, users, cancelBotTasksForUser } = vi.hoisted(() => ({
  /** bot_computers rows, by user (empty unless a test seeds one). */
  rows: new Map<string, Record<string, unknown>>(),
  /** users rows, by id (empty unless a test seeds one). */
  users: new Map<string, Record<string, unknown>>(),
  cancelBotTasksForUser: vi.fn(async () => 0),
}));

vi.mock('@greenhouse/db', () => ({
  getDb: () => ({
    botComputers: {
      list: async () => [...rows.values()],
      listByStates: async (states: string[]) => [...rows.values()].filter((r) => states.includes(String(r.state))),
      get: async (userId: string) => rows.get(userId),
      withUserLock: async <T>(_userId: string, fn: () => Promise<T>) => await fn(),
      transition: async (userId: string, version: number, from: string[], patch: Record<string, unknown>) => {
        const row = rows.get(userId);
        if (!row || row.version !== version || !from.includes(String(row.state))) return undefined;
        const next = { ...row, ...patch, version: version + 1 };
        rows.set(userId, next);
        return next;
      },
      delete: async (userId: string) => void rows.delete(userId),
    },
    users: { getById: async (id: string) => users.get(id) },
  }),
}));
vi.mock('../engine/index.js', () => ({ cancelBotTasksForUser }));
vi.mock('../../auth/features.js', () => ({ userHasFeature: async () => true }));
vi.mock('../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));
vi.mock('../../settings/workspace-config.js', () => ({ getWorkspaceValue: async () => undefined }));

import type { BotsComputerConfig } from './config.js';
import { ComputerRuntimeError, type DockerClient, type ImageInfo, type NetworkInfo } from './docker.js';
import {
  _setComputerRuntimeForTests,
  adminComputersView,
  botsComputerHealthView,
  computerNamespace,
  computerStatusFor,
  type EgressCheck,
  getComputerRuntime,
  IMAGE_CONTRACT,
  initBotComputers,
  requireComputerRuntime,
  runComputerPrechecks,
  purgeUserComputer,
  shutdownBotComputers,
} from './runtime.js';

const config: BotsComputerConfig = {
  image: 'greenhouse/bot-computer:latest',
  runtime: 'runsc',
  hardened: true,
  network: 'gh-bots',
  networkManaged: false,
  memory: '2g',
  memoryBytes: 2 * 1024 ** 3,
  cpus: '1.5',
  proxy: null,
  namespace: 'ns1',
  timezone: 'UTC',
  lang: null,
  jobMaxHours: 8,
  missionNetwork: 'cloud-agent',
};

const goodImage: ImageInfo = {
  id: 'sha256:0123456789abcdef0123',
  labels: { 'greenhouse.bots.computer.contract': IMAGE_CONTRACT, 'greenhouse.bots.computer.chromium': '154.0.1.2' },
  created: new Date().toISOString(),
};
const goodNetwork: NetworkInfo = {
  name: 'gh-bots',
  driver: 'bridge',
  ipv6: false,
  icc: false,
  internal: false,
  gateways: ['172.30.0.1'],
};

function fakeClient(overrides: Partial<DockerClient> = {}): DockerClient {
  return {
    version: async () => '29.4.0',
    info: async () => ({ memTotal: 16 * 1024 ** 3, runtimes: ['runc', 'runsc'] }),
    imageInspect: async () => goodImage,
    networkInspect: async () => goodNetwork,
    networkCreate: async () => {},
    volumeCreate: async () => {},
    volumeRemove: async () => {},
    volumeList: async () => [],
    volumeCreatedAt: async () => null,
    run: async () => 'id',
    stop: async () => {},
    remove: async () => {},
    inspectState: async () => null,
    ps: async () => [],
    memoryUsage: async () => new Map(),
    exec: async () => {
      throw new Error('unused');
    },
    execStream: () => {
      throw new Error('unused');
    },
    ...overrides,
  };
}

const egressOk: EgressCheck = async () => ({ ok: true, detail: 'verified all greenhouse-bots-computer rules' });

describe('computer prechecks', () => {
  it('passes a healthy hardened host and reports what it checked', async () => {
    const egressCheck = vi.fn(egressOk);
    const result = await runComputerPrechecks(fakeClient(), config, { egressCheck });
    expect(result.ok).toBe(true);
    expect(egressCheck).toHaveBeenCalledWith(config);
    expect(result.gateways).toEqual(['172.30.0.1']);
    expect(result.memTotal).toBe(16 * 1024 ** 3);
    expect(result.checks.map((c) => [c.id, c.ok])).toEqual([
      ['docker', true],
      ['runtime', true],
      ['image', true],
      ['image_fresh', true],
      ['network', true],
      ['egress', true],
    ]);
    expect(result.checks.find((c) => c.id === 'image')?.detail).toContain('Chromium 154.0.1.2');
  });

  it('speaks image contract 2, and shows the packages an operator baked in', async () => {
    expect(IMAGE_CONTRACT).toBe('2');
    const old = await runComputerPrechecks(
      fakeClient({
        imageInspect: async () => ({ ...goodImage, labels: { 'greenhouse.bots.computer.contract': '1' } }),
      }),
      config,
      { egressCheck: egressOk },
    );
    expect(old).toMatchObject({ ok: false, reason: 'image_outdated' });
    expect(old.checks.find((c) => c.id === 'image')?.detail).toMatch(/contract 1; this API needs 2/);

    const extra = await runComputerPrechecks(
      fakeClient({
        imageInspect: async () => ({
          ...goodImage,
          labels: { ...goodImage.labels, 'greenhouse.bots.computer.extra-packages': ' libreoffice-writer\tgimp ' },
        }),
      }),
      config,
      { egressCheck: egressOk },
    );
    expect(extra.checks.find((c) => c.id === 'image')?.detail).toMatch(
      /Chromium 154\.0\.1\.2 · extra packages: libreoffice-writer gimp$/,
    );
    const plain = await runComputerPrechecks(
      fakeClient({
        imageInspect: async () => ({
          ...goodImage,
          labels: { ...goodImage.labels, 'greenhouse.bots.computer.extra-packages': '' },
        }),
      }),
      config,
      { egressCheck: egressOk },
    );
    expect(plain.checks.find((c) => c.id === 'image')?.detail).not.toContain('extra packages');
  });

  it('names the missing piece and how to fix it', async () => {
    const cases: Array<[Partial<DockerClient>, string, RegExp]> = [
      [
        {
          version: async () => {
            throw new ComputerRuntimeError('docker_cli_missing', 'The docker CLI is not installed on the API host');
          },
        },
        'docker_cli_missing',
        /Docker CLI/,
      ],
      [
        {
          version: async () => {
            throw new ComputerRuntimeError('docker_unreachable', 'Cannot connect to the Docker daemon');
          },
        },
        'docker_unreachable',
        /docker ps/,
      ],
      [{ info: async () => ({ memTotal: 1, runtimes: ['runc'] }) }, 'runtime_missing', /gVisor/],
      [{ imageInspect: async () => null }, 'image_missing', /build-bot-computer\.sh/],
      [{ imageInspect: async () => ({ ...goodImage, labels: {} }) }, 'image_outdated', /build-bot-computer\.sh/],
      [{ networkInspect: async () => null }, 'network_invalid', /docker network create/],
      [{ networkInspect: async () => ({ ...goodNetwork, icc: true }) }, 'network_invalid', /enable_icc=false/],
      [{ networkInspect: async () => ({ ...goodNetwork, ipv6: true }) }, 'network_invalid', /enable_icc=false/],
    ];
    for (const [overrides, reason, fix] of cases) {
      const result = await runComputerPrechecks(fakeClient(overrides), config, { egressCheck: egressOk });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe(reason);
      const failing = result.checks.find((c) => !c.ok)!;
      expect(failing.fix).toMatch(fix);
    }
  });

  it('keeps a hardened host closed until the egress rules are verified (ICC off is not enough)', async () => {
    const result = await runComputerPrechecks(fakeClient(), config, {
      egressCheck: async () => ({
        ok: false,
        detail: 'DOCKER-USER must enter GREENHOUSE-BOTS-FWD as its first effective rule',
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('network_invalid');
    const egress = result.checks.find((c) => c.id === 'egress')!;
    expect(egress.ok).toBe(false);
    expect(egress.detail).toMatch(/GREENHOUSE-BOTS-FWD/);
    expect(egress.fix).toContain('sudo BOTS_COMPUTER_NETWORK=gh-bots bash scripts/cloud-agent-net.sh --profile bots');
    expect(egress.fix).toMatch(/systemd/);

    // A crashing check fails closed too, and the network fix names both steps.
    const crashed = await runComputerPrechecks(fakeClient(), config, {
      egressCheck: async () => {
        throw new Error('bash: not found');
      },
    });
    expect(crashed).toMatchObject({ ok: false, reason: 'network_invalid' });
    const missing = await runComputerPrechecks(fakeClient({ networkInspect: async () => null }), config);
    const fix = missing.checks.find((c) => c.id === 'network')!.fix!;
    expect(fix).toMatch(/docker network create --driver bridge --ipv6=false/);
    expect(fix).toMatch(/--profile bots/);
  });

  it('creates the development bridge itself, and warns about an old image without failing', async () => {
    let created: string | null = null;
    let exists = false;
    const client = fakeClient({
      networkInspect: async () => (exists ? goodNetwork : null),
      networkCreate: async (name) => {
        created = name;
        exists = true;
      },
      imageInspect: async () => ({ ...goodImage, created: '2026-01-01T00:00:00Z' }),
    });
    const result = await runComputerPrechecks(client, {
      ...config,
      hardened: false,
      runtime: 'runc',
      networkManaged: true,
    });
    expect(result.ok).toBe(true);
    expect(created).toBe('gh-bots');
    // Development mode never runs the iptables check; it only says so.
    expect(result.checks.find((c) => c.id === 'egress')).toMatchObject({ ok: true, detail: /Not enforced/ });
    const fresh = result.checks.find((c) => c.id === 'image_fresh')!;
    expect(fresh.ok).toBe(false);
    expect(fresh.fix).toMatch(/build-bot-computer/);
  });
});

describe('computer runtime state', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
    _setComputerRuntimeForTests({ reset: true });
  });

  afterEach(async () => {
    await shutdownBotComputers();
    _setComputerRuntimeForTests({ reset: true });
    vi.useRealTimers();
    process.env = { ...saved };
    rows.clear();
  });

  async function readyDevRuntime(client: DockerClient): Promise<void> {
    Object.assign(process.env, {
      BOTS_COMPUTER_ENABLED: '1',
      BOTS_COMPUTER_ALLOW_UNHARDENED: '1',
      BOTS_COMPUTER_RUNTIME: 'runc',
      BOTS_COMPUTER_NAMESPACE: 'purge',
    });
    _setComputerRuntimeForTests({ docker: client });
    await initBotComputers();
    expect(getComputerRuntime().state).toBe('ready');
  }

  it('revocations never fail on Docker (reconcile clears it later) and cancel background tasks; an admin wipe stays strict', async () => {
    const client = fakeClient({
      volumeRemove: async () => {
        throw new ComputerRuntimeError('docker_unreachable', 'Cannot connect to the Docker daemon');
      },
    });
    await readyDevRuntime(client);
    rows.set('leaver', {
      user_id: 'leaver',
      state: 'running',
      state_reason: null,
      version: 3,
      container_name: 'gh-computer-purge-leaver',
      volume_name: 'gh-computer-purge-leaver-home',
      updated_at: new Date().toISOString(),
    });
    await expect(purgeUserComputer('leaver', { wipe: true, reason: 'admin' })).resolves.toBeUndefined();
    expect(cancelBotTasksForUser).toHaveBeenCalledWith(expect.anything(), 'leaver');
    expect(rows.get('leaver')).toMatchObject({ state: 'absent' }); // stopped; the volume waits for reconcile

    cancelBotTasksForUser.mockClear();
    await expect(purgeUserComputer('leaver', { wipe: true, reason: 'reset' })).rejects.toBeInstanceOf(
      ComputerRuntimeError,
    );
    expect(cancelBotTasksForUser).not.toHaveBeenCalled(); // a reset is not a revocation
  });

  it('reports the Docker disk as the host_disk check: not measured yet, then what a running computer reads', async () => {
    const client = fakeClient({
      ps: async () => [{ id: 'id-1', name: 'gh-computer-purge-u1', state: 'running', status: 'Up', labels: {} }],
      exec: async (spec) => ({
        code: 0,
        signal: null,
        stdout: Buffer.from(
          spec.argv[0] === 'df'
            ? 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1000000 930000 70000 93% /home/agent\n'
            : '',
        ),
        stderr: '',
        stdoutTruncated: false,
        timedOut: false,
        aborted: false,
      }),
    });
    await readyDevRuntime(client);
    const hostDisk = async () => (await adminComputersView()).checks.find((c) => c.id === 'host_disk');
    expect(await hostDisk()).toEqual({ id: 'host_disk', ok: true, detail: 'not measured yet' });

    rows.set('u1', {
      user_id: 'u1',
      state: 'running',
      state_reason: null,
      version: 1,
      container_name: 'gh-computer-purge-u1',
      volume_name: 'gh-computer-purge-u1-home',
      disk_bytes: null,
      updated_at: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(30_000); // the health loop reads it from the running computer
    expect(await hostDisk()).toEqual({
      id: 'host_disk',
      ok: false,
      detail: '7% free on the Docker disk',
      fix: expect.stringContaining('docker image prune'),
    });
  });

  it('reports the member’s stored timezone and effective browser language in the status', async () => {
    users.set('zh-member', { id: 'zh-member', locale: 'zh-CN' });
    rows.set('zh-member', {
      user_id: 'zh-member',
      state: 'absent',
      timezone: 'Asia/Shanghai',
      lease_controller: 'bot',
    });
    users.set('en-member', { id: 'en-member', locale: 'en' });
    try {
      expect(await computerStatusFor('zh-member')).toMatchObject({ timezone: 'Asia/Shanghai', lang: 'zh-CN' });
      expect(await computerStatusFor('en-member')).toMatchObject({ state: 'absent', timezone: null, lang: 'en-US' });
      expect(computerNamespace()).toBeNull(); // computers off: nothing to write a timezone into

      // The operator's BOTS_COMPUTER_LANG wins over every member's locale.
      Object.assign(process.env, { BOTS_COMPUTER_LANG: 'ja-JP' });
      await readyDevRuntime(fakeClient());
      expect(await computerStatusFor('zh-member')).toMatchObject({ lang: 'ja-JP' });
      expect(computerNamespace()).toBe('purge');
    } finally {
      users.clear();
    }
  });

  it('is disabled without BOTS_COMPUTER_ENABLED and says so to callers', async () => {
    delete process.env.BOTS_COMPUTER_ENABLED;
    await initBotComputers();
    expect(getComputerRuntime().state).toBe('disabled');
    expect(botsComputerHealthView()).toEqual({ state: 'disabled' });
    expect(() => requireComputerRuntime()).toThrow(expect.objectContaining({ code: 'disabled' }));
  });

  it('reports a config error as unavailable with its reason', async () => {
    process.env.BOTS_COMPUTER_ENABLED = '1';
    process.env.BOTS_COMPUTER_RUNTIME = 'runc';
    delete process.env.BOTS_COMPUTER_ALLOW_UNHARDENED;
    await initBotComputers();
    expect(getComputerRuntime()).toEqual({ state: 'unavailable', reason: 'runtime_not_hardened', hardened: true });
    expect(botsComputerHealthView()).toEqual({ state: 'unavailable', reason: 'runtime_not_hardened' });
  });

  it('heals by itself once the host is fixed (re-checks every 60 s, no restart)', async () => {
    Object.assign(process.env, {
      BOTS_COMPUTER_ENABLED: '1',
      BOTS_COMPUTER_ALLOW_UNHARDENED: '1',
      BOTS_COMPUTER_RUNTIME: 'runc',
      BOTS_COMPUTER_NAMESPACE: 'heal',
    });
    let image: ImageInfo | null = null;
    _setComputerRuntimeForTests({ docker: fakeClient({ imageInspect: async () => image }) });
    await initBotComputers();
    expect(getComputerRuntime()).toMatchObject({ state: 'unavailable', reason: 'image_missing', hardened: false });
    expect(() => requireComputerRuntime()).toThrow(expect.objectContaining({ code: 'unavailable' }));

    image = goodImage; // the operator ran scripts/build-bot-computer.sh
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getComputerRuntime()).toEqual({ state: 'ready', reason: null, hardened: false });
    expect(requireComputerRuntime().config.namespace).toBe('heal');
    // /health: capacity, no paths or user ids.
    expect(botsComputerHealthView()).toEqual({ state: 'ready', running: 0, max_running: 2 });
  });

  it('opens a hardened host only once its egress rules verify, and closes it again if they vanish', async () => {
    Object.assign(process.env, {
      BOTS_COMPUTER_ENABLED: '1',
      BOTS_COMPUTER_NETWORK: 'gh-bots',
      BOTS_COMPUTER_NAMESPACE: 'hard',
    });
    delete process.env.BOTS_COMPUTER_ALLOW_UNHARDENED;
    delete process.env.BOTS_COMPUTER_RUNTIME;
    let rules = false;
    _setComputerRuntimeForTests({
      docker: fakeClient(),
      egressCheck: async () => (rules ? { ok: true, detail: 'verified' } : { ok: false, detail: 'no anchor' }),
    });
    await initBotComputers();
    expect(getComputerRuntime()).toEqual({ state: 'unavailable', reason: 'network_invalid', hardened: true });

    rules = true; // the admin ran the --profile bots command
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getComputerRuntime()).toEqual({ state: 'ready', reason: null, hardened: true });

    rules = false; // a firewall reload flushed them: the 10-minute re-verification closes the host
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(getComputerRuntime()).toEqual({ state: 'unavailable', reason: 'network_invalid', hardened: true });
    expect((await adminComputersView()).checks.find((c) => c.id === 'egress')).toMatchObject({ ok: false });
  });
});
