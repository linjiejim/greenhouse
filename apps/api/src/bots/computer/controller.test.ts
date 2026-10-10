/**
 * Computer lifecycle against an in-memory store (same CAS semantics as
 * db.botComputers), a fake Docker and a fake clock. The real-DB concurrency
 * guarantees are in tests/db/bot-computer-capacity.db-commit.test.ts.
 */

import { describe, expect, it } from 'vitest';
import type { BotComputerRow, BotComputerState } from '@greenhouse/db';

import type { BotsComputerConfig } from './config.js';
import {
  createComputerController,
  DISK_SOFT_LIMIT_BYTES,
  HOST_DISK_READING_TTL_MS,
  parseDfOutput,
  START_DEADLINE_MS,
  type Clock,
  type ComputerStore,
  type ControllerEnvironment,
  type HostDiskReading,
  type TryLockResult,
} from './controller.js';
import {
  ComputerDockerError,
  ComputerRuntimeError,
  type ContainerState,
  type ContainerSummary,
  type DockerClient,
  type DockerSpawnResult,
  type ExecSpec,
} from './docker.js';
import { createDockerHost } from './docker-host.js';
import { ComputerStartError, type ComputerStartSpec } from './host.js';
import { ComputerUnavailableError } from './errors.js';
import { computerContainerName, computerVolumeName, LABEL_NAMESPACE, LABEL_USER } from './namespace.js';

const NS = 'testns';
const T0 = Date.parse('2026-10-05T08:00:00.000Z');

// ─── Fakes ────────────────────────────────────────────────

class FakeClock implements Clock {
  ms = T0;
  sleeps = 0;
  onSleep: ((n: number) => Promise<void> | void) | null = null;
  now() {
    return this.ms;
  }
  async sleep(ms: number) {
    this.sleeps++;
    this.ms += ms;
    await this.onSleep?.(this.sleeps);
    await Promise.resolve();
  }
  iso(offsetMs = 0) {
    return new Date(this.ms + offsetMs).toISOString();
  }
}

class FakeStore implements ComputerStore {
  rows = new Map<string, BotComputerRow>();
  /** Member locks held by "another process" (try-lock fails, nothing waits on them in these tests). */
  heldLocks = new Set<string>();
  /** Runs when a lock is granted, before `fn` (simulates work another slot did meanwhile). */
  onLock: ((userId: string) => void) | null = null;
  /** In-process member locks, so concurrent calls serialise like pg_advisory_xact_lock. */
  private tails = new Map<string, Promise<unknown>>();
  constructor(
    private clock: FakeClock,
    opts: { tryLock?: boolean } = {},
  ) {
    if (opts.tryLock === false) delete (this as Partial<FakeStore>).tryWithUserLock;
  }

  seed(userId: string, patch: Partial<BotComputerRow>): BotComputerRow {
    const now = this.clock.iso();
    const row: BotComputerRow = {
      user_id: userId,
      namespace: NS,
      container_name: computerContainerName(NS, userId),
      volume_name: computerVolumeName(NS, userId),
      state: 'absent',
      state_reason: null,
      version: 0,
      lease_controller: 'bot',
      lease_epoch: 0,
      lease_since: null,
      viewer_heartbeat_at: null,
      last_active_at: now,
      last_started_at: null,
      image_id: null,
      disk_bytes: null,
      disk_measured_at: null,
      timezone: null,
      created_at: now,
      updated_at: now,
      ...patch,
    };
    this.rows.set(userId, row);
    return row;
  }

  get = async (userId: string) => (this.rows.has(userId) ? { ...this.rows.get(userId)! } : undefined);
  ensure: ComputerStore['ensure'] = async (identity) => {
    if (!this.rows.has(identity.user_id)) this.seed(identity.user_id, identity);
    return { ...this.rows.get(identity.user_id)! };
  };
  list = async () => [...this.rows.values()].map((r) => ({ ...r }));
  listByStates = async (states: BotComputerState[]) =>
    [...this.rows.values()].filter((r) => states.includes(r.state)).map((r) => ({ ...r }));
  countRunning = async () => (await this.listByStates(['starting', 'running'])).length;
  transition: ComputerStore['transition'] = async (userId, expectedVersion, from, patch) => {
    const row = this.rows.get(userId);
    if (!row || row.version !== expectedVersion || !from.includes(row.state)) return undefined;
    const next = { ...row, ...patch, version: row.version + 1, updated_at: this.clock.iso() };
    this.rows.set(userId, next);
    return { ...next };
  };
  touch = async (userId: string) => {
    const row = this.rows.get(userId);
    if (row) row.last_active_at = this.clock.iso();
  };
  listIdle = async (cutoffIso: string) => {
    const cutoff = Date.parse(cutoffIso);
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.state === 'running' &&
          r.lease_controller === 'bot' &&
          Date.parse(r.last_active_at) < cutoff &&
          (!r.viewer_heartbeat_at || Date.parse(r.viewer_heartbeat_at) < cutoff),
      )
      .sort((a, b) => Date.parse(a.last_active_at) - Date.parse(b.last_active_at))
      .map((r) => ({ ...r }));
  };
  setDisk = async (userId: string, bytes: number) => {
    const row = this.rows.get(userId);
    if (row) {
      row.disk_bytes = bytes;
      row.disk_measured_at = this.clock.iso();
    }
  };
  delete = async (userId: string) => {
    this.rows.delete(userId);
  };
  withUserLock = async <T>(userId: string, fn: () => Promise<T>): Promise<T> => {
    const previous = this.tails.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.tails.set(userId, tail);
    try {
      await previous.catch(() => {});
      this.onLock?.(userId);
      return await fn();
    } finally {
      release();
      if (this.tails.get(userId) === tail) this.tails.delete(userId);
    }
  };
  tryWithUserLock? = async <T>(userId: string, fn: () => Promise<T>): Promise<TryLockResult<T>> => {
    if (this.heldLocks.has(userId) || this.tails.has(userId)) return { acquired: false };
    return { acquired: true, value: await this.withUserLock(userId, fn) };
  };
  withCapacityLock = async <T>(fn: () => Promise<T>) => await fn();
}

interface FakeContainer {
  state: 'running' | 'exited' | 'created';
  exitCode: number;
  oom: boolean;
  labels: Record<string, string>;
  args: string[];
}

function ok(partial: Partial<DockerSpawnResult> = {}): DockerSpawnResult {
  return {
    code: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: '',
    stdoutTruncated: false,
    timedOut: false,
    aborted: false,
    ...partial,
  };
}

class FakeDocker {
  containers = new Map<string, FakeContainer>();
  volumes = new Map<string, { labels: Record<string, string>; createdAt: string }>();
  runFailure: Error | null = null;
  readyAfterProbes = 0;
  probes = 0;
  du: Record<string, number> = { '/home/agent': 1000, '/home/browser': 2000 };
  /** `df -P -k /home/agent` output (null = df prints nothing useful). */
  df: string | null = null;
  dfCalls = 0;
  /** curl exit code per probed URL (default 7 = refused, i.e. blocked). */
  egress: Record<string, number> = {};
  onStop: ((name: string) => void) | null = null;
  log: string[] = [];

  constructor(private clock: FakeClock) {}

  client(): DockerClient {
    const labelsOf = (args: string[]) =>
      Object.fromEntries(
        args.flatMap((a, i) => (args[i - 1] === '--label' ? [a.split('=') as [string, string]] : [])),
      ) as Record<string, string>;
    return {
      version: async () => '29.0.0',
      info: async () => ({ memTotal: 16 * 1024 ** 3, runtimes: ['runc', 'runsc'] }),
      imageInspect: async () => ({ id: 'sha256:img', labels: {}, created: '' }),
      networkInspect: async () => null,
      networkCreate: async () => {},
      volumeCreate: async (name, labels) => {
        this.log.push(`volume create ${name}`);
        if (!this.volumes.has(name)) this.volumes.set(name, { labels, createdAt: this.clock.iso() });
      },
      volumeRemove: async (name) => {
        const mounted = [...this.containers.values()].some((c) => c.args.includes(`${name}:/home`));
        if (mounted) throw new ComputerDockerError('failed', `volume ${name} is in use`);
        this.log.push(`volume rm ${name}`);
        this.volumes.delete(name);
      },
      volumeList: async (filter) => {
        const [key, value] = filter.split('=');
        return [...this.volumes.entries()]
          .filter(([, v]) => v.labels[key!] === value)
          .map(([name, v]) => ({ name, labels: v.labels }));
      },
      volumeCreatedAt: async (name) => this.volumes.get(name)?.createdAt ?? null,
      run: async (args) => {
        if (this.runFailure) throw this.runFailure;
        const name = args[args.indexOf('--name') + 1]!;
        if (this.containers.has(name)) throw new ComputerDockerError('conflict', 'name in use');
        this.log.push(`run ${name}`);
        this.containers.set(name, { state: 'running', exitCode: 0, oom: false, labels: labelsOf(args), args });
        return `id-${name}`;
      },
      stop: async (name) => {
        this.log.push(`stop ${name}`);
        this.onStop?.(name);
        const c = this.containers.get(name);
        if (c) c.state = 'exited';
      },
      remove: async (name) => {
        if (this.containers.delete(name)) this.log.push(`rm ${name}`);
      },
      inspectState: async (name): Promise<ContainerState | null> => {
        const c = this.containers.get(name);
        return c ? { running: c.state === 'running', status: c.state, exitCode: c.exitCode, oomKilled: c.oom } : null;
      },
      ps: async (filter): Promise<ContainerSummary[]> => {
        const [key, value] = filter.split('=');
        return [...this.containers.entries()]
          .filter(([, c]) => c.labels[key!] === value)
          .map(([name, c]) => ({ id: `id-${name}`, name, state: c.state, status: c.state, labels: c.labels }));
      },
      memoryUsage: async () => new Map(),
      exec: async (spec: ExecSpec) => {
        const c = this.containers.get(spec.container);
        if (!c) throw new ComputerDockerError('not_found', 'No such container');
        if (spec.argv[0] === 'python3') {
          this.probes++;
          if (this.probes <= this.readyAfterProbes) return ok({ code: 1, stderr: 'Connection refused' });
          return ok({ stdout: Buffer.from(JSON.stringify({ id: 1, result: { product: 'Chrome/154' } })) });
        }
        if (spec.argv[0] === 'du') return ok({ stdout: Buffer.from(`${this.du[spec.argv[2]!]}\t${spec.argv[2]}`) });
        if (spec.argv[0] === 'df') {
          this.dfCalls++;
          return ok({ stdout: Buffer.from(this.df ?? '') });
        }
        if (spec.argv[3] === 'gh-egress') {
          const urls = spec.argv.slice(4);
          this.log.push(`egress probe ${urls.join(' ')}`);
          return ok({ stdout: Buffer.from(urls.map((u) => `${this.egress[u] ?? 7} ${u}\n`).join('')) });
        }
        return ok();
      },
      execStream: () => {
        throw new Error('not used');
      },
    };
  }
}

function setup(
  opts: {
    maxRunning?: number;
    idleMinutes?: number;
    active?: (userId: string) => boolean | null;
    awaitingHuman?: (userId: string) => boolean;
    tryLock?: boolean;
    egressProbe?: string[];
    /** Account locale per member (unknown = null). */
    locale?: (userId: string) => string | null;
    /** Running background jobs per container (the gh-jobs count); throwing = the computer did not answer. */
    runningJobs?: (container: string) => number;
    /** An error the host's start throws instead of starting (null = start normally). */
    startError?: () => Error | null;
    operatorLang?: string | null;
    jobMaxHours?: number;
  } = {},
) {
  const clock = new FakeClock();
  const store = new FakeStore(clock, { tryLock: opts.tryLock });
  const docker = new FakeDocker(clock);
  const config = {
    driver: 'docker',
    e2b: null,
    image: 'greenhouse/bot-computer:latest',
    runtime: 'runsc',
    hardened: true,
    network: 'gh-bots',
    networkManaged: false,
    memory: '2g',
    memoryBytes: 2 * 1024 ** 3,
    cpus: '1.5',
    proxy: null,
    namespace: NS,
    timezone: 'UTC',
    lang: opts.operatorLang ?? null,
    jobMaxHours: opts.jobMaxHours ?? 8,
    missionNetwork: 'cloud-agent',
  } satisfies BotsComputerConfig;
  const env: ControllerEnvironment = {
    config,
    maxRunning: opts.maxRunning ?? 2,
    idleMinutes: opts.idleMinutes ?? 15,
    urlBlocklist: ['green.example.com'],
    imageId: 'sha256:img',
    egressProbe: opts.egressProbe,
  };
  const events = {
    states: [] as Array<[string, string, string | null]>,
    stopped: [] as Array<[string, string]>,
    runtimeErrors: [] as ComputerRuntimeError[],
    hostDisk: [] as HostDiskReading[],
  };
  // Every start the host is asked for, with what the controller handed it.
  const starts: ComputerStartSpec[] = [];
  const dockerHost = createDockerHost(docker.client(), { now: () => clock.now() });
  const controller = createComputerController({
    store,
    host: {
      ...dockerHost,
      start: (row, spec) => {
        starts.push(spec);
        const failure = opts.startError?.();
        if (failure) return Promise.reject(failure);
        return dockerHost.start(row, spec);
      },
    },
    environment: async () => env,
    userIsActive: async (userId) => (opts.active ? opts.active(userId) : true),
    awaitingHuman: async (userId) => opts.awaitingHuman?.(userId) ?? false,
    memberLocale: async (userId) => opts.locale?.(userId) ?? null,
    ...(opts.runningJobs ? { runningJobs: async (container: string) => opts.runningJobs!(container) } : {}),
    clock,
    onState: (row) => events.states.push([row.user_id, row.state, row.state_reason]),
    onStopped: (userId, reason) => events.stopped.push([userId, reason]),
    onRuntimeError: (err) => events.runtimeErrors.push(err),
    // Like the runtime: keep the latest reading, which the next start decides on.
    onHostDisk: (reading) => {
      events.hostDisk.push(reading);
      env.hostDisk = reading;
    },
  });
  return { clock, store, docker, controller, env, events, starts };
}

const MIN = 60_000;

// ─── Tests ────────────────────────────────────────────────

describe('computer lifecycle', () => {
  it('starts a computer with the current argv, a labelled volume and a ready browser', async () => {
    const { controller, store, docker, events } = setup();
    docker.readyAfterProbes = 2;
    const row = await controller.ensureRunning('u1');
    expect(row.state).toBe('running');
    expect(row.image_id).toBe('sha256:img');
    expect(row.last_started_at).not.toBeNull();
    const container = docker.containers.get(computerContainerName(NS, 'u1'))!;
    expect(container.labels).toMatchObject({ [LABEL_NAMESPACE]: NS, [LABEL_USER]: 'u1' });
    expect(container.args).toContain('runsc');
    expect(container.args).toContain('GH_COMPUTER_URL_BLOCKLIST=green.example.com');
    expect(docker.volumes.get(computerVolumeName(NS, 'u1'))?.labels).toMatchObject({ [LABEL_USER]: 'u1' });
    expect(docker.probes).toBe(3);
    expect(events.states.map(([, state]) => state)).toEqual(['starting', 'running']);
    expect((await store.get('u1'))?.version).toBe(2);

    // Running already: no second docker run.
    await controller.ensureRunning('u1');
    expect(docker.log.filter((l) => l.startsWith('run'))).toHaveLength(1);
  });

  it('tells the host a reset is one (everything but the files starts over), and nothing else is', async () => {
    const { controller, store, starts } = setup();
    await controller.ensureRunning('u1');
    await controller.stop('u1', 'idle');
    await controller.ensureRunning('u1');
    await controller.reset('u1', { wipe: false });
    expect(starts.map((spec) => spec.fresh)).toEqual([false, false, true]);
    // The intent is spent: the start after it is an ordinary one.
    await controller.stop('u1', 'user');
    await controller.ensureRunning('u1');
    expect(starts.at(-1)?.fresh).toBe(false);
    expect((await store.get('u1'))?.state).toBe('running');
  });

  it('evicts the least recently used idle computer when full', async () => {
    const { controller, store, docker, clock, events } = setup({ maxRunning: 2 });
    await controller.ensureRunning('old');
    clock.ms += 10 * MIN;
    await controller.ensureRunning('recent');
    clock.ms += 5 * MIN; // both idle ≥ 2 min; "old" idles longest
    await controller.ensureRunning('new');
    expect(await store.get('old')).toMatchObject({ state: 'absent', state_reason: 'lru' });
    expect((await store.get('recent'))?.state).toBe('running');
    expect((await store.get('new'))?.state).toBe('running');
    expect(docker.containers.has(computerContainerName(NS, 'old'))).toBe(false);
    expect(docker.volumes.has(computerVolumeName(NS, 'old'))).toBe(true); // files kept
    expect(events.stopped).toContainEqual(['old', 'lru']);
  });

  it('never evicts a computer someone is using; the caller waits in line, then gets busy', async () => {
    const { controller, store, clock } = setup({ maxRunning: 1 });
    await controller.ensureRunning('busy-user');
    const positions: number[] = [];
    const started = clock.now();
    const error = await controller.ensureRunning('waiting', { onQueued: (p) => positions.push(p) }).catch((e) => e);
    expect(error).toBeInstanceOf(ComputerUnavailableError);
    expect(error.code).toBe('busy');
    expect(clock.now() - started).toBeGreaterThanOrEqual(45_000);
    expect(positions[0]).toBe(1);
    expect((await store.get('busy-user'))?.state).toBe('running');
    expect((await store.get('waiting'))?.state).toBe('absent');
  });

  it('protects computers with a live viewer or a member in control from eviction', async () => {
    const { controller, store, clock } = setup({ maxRunning: 2 });
    await controller.ensureRunning('watched');
    await controller.ensureRunning('controlled');
    clock.ms += 30 * MIN;
    store.rows.get('watched')!.viewer_heartbeat_at = clock.iso(-10_000);
    store.rows.get('controlled')!.lease_controller = 'user';
    const error = await controller.ensureRunning('third').catch((e) => e);
    expect(error.code).toBe('busy');
    expect((await store.get('watched'))?.state).toBe('running');
    expect((await store.get('controlled'))?.state).toBe('running');
  });

  it('starts a queued member as soon as a slot frees up', async () => {
    const { controller, store, clock } = setup({ maxRunning: 1 });
    await controller.ensureRunning('first');
    clock.onSleep = async (n) => {
      if (n === 3) await controller.stop('first', 'user');
    };
    const row = await controller.ensureRunning('second');
    expect(row.state).toBe('running');
    expect(await store.get('first')).toMatchObject({ state: 'absent', state_reason: 'user' });
  });

  it('stops idle computers, but not watched or taken-over ones', async () => {
    const { controller, store, clock, events } = setup({ idleMinutes: 15, maxRunning: 5 });
    for (const user of ['idle', 'watched', 'controlled']) await controller.ensureRunning(user);
    clock.ms += 20 * MIN;
    store.rows.get('watched')!.viewer_heartbeat_at = clock.iso(-20_000);
    store.rows.get('controlled')!.lease_controller = 'user';
    await controller.idleTick();
    expect(await store.get('idle')).toMatchObject({ state: 'absent', state_reason: 'idle' });
    expect((await store.get('watched'))?.state).toBe('running');
    expect((await store.get('controlled'))?.state).toBe('running');
    expect(events.stopped).toEqual([['idle', 'idle']]);

    // Recently used: not idle.
    await controller.ensureRunning('idle');
    clock.ms += 10 * MIN;
    await controller.idleTick();
    expect((await store.get('idle'))?.state).toBe('running');
  });

  it('starts each computer with its member’s browser language and timezone', async () => {
    const locales: Record<string, string> = { zh: 'zh-CN', 'zh-tw': 'zh-TW', en: 'en' };
    const { controller, store, docker } = setup({ maxRunning: 5, locale: (userId) => locales[userId] ?? null });
    const envOf = (userId: string) =>
      docker.containers.get(computerContainerName(NS, userId))!.args.filter((_, i, args) => args[i - 1] === '-e');

    store.seed('zh', { timezone: 'Asia/Shanghai' });
    await controller.ensureRunning('zh');
    expect(envOf('zh')).toEqual(expect.arrayContaining(['GH_COMPUTER_LANG=zh-CN', 'TZ=Asia/Shanghai']));

    await controller.ensureRunning('zh-tw'); // any Chinese locale; no timezone of its own → the deployment's
    expect(envOf('zh-tw')).toEqual(expect.arrayContaining(['GH_COMPUTER_LANG=zh-CN', 'TZ=UTC']));

    await controller.ensureRunning('en'); // everything else, unknown included
    await controller.ensureRunning('nobody');
    expect(envOf('en')).toContain('GH_COMPUTER_LANG=en-US');
    expect(envOf('nobody')).toContain('GH_COMPUTER_LANG=en-US');

    // A stored value that is not a zone never reaches TZ.
    store.seed('odd', { timezone: '+08:00' });
    await controller.ensureRunning('odd');
    expect(envOf('odd')).toContain('TZ=UTC');
  });

  it('lets the operator’s BOTS_COMPUTER_LANG override every member’s locale', async () => {
    const { controller, docker } = setup({ operatorLang: 'ja-JP', locale: () => 'zh-CN' });
    await controller.ensureRunning('u1');
    expect(docker.containers.get(computerContainerName(NS, 'u1'))!.args).toContain('GH_COMPUTER_LANG=ja-JP');
  });

  it('keeps an idle computer awake while background jobs run, for at most BOTS_COMPUTER_JOB_MAX_HOURS', async () => {
    const jobs = new Map<string, number>();
    const asked: string[] = [];
    const { controller, store, clock } = setup({
      idleMinutes: 15,
      maxRunning: 5,
      jobMaxHours: 8,
      runningJobs: (container) => {
        asked.push(container);
        return jobs.get(container) ?? 0;
      },
    });
    for (const user of ['busy', 'quiet']) await controller.ensureRunning(user);
    jobs.set(computerContainerName(NS, 'busy'), 2);
    clock.ms += 20 * MIN;
    await controller.idleTick();
    expect((await store.get('busy'))?.state).toBe('running');
    expect(await store.get('quiet')).toMatchObject({ state: 'absent', state_reason: 'idle' });

    // Hours later the job still runs, but nobody has touched the computer for 8 hours: it goes.
    clock.ms += 7 * 60 * MIN;
    await controller.idleTick();
    expect((await store.get('busy'))?.state).toBe('running');
    asked.length = 0;
    clock.ms += 60 * MIN;
    await controller.idleTick();
    expect(await store.get('busy')).toMatchObject({ state: 'absent', state_reason: 'idle' });
    expect(asked).toEqual([]); // past the limit the container is not even asked
  });

  it('does not stop a computer whose job list cannot be read — for a few rounds, not for ever', async () => {
    let answer: number | Error = new Error('the bridge did not answer');
    const { controller, store, clock } = setup({
      idleMinutes: 15,
      runningJobs: () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    await controller.ensureRunning('u1');
    clock.ms += 20 * MIN;
    await controller.idleTick();
    await controller.idleTick();
    expect((await store.get('u1'))?.state).toBe('running'); // no answer is not "no jobs"
    // An answer resets the count: two more unanswered rounds are again a reprieve.
    answer = 1;
    await controller.idleTick();
    answer = new Error('timed out');
    await controller.idleTick();
    await controller.idleTick();
    expect((await store.get('u1'))?.state).toBe('running');
    // The third unanswered round in a row: a computer that never answers is not kept for ever.
    await controller.idleTick();
    expect(await store.get('u1')).toMatchObject({ state: 'absent', state_reason: 'idle' });
  });

  it('never keeps a computer awake for jobs when BOTS_COMPUTER_JOB_MAX_HOURS is 0, and only asks idle ones', async () => {
    const asked: string[] = [];
    const off = setup({ idleMinutes: 15, jobMaxHours: 0, runningJobs: (c) => (asked.push(c), 3) });
    await off.controller.ensureRunning('u1');
    off.clock.ms += 20 * MIN;
    await off.controller.idleTick();
    expect(await off.store.get('u1')).toMatchObject({ state: 'absent', state_reason: 'idle' });
    expect(asked).toEqual([]);

    // A computer in use is never asked about jobs at all.
    const used = setup({ idleMinutes: 15, runningJobs: (c) => (asked.push(c), 3) });
    await used.controller.ensureRunning('u1');
    used.clock.ms += 5 * MIN;
    await used.controller.idleTick();
    expect(asked).toEqual([]);
  });

  it('notices OOM kills and exits on the health tick and rebuilds on next use', async () => {
    const { controller, store, docker, events } = setup({ maxRunning: 5 });
    for (const user of ['oom', 'gone', 'fine']) await controller.ensureRunning(user);
    const oom = docker.containers.get(computerContainerName(NS, 'oom'))!;
    oom.state = 'exited';
    oom.exitCode = 137;
    docker.containers.delete(computerContainerName(NS, 'gone'));
    await controller.healthTick();
    expect(await store.get('oom')).toMatchObject({ state: 'error', state_reason: 'oom' });
    expect(await store.get('gone')).toMatchObject({ state: 'error', state_reason: 'exited' });
    expect((await store.get('fine'))?.state).toBe('running');
    expect(docker.containers.has(computerContainerName(NS, 'oom'))).toBe(false);
    expect(events.stopped).toEqual([
      ['oom', 'oom'],
      ['gone', 'exited'],
    ]);
    expect(events.runtimeErrors).toEqual([]);
    expect((await controller.ensureRunning('oom')).state).toBe('running');
  });

  it('reconciles only its namespace: orphans, suspended members, stale transitions, old orphan volumes', async () => {
    const suspended = new Set<string>();
    const { controller, store, docker, clock } = setup({
      maxRunning: 10,
      tryLock: false, // the fallback rules: no try-lock, deadlines instead
      active: (userId) => !suspended.has(userId),
    });
    await controller.ensureRunning('suspended');
    await controller.ensureRunning('healthy');
    suspended.add('suspended');
    // A container whose member row is gone, and one in another namespace.
    docker.containers.set('gh-computer-testns-deleted', {
      state: 'running',
      exitCode: 0,
      oom: false,
      labels: { [LABEL_NAMESPACE]: NS, [LABEL_USER]: 'deleted' },
      args: [],
    });
    docker.containers.set('gh-computer-otherns-x', {
      state: 'running',
      exitCode: 0,
      oom: false,
      labels: { [LABEL_NAMESPACE]: 'otherns', [LABEL_USER]: 'x' },
      args: [],
    });
    // A start that died long ago, and one in progress right now.
    store.seed('stale', { state: 'starting', updated_at: clock.iso(-START_DEADLINE_MS) });
    store.seed('fresh', { state: 'starting', updated_at: clock.iso(-5_000) });
    // Orphan volumes: one old, one just created.
    docker.volumes.set('gh-computer-testns-deleted-home', {
      labels: { [LABEL_NAMESPACE]: NS, [LABEL_USER]: 'deleted' },
      createdAt: clock.iso(-48 * 60 * MIN),
    });
    docker.volumes.set('gh-computer-testns-new-home', {
      labels: { [LABEL_NAMESPACE]: NS, [LABEL_USER]: 'new' },
      createdAt: clock.iso(-MIN),
    });

    await controller.reconcile();

    expect(docker.containers.has('gh-computer-testns-deleted')).toBe(false);
    expect(docker.containers.has('gh-computer-otherns-x')).toBe(true);
    expect(await store.get('suspended')).toMatchObject({ state: 'absent', state_reason: 'suspend' });
    expect(docker.volumes.has(computerVolumeName(NS, 'suspended'))).toBe(true); // a suspended member keeps files
    expect((await store.get('healthy'))?.state).toBe('running');
    expect((await store.get('stale'))?.state).toBe('absent');
    expect((await store.get('fresh'))?.state).toBe('starting');
    expect(docker.volumes.has('gh-computer-testns-deleted-home')).toBe(false);
    expect(docker.volumes.has('gh-computer-testns-new-home')).toBe(true);
  });

  it('classifies a broken host as a runtime error and a broken container as a per-member error', async () => {
    const { controller, store, docker, events } = setup();
    docker.runFailure = new ComputerRuntimeError('image_missing', 'Unable to find image');
    const hostError = await controller.ensureRunning('u1').catch((e) => e);
    expect(hostError).toMatchObject({ name: 'ComputerUnavailableError', code: 'unavailable' });
    expect(events.runtimeErrors.map((e) => e.reason)).toEqual(['image_missing']);
    expect(await store.get('u1')).toMatchObject({ state: 'error', state_reason: 'image_missing' });

    docker.runFailure = new ComputerDockerError('failed', 'OCI runtime create failed');
    const memberError = await controller.ensureRunning('u2').catch((e) => e);
    expect(memberError).toMatchObject({ name: 'ComputerUnavailableError', code: 'start_failed' });
    expect(events.runtimeErrors).toHaveLength(1); // unchanged: one member's failure never closes the runtime
    expect(await store.get('u2')).toMatchObject({ state: 'error', state_reason: 'start_failed' });

    // Self-heal: the next use starts fresh.
    docker.runFailure = null;
    expect((await controller.ensureRunning('u2')).state).toBe('running');
    expect((await controller.ensureRunning('u1')).state).toBe('running');
  });

  it('a failed home move is that member’s own failure, shown as move_failed — never a runtime error', async () => {
    let failure: Error | null = new ComputerStartError('move_failed', 'Moving the home to a new computer failed');
    const { controller, store, events } = setup({ startError: () => failure });
    const error = await controller.ensureRunning('u1').catch((e) => e);
    expect(error).toMatchObject({ name: 'ComputerUnavailableError', code: 'start_failed' });
    expect(await store.get('u1')).toMatchObject({ state: 'error', state_reason: 'move_failed' });
    expect(events.runtimeErrors).toEqual([]);
    failure = null;
    expect((await controller.ensureRunning('u1')).state).toBe('running');
  });

  it('gives up on a browser that never answers and removes the container', async () => {
    const { controller, store, docker } = setup();
    docker.readyAfterProbes = Number.POSITIVE_INFINITY;
    const error = await controller.ensureRunning('u1').catch((e) => e);
    expect(error.code).toBe('start_failed');
    expect(error.message).toMatch(/45 s/);
    expect(docker.containers.size).toBe(0);
    expect((await store.get('u1'))?.state).toBe('error');
  });

  it('recovers a start whose process died (a starting row found under the member lock)', async () => {
    const { controller, store, docker } = setup();
    store.seed('u1', { state: 'starting', updated_at: new Date(T0).toISOString() });
    docker.containers.set(computerContainerName(NS, 'u1'), {
      state: 'created',
      exitCode: 0,
      oom: false,
      labels: { [LABEL_NAMESPACE]: NS, [LABEL_USER]: 'u1' },
      args: [],
    });
    expect((await controller.ensureRunning('u1')).state).toBe('running');
  });

  it('refuses automatic starts over the soft disk limit, but lets the member open it to clean up', async () => {
    const { controller, store, clock } = setup();
    store.seed('u1', { disk_bytes: DISK_SOFT_LIMIT_BYTES + 1, disk_measured_at: clock.iso() });
    const error = await controller.ensureRunning('u1').catch((e) => e);
    expect(error.code).toBe('over_quota');
    expect((await store.get('u1'))?.state_reason).toBe('over_quota');
    expect((await controller.ensureRunning('u1', { allowOverQuota: true })).state).toBe('running');
  });

  it('measures both homes on the disk tick', async () => {
    const { controller, store } = setup();
    await controller.ensureRunning('u1');
    await controller.diskTick();
    expect((await store.get('u1'))?.disk_bytes).toBe(3000);
  });

  it('marks a vanished container broken, purges with or without the volume, and resets on the current image', async () => {
    const { controller, store, docker, events } = setup();
    await controller.ensureRunning('u1');
    docker.containers.delete(computerContainerName(NS, 'u1'));
    await controller.markBroken('u1', 'exited');
    expect(await store.get('u1')).toMatchObject({ state: 'error', state_reason: 'exited' });
    expect(events.stopped).toContainEqual(['u1', 'exited']);

    const before = (await controller.reset('u1', { wipe: false })).version;
    expect((await store.get('u1'))?.state).toBe('running');
    expect(before).toBeGreaterThan(0);

    await controller.purge('u1', { wipe: false, reason: 'suspend' });
    expect(await store.get('u1')).toMatchObject({ state: 'absent', state_reason: 'suspend' });
    expect(docker.volumes.has(computerVolumeName(NS, 'u1'))).toBe(true);

    await controller.purge('u1', { wipe: true });
    expect(await store.get('u1')).toBeUndefined();
    expect(docker.volumes.has(computerVolumeName(NS, 'u1'))).toBe(false);
  });

  it('refuses to start a computer for a member who may no longer use one (suspended, bots off, deleted)', async () => {
    const allowed = new Map<string, boolean | null>([
      ['off', false],
      ['gone', null],
    ]);
    const { controller, store, docker } = setup({
      active: (userId) => (allowed.has(userId) ? allowed.get(userId)! : true),
    });
    for (const user of ['off', 'gone']) {
      await expect(controller.ensureRunning(user)).rejects.toMatchObject({ code: 'disabled' });
    }
    expect(docker.log.filter((l) => l.startsWith('run'))).toEqual([]);
    expect(await store.get('gone')).toBeUndefined(); // no row for a deleted member

    // A purge followed by a Bot action already in flight cannot bring it back.
    await controller.ensureRunning('member');
    allowed.set('member', false);
    await controller.purge('member', { wipe: false, reason: 'suspend' });
    await expect(controller.ensureRunning('member')).rejects.toMatchObject({ code: 'disabled' });
    expect(docker.containers.has(computerContainerName(NS, 'member'))).toBe(false);
  });

  describe('interrupted transitions (a slot that died mid-start or mid-stop)', () => {
    it('settles a starting row whose lock is free on the health tick, and skips one whose lock is held', async () => {
      const { controller, store, docker, clock, events } = setup();
      for (const user of ['dead', 'alive']) {
        store.seed(user, { state: 'starting', updated_at: clock.iso(-5_000) });
        docker.containers.set(computerContainerName(NS, user), {
          state: 'created',
          exitCode: 0,
          oom: false,
          labels: { [LABEL_NAMESPACE]: NS, [LABEL_USER]: user },
          args: [],
        });
      }
      store.heldLocks.add('alive');
      await controller.healthTick();
      expect(await store.get('dead')).toMatchObject({ state: 'absent', state_reason: 'start_interrupted' });
      expect(docker.containers.has(computerContainerName(NS, 'dead'))).toBe(false);
      expect(events.stopped).toContainEqual(['dead', 'start_interrupted']);
      expect((await store.get('alive'))?.state).toBe('starting');
      expect(docker.containers.has(computerContainerName(NS, 'alive'))).toBe(true);
    });

    it('settles a stopping row only once it is stale (LRU stops run without the victim’s lock)', async () => {
      const { controller, store, clock } = setup();
      store.seed('young', { state: 'stopping', state_reason: 'lru', updated_at: clock.iso(-5_000) });
      store.seed('old', { state: 'stopping', state_reason: 'idle', updated_at: clock.iso(-2 * MIN) });
      await controller.healthTick();
      expect((await store.get('young'))?.state).toBe('stopping');
      expect(await store.get('old')).toMatchObject({ state: 'absent', state_reason: 'idle' });
    });

    it('frees the capacity two stuck rows were holding, so the next member starts instead of getting busy', async () => {
      const { controller, store, clock } = setup({ maxRunning: 2 });
      store.seed('stuck-1', { state: 'starting', updated_at: clock.iso(-10_000) });
      store.seed('stuck-2', { state: 'stopping', state_reason: 'idle', updated_at: clock.iso(-3 * MIN) });
      await controller.healthTick();
      expect((await controller.ensureRunning('third')).state).toBe('running');
    });

    it('without a try-lock, waits for the start deadline before settling', async () => {
      const { controller, store, clock } = setup({ tryLock: false });
      store.seed('u1', { state: 'starting', updated_at: clock.iso(-MIN) });
      await controller.healthTick();
      expect((await store.get('u1'))?.state).toBe('starting');
      clock.ms += START_DEADLINE_MS;
      await controller.healthTick();
      expect(await store.get('u1')).toMatchObject({ state: 'absent', state_reason: 'start_interrupted' });
    });
  });

  describe('reconcile acts under the member’s lock, on fresh state', () => {
    it('leaves a slow start in progress elsewhere alone, and settles a dead one however young', async () => {
      const { controller, store, docker, clock } = setup();
      store.seed('slow', { state: 'starting', updated_at: clock.iso(-70_000) });
      docker.containers.set(computerContainerName(NS, 'slow'), {
        state: 'running',
        exitCode: 0,
        oom: false,
        labels: { [LABEL_NAMESPACE]: NS, [LABEL_USER]: 'slow' },
        args: [],
      });
      store.heldLocks.add('slow'); // blue is 70 s into a cold start
      store.seed('dead', { state: 'starting', updated_at: clock.iso(-5_000) });
      await controller.reconcile();
      expect((await store.get('slow'))?.state).toBe('starting');
      expect(docker.containers.has(computerContainerName(NS, 'slow'))).toBe(true);
      expect(await store.get('dead')).toMatchObject({ state: 'absent', state_reason: 'start_interrupted' });
    });

    it('never removes a container the member got back after the snapshot', async () => {
      const { controller, store, docker, clock } = setup();
      // Snapshot: running row, container gone (it died) → would be settled and cleaned.
      store.seed('u1', { state: 'running', updated_at: clock.iso(-10 * MIN), last_started_at: clock.iso(-10 * MIN) });
      // An orphan container of a member with no row yet → would be removed.
      docker.containers.set(computerContainerName(NS, 'newbie'), {
        state: 'running',
        exitCode: 0,
        oom: false,
        labels: { [LABEL_NAMESPACE]: NS, [LABEL_USER]: 'newbie' },
        args: [],
      });
      // Meanwhile (before reconcile holds each lock) the other slot restarted u1 and started newbie.
      store.onLock = (userId) => {
        if (userId === 'u1' && store.rows.get('u1')!.version === 0) {
          store.rows.set('u1', { ...store.rows.get('u1')!, version: 2, updated_at: clock.iso() });
          docker.containers.set(computerContainerName(NS, 'u1'), {
            state: 'running',
            exitCode: 0,
            oom: false,
            labels: { [LABEL_NAMESPACE]: NS, [LABEL_USER]: 'u1' },
            args: [],
          });
        }
        if (userId === 'newbie' && !store.rows.has('newbie')) store.seed('newbie', { state: 'running' });
      };
      await controller.reconcile();
      expect((await store.get('u1'))?.state).toBe('running');
      expect(docker.containers.has(computerContainerName(NS, 'u1'))).toBe(true);
      expect(docker.containers.has(computerContainerName(NS, 'newbie'))).toBe(true);
    });
  });

  it('wipes in one critical section: a concurrent start or an LRU stop in flight cannot make it fail', async () => {
    const { controller, store, docker, clock } = setup();
    const volume = computerVolumeName(NS, 'u1');
    const container = computerContainerName(NS, 'u1');
    await controller.ensureRunning('u1');
    // A Bot action arrives while the wipe is stopping the container: it waits
    // for the member's lock, then starts on a fresh row and a fresh volume.
    let racing: Promise<unknown> | null = null;
    docker.onStop = () => {
      racing ??= controller.ensureRunning('u1');
    };
    await expect(controller.purge('u1', { wipe: true, reason: 'reset' })).resolves.toBeUndefined();
    expect(await racing).toMatchObject({ state: 'running', version: 2 });
    const wiped = docker.log.indexOf(`volume rm ${volume}`);
    expect(wiped).toBeGreaterThan(-1);
    expect(docker.log.lastIndexOf(`volume create ${volume}`)).toBeGreaterThan(wiped);
    expect(docker.log.lastIndexOf(`run ${container}`)).toBeGreaterThan(wiped);
    docker.onStop = null;

    // A row an LRU eviction just set to `stopping` (its container still up).
    await controller.ensureRunning('u2');
    const row = store.rows.get('u2')!;
    store.rows.set('u2', { ...row, state: 'stopping', state_reason: 'lru', updated_at: clock.iso() });
    await expect(controller.purge('u2', { wipe: true, reason: 'admin' })).resolves.toBeUndefined();
    expect(await store.get('u2')).toBeUndefined();
    expect(docker.volumes.has(computerVolumeName(NS, 'u2'))).toBe(false);
  });

  it('lets automatic starts through again once a cleanup is measured, even after an idle stop', async () => {
    const { controller, store, docker, clock } = setup({ idleMinutes: 15 });
    store.seed('u1', { disk_bytes: DISK_SOFT_LIMIT_BYTES + 1, disk_measured_at: clock.iso(-MIN) });
    await expect(controller.ensureRunning('u1')).rejects.toMatchObject({ code: 'over_quota' });
    expect((await store.get('u1'))?.state_reason).toBe('over_quota');

    // The member opens it and deletes 3 GB; the start itself triggers a fresh measurement.
    docker.du = { '/home/agent': 1000, '/home/browser': 2000 };
    await controller.ensureRunning('u1', { allowOverQuota: true });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await store.get('u1')).toMatchObject({ disk_bytes: 3000, state_reason: null });

    clock.ms += 20 * MIN;
    await controller.idleTick();
    expect((await store.get('u1'))?.state).toBe('absent');
    expect((await controller.ensureRunning('u1')).state).toBe('running');
  });

  it('treats an over-quota reading taken before the last start as stale', async () => {
    const { controller, store, clock } = setup();
    store.seed('u1', {
      disk_bytes: DISK_SOFT_LIMIT_BYTES + 1,
      disk_measured_at: clock.iso(-30 * MIN),
      last_started_at: clock.iso(-10 * MIN), // ran (and maybe got cleaned) since
    });
    expect((await controller.ensureRunning('u1')).state).toBe('running');
  });

  it('keeps a computer whose Bot waits on a sign-in or take-over card: no idle stop, no LRU eviction', async () => {
    const waiting = new Set(['login-wall']);
    const { controller, store, clock } = setup({
      maxRunning: 2,
      idleMinutes: 15,
      awaitingHuman: (userId) => waiting.has(userId),
    });
    await controller.ensureRunning('login-wall');
    await controller.ensureRunning('idle');
    clock.ms += 20 * MIN;
    // LRU: the unprotected idle computer goes, although login-wall is older.
    await controller.ensureRunning('newcomer');
    expect((await store.get('login-wall'))?.state).toBe('running');
    expect(await store.get('idle')).toMatchObject({ state: 'absent', state_reason: 'lru' });
    // Only protected computers left (newcomer is busy): the next one waits, then gets busy.
    clock.ms += 20 * MIN;
    await controller.ensureRunning('newcomer');
    waiting.add('newcomer');
    await expect(controller.ensureRunning('late')).rejects.toMatchObject({ code: 'busy' });

    await controller.idleTick();
    expect((await store.get('login-wall'))?.state).toBe('running');
    // The member answered (or the card expired): an ordinary idle computer again.
    waiting.delete('login-wall');
    await controller.idleTick();
    expect(await store.get('login-wall')).toMatchObject({ state: 'absent', state_reason: 'idle' });
  });

  describe('Docker disk guard', () => {
    /** `df -P -k` output for a disk with `freePercent` % available. */
    const dfWith = (freePercent: number) => {
      const total = 100_000_000;
      const available = Math.round((total * freePercent) / 100);
      return `Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/vda1 ${total} ${total - available} ${available} ${100 - freePercent}% /home/agent\n`;
    };

    it('reads df output (POSIX one-line form) and rejects nonsense', () => {
      expect(parseDfOutput(dfWith(42), 7)).toEqual({
        freeRatio: 0.42,
        availableBytes: 42_000_000 * 1024,
        totalBytes: 100_000_000 * 1024,
        measuredAt: 7,
      });
      expect(parseDfOutput('', 7)).toBeNull();
      expect(parseDfOutput('df: /home/agent: No such file or directory', 7)).toBeNull();
      expect(
        parseDfOutput('Filesystem 1024-blocks Used Available Capacity Mounted on\nnone 0 0 0 - /home/agent', 7),
      ).toBeNull();
    });

    it('measures the Docker disk right after a start', async () => {
      const { controller, docker, events } = setup();
      docker.df = dfWith(55);
      await controller.ensureRunning('u1');
      await Promise.resolve();
      await Promise.resolve();
      expect(events.hostDisk.at(-1)).toMatchObject({ freeRatio: 0.55 });
    });

    it('refuses every new start below 10 % free — even the member opening their own — while running computers keep running', async () => {
      const { controller, docker, env, clock, store } = setup();
      await controller.ensureRunning('running-user');
      docker.df = dfWith(6);
      await controller.healthTick(); // no reading yet: the health loop takes one from a running computer
      await Promise.resolve();
      expect(env.hostDisk).toMatchObject({ freeRatio: 0.06 });

      for (const opts of [{}, { allowOverQuota: true }]) {
        const error = await controller.ensureRunning('new-user', opts).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ComputerUnavailableError);
        expect(error).toMatchObject({ code: 'over_quota', reason: 'host_disk' });
        expect((error as Error).message).not.toMatch(/%|\/home|vda/); // member-safe: no numbers or paths
      }
      expect((await store.get('new-user'))?.state).toBe('absent');
      expect((await controller.ensureRunning('running-user')).state).toBe('running');

      // A cleanup on the host, measured by the health loop (often while low), reopens starts.
      docker.df = dfWith(30);
      clock.ms += 2 * MIN;
      await controller.healthTick();
      await Promise.resolve();
      expect((await controller.ensureRunning('new-user')).state).toBe('running');
    });

    it('a low reading nobody could refresh expires, so a host cleaned up while nothing ran is not refused forever', async () => {
      const { controller, env, clock } = setup();
      env.hostDisk = { freeRatio: 0.02, availableBytes: 1, totalBytes: 50, measuredAt: clock.now() };
      await expect(controller.ensureRunning('u1')).rejects.toMatchObject({ code: 'over_quota', reason: 'host_disk' });
      clock.ms += HOST_DISK_READING_TTL_MS;
      expect((await controller.ensureRunning('u1')).state).toBe('running');
    });

    it('re-reads the disk with every disk measurement, and from the health loop only when the reading is old', async () => {
      const { controller, docker, clock } = setup();
      docker.df = dfWith(50);
      await controller.ensureRunning('u1');
      await Promise.resolve();
      const afterStart = docker.dfCalls;
      expect(afterStart).toBe(1);
      await controller.healthTick(); // fresh reading: nothing to do
      await Promise.resolve();
      expect(docker.dfCalls).toBe(afterStart);
      clock.ms += 5 * MIN;
      await controller.healthTick();
      await Promise.resolve();
      expect(docker.dfCalls).toBe(afterStart + 1);
      await controller.diskTick();
      expect(docker.dfCalls).toBe(afterStart + 2);
    });
  });

  it('proves egress is blocked from inside every new computer on a hardened host', async () => {
    const probe = ['http://172.30.0.1:3111/', 'http://169.254.169.254/'];
    const { controller, store, docker, events } = setup({ egressProbe: probe });
    expect((await controller.ensureRunning('u1')).state).toBe('running');
    expect(docker.log).toContain(`egress probe ${probe.join(' ')}`);

    // The rules vanished (a firewall reload): metadata answers. The start fails and the host closes.
    docker.egress['http://169.254.169.254/'] = 0;
    const error = await controller.ensureRunning('u2').catch((e) => e);
    expect(error).toMatchObject({ name: 'ComputerUnavailableError', code: 'unavailable' });
    expect(events.runtimeErrors.map((e) => e.reason)).toEqual(['network_invalid']);
    expect(await store.get('u2')).toMatchObject({ state: 'error', state_reason: 'network_invalid' });
    expect(docker.containers.has(computerContainerName(NS, 'u2'))).toBe(false);
  });
});
