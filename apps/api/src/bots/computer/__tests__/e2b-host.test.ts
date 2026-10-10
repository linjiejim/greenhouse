/**
 * The e2b host (e2b-host.ts) against a fake provider and fake bridges: which
 * sandbox a start resumes or creates, how a home moves to a new template (and
 * what is left when that fails), pause/kill semantics, the orphan rules, the
 * dead-man timeout renewal, and how a failed bridge call is classified. The
 * real provider and the real bridge run in the live check
 * (docs/specs/20261010-hosted-computer-sandbox.md) and e2b-bridge.test.ts.
 */

import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { AuthenticationError, type SandboxInfo } from 'e2b';
import { describe, expect, it, vi } from 'vitest';
import type { BotComputerRow } from '@greenhouse/db';

import type { BotsComputerConfig } from '../config.js';
import { ComputerDockerError, ComputerRuntimeError } from '../docker.js';
import { BridgeConnectionError } from '../e2b-bridge.js';
import {
  bridgeSecret,
  computerEnvFile,
  createE2bHost,
  MOVE_RETRY_AFTER_MS,
  ORPHAN_GRACE_MS,
  providerError,
  RECOVER_SCRIPT,
  RETIRED_KEEP_MS,
  settingsHash,
  type E2bApi,
  type SandboxHandle,
} from '../e2b-host.js';
import { homeExportArgv, homeImportArgv } from '../home-archive.js';
import {
  ComputerStartError,
  type ComputerProcess,
  type ComputerStartSpec,
  type ExecOutcome,
  type HomeRestore,
} from '../host.js';

const NS = 'testns';
const TEMPLATE = 'gh-computer-c2-aaaaaaaaaaaa';
const KEY = 'ab'.repeat(32);
const T0 = Date.parse('2026-10-10T08:00:00.000Z');
/** The settings an older computer was booted with (read back while a failed move backs off). */
const KEPT_ENV = 'TZ=Europe/Berlin\nGH_COMPUTER_LANG=de-DE\n';

class FakeApi implements E2bApi {
  sandboxes = new Map<string, SandboxInfo>();
  log: string[] = [];
  roots: Array<{ id: string; command: string; envs: Record<string, string> }> = [];
  /** Exit code of a root command (default 0). */
  rootExit: ((id: string, command: string) => number) | null = null;
  /** What the provider reports it does on timeout. */
  onTimeout: 'pause' | 'kill' | undefined = 'pause';
  timeouts: Array<[string, number]> = [];
  private next = 1;

  seed(metadata: Record<string, string>, state: 'running' | 'paused' = 'paused'): string {
    const id = `sandbox${String(this.next++).padStart(4, '0')}`;
    this.sandboxes.set(id, {
      sandboxId: id,
      templateId: 't',
      metadata,
      startedAt: new Date(T0),
      endAt: new Date(T0 + 3600_000),
      state,
      cpuCount: 2,
      memoryMB: 2048,
      envdVersion: '0.5.0',
      ...(this.onTimeout ? { lifecycle: { onTimeout: this.onTimeout, autoResume: false } } : {}),
    });
    return id;
  }

  private handle(id: string): SandboxHandle {
    return {
      id,
      host: (port) => `${port}-${id}.sandbox.test`,
      trafficToken: `traffic-${id}`,
      runRoot: async (command, envs) => {
        this.roots.push({ id, command, envs });
        const label =
          command === RECOVER_SCRIPT
            ? 'recover'
            : command.startsWith('base64 ')
              ? 'read settings'
              : command.split('/').pop();
        this.log.push(`root ${id} ${label}`);
        const code = this.rootExit?.(id, command) ?? 0;
        // The env file a sandbox was booted with, as `base64 -w0` prints it.
        const stdout = command.startsWith('base64 ') ? Buffer.from(KEPT_ENV).toString('base64') : '';
        return { code, stdout, stderr: code ? 'boom' : '' };
      },
    };
  }

  create = async (template: string, metadata: Record<string, string>) => {
    const id = this.seed({ ...metadata }, 'running');
    this.log.push(`create ${id} ${template}${metadata.gh_replaces ? ` replaces ${metadata.gh_replaces}` : ''}`);
    return this.handle(id);
  };
  connect = async (id: string) => {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) throw new Error('not found');
    sandbox.state = 'running';
    this.log.push(`connect ${id}`);
    return this.handle(id);
  };
  getInfo = async (id: string) => this.sandboxes.get(id) ?? null;
  pause = async (id: string) => {
    const sandbox = this.sandboxes.get(id);
    if (sandbox) sandbox.state = 'paused';
    this.log.push(`pause ${id}`);
  };
  kill = async (id: string) => {
    this.sandboxes.delete(id);
    this.log.push(`kill ${id}`);
  };
  setTimeout = async (id: string, ms: number) => {
    this.timeouts.push([id, ms]);
  };
  list = async (namespace: string) => [...this.sandboxes.values()].filter((s) => s.metadata.gh_ns === namespace);
}

/** A process that runs `script` once its stdin ends (tar -x) or right away (tar -c). */
function fakeProcess(exitCode: number, opts: { output?: Buffer; waitForInput?: boolean } = {}): ComputerProcess {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: null;
    kill(): boolean;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = null;
  proc.signalCode = null;
  const exit = () => {
    proc.exitCode = exitCode;
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('exit', exitCode, null);
    setImmediate(() => proc.emit('close', exitCode, null));
  };
  proc.kill = () => {
    exit();
    return true;
  };
  if (opts.waitForInput) {
    proc.stdin.resume();
    proc.stdin.on('end', exit);
  } else {
    setImmediate(() => {
      if (opts.output) proc.stdout.write(opts.output);
      exit();
    });
  }
  return proc as unknown as ComputerProcess;
}

/**
 * A home copy (tar -c) behaving like a BridgeProcess: it keeps sending until killed, and — like a
 * ChildProcess — emits 'close' only once its stdout has been read to the end.
 */
function strictSource(bytes: number): ComputerProcess {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: null;
    kill(): boolean;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = null;
  proc.signalCode = null;
  let ended = false;
  proc.kill = () => {
    if (ended) return false;
    ended = true;
    proc.stdout.end();
    proc.stderr.end();
    proc.stderr.resume();
    proc.emit('exit', null, null);
    let open = 2;
    const done = () => {
      if (--open === 0) proc.emit('close', null, null);
    };
    for (const stream of [proc.stdout, proc.stderr]) {
      if (stream.readableEnded) done();
      else stream.once('end', done);
    }
    return true;
  };
  setImmediate(() => proc.stdout.write(Buffer.alloc(bytes)));
  return proc as unknown as ComputerProcess;
}

/** A tar -x whose connection drops at once: it ends without an exit code and never reads its input. */
function droppedSink(): ComputerProcess {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: null;
    kill(): boolean;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = () => false;
  setImmediate(() => {
    proc.stdin.destroy(); // like BridgeProcess.finish(): writes into it go nowhere
    proc.stdout.end();
    proc.stderr.end();
    proc.emit('exit', null, null);
    setImmediate(() => proc.emit('close', null, null));
  });
  return proc as unknown as ComputerProcess;
}

const ok = (partial: Partial<ExecOutcome> = {}): ExecOutcome => ({
  code: 0,
  signal: null,
  stdout: Buffer.alloc(0),
  stderr: '',
  stdoutTruncated: false,
  timedOut: false,
  aborted: false,
  ...partial,
});

/**
 * tarWrite: one exit code for every `tar -x`, or one per call (the last repeats).
 * sinkDrops: every `tar -x` loses its connection at once while the copy is still sending.
 */
function setup(opts: { tarRead?: number; tarWrite?: number | number[]; sinkDrops?: boolean } = {}) {
  const api = new FakeApi();
  let now = T0;
  const streams: Array<{ origin: string; argv: string[] }> = [];
  const writes = Array.isArray(opts.tarWrite) ? [...opts.tarWrite] : [opts.tarWrite ?? 0];
  const bridge = {
    exec: vi.fn(async () => ok()),
    stream: vi.fn((target: unknown, argv: string[]) => {
      streams.push({ origin: (target as { origin: string }).origin, argv });
      // A home going out: a move's copy (-cpf) or a backup's (-cf).
      const reads = argv.includes('-cpf') || argv.includes('-cf');
      if (opts.sinkDrops) return reads ? strictSource(4 * 1024 * 1024) : droppedSink();
      return reads
        ? fakeProcess(opts.tarRead ?? 0, { output: Buffer.from('home') })
        : fakeProcess(writes.length > 1 ? writes.shift()! : writes[0]!, { waitForInput: true });
    }),
    tunnel: vi.fn(),
  };
  const host = createE2bHost({
    api,
    namespace: NS,
    secretKey: KEY,
    now: () => now,
    bridge: bridge as unknown as Parameters<typeof createE2bHost>[0]['bridge'],
  });
  return { api, host, bridge, streams, advance: (ms: number) => (now += ms) };
}

function row(patch: Partial<BotComputerRow> = {}): BotComputerRow {
  return {
    user_id: 'u1',
    namespace: NS,
    container_name: 'gh-computer-testns-u1',
    volume_name: 'gh-computer-testns-u1-home',
    state: 'starting',
    version: 1,
    ...patch,
  } as BotComputerRow;
}

function spec(image: string | null = TEMPLATE, fresh = false): ComputerStartSpec {
  return {
    config: { proxy: null } as BotsComputerConfig,
    image,
    urlBlocklist: ['green.example.com', 'host.docker.internal:3000'],
    timezone: 'Asia/Shanghai',
    lang: 'zh-CN',
    fresh,
  };
}

const meta = (template: string, user = 'u1') => ({
  gh_ns: NS,
  gh_user: user,
  gh_template: template,
  gh_settings: settingsHash(spec()),
});

describe('e2b host: starts', () => {
  it('creates the first sandbox, boots it with this sandbox’s secrets and the member’s settings', async () => {
    const { api, host, bridge } = setup();
    const started = await host.start(row(), spec());
    const created = api.sandboxes.get(started.ref)!;
    expect(created.metadata).toMatchObject({ gh_ns: NS, gh_user: 'u1', gh_template: TEMPLATE });
    expect(created.metadata.gh_replaces).toBeUndefined();
    expect(started.imageId).toBe(TEMPLATE);
    expect(created.metadata.gh_settings).toBe(settingsHash(spec()));
    const boot = api.roots.find((r) => r.command === '/usr/local/sbin/gh-e2b-boot')!;
    expect(boot.envs.GH_BRIDGE_SECRET_BROWSER).toBe(bridgeSecret(KEY, started.ref, 'browser'));
    expect(boot.envs.GH_BRIDGE_SECRET_AGENT).not.toBe(boot.envs.GH_BRIDGE_SECRET_BROWSER);
    const settings = Buffer.from(boot.envs.GH_COMPUTER_ENV_B64!, 'base64').toString();
    expect(settings).toContain('TZ=Asia/Shanghai');
    expect(settings).toContain('GH_COMPUTER_URL_BLOCKLIST=green.example.com,host.docker.internal:3000');
    expect(settings).toContain('HTTPS_PROXY=');
    // Both bridges answered before the start returned, with the edge token and the uid's secret.
    const targets = bridge.exec.mock.calls.map(
      (call) => (call as unknown as [{ origin: string; headers: Record<string, string> }])[0],
    );
    expect(targets.map((t) => t.origin)).toEqual([
      `wss://7682-${started.ref}.sandbox.test`,
      `wss://7681-${started.ref}.sandbox.test`,
    ]);
    expect(targets[0]!.headers).toMatchObject({ 'e2b-traffic-access-token': `traffic-${started.ref}` });
  });

  it('resumes the member’s sandbox when it runs the current template', async () => {
    const { api, host } = setup();
    const id = api.seed(meta(TEMPLATE));
    const started = await host.start(row({ container_name: id }), spec());
    expect(started.ref).toBe(id);
    expect(api.log).toEqual([`connect ${id}`, `root ${id} gh-e2b-boot --resume`]);
    await started.abandon();
    expect(api.sandboxes.get(id)?.state).toBe('paused'); // never killed: it holds the member's files
  });

  it('a reset starts a new sandbox around the same home, even on the current template', async () => {
    const { api, host } = setup();
    const id = api.seed(meta(TEMPLATE));
    const started = await host.start(row({ container_name: id, state_reason: 'reset' }), spec(TEMPLATE, true));
    expect(started.ref).not.toBe(id);
    expect(api.sandboxes.get(started.ref)?.metadata.gh_replaces).toBe(id);
    expect(api.sandboxes.get(id)?.state).toBe('paused');
  });

  it('moves the home into a new sandbox when the template changed, keeping the old one paused', async () => {
    const { api, host, streams } = setup();
    const old = api.seed(meta('gh-computer-c2-older'));
    const started = await host.start(row({ container_name: old }), spec());
    expect(started.ref).not.toBe(old);
    expect(api.sandboxes.get(started.ref)?.metadata.gh_replaces).toBe(old);
    expect(api.log).toEqual([
      `create ${started.ref} ${TEMPLATE} replaces ${old}`,
      `root ${started.ref} gh-e2b-boot --bridges-only`,
      `connect ${old}`,
      `root ${old} systemctl stop gh-desktop.service`,
      `pause ${old}`,
      `root ${started.ref} gh-e2b-boot`,
    ]);
    // Each uid copies its own home: from the old sandbox's bridge to the new one's.
    expect(streams).toEqual([
      {
        origin: `wss://7682-${old}.sandbox.test`,
        argv: ['tar', '-C', '/home/agent', '--ignore-failed-read', '-cpf', '-', '.'],
      },
      {
        origin: `wss://7682-${started.ref}.sandbox.test`,
        argv: ['tar', '-C', '/home/agent', '--no-overwrite-dir', '-xpf', '-'],
      },
      {
        origin: `wss://7681-${old}.sandbox.test`,
        argv: ['tar', '-C', '/home/browser', '--ignore-failed-read', '-cpf', '-', '.'],
      },
      {
        origin: `wss://7681-${started.ref}.sandbox.test`,
        argv: ['tar', '-C', '/home/browser', '--no-overwrite-dir', '-xpf', '-'],
      },
    ]);
    expect(api.sandboxes.get(old)?.state).toBe('paused');
    // Abandoning the start removes only the new copy.
    await started.abandon();
    expect(api.sandboxes.has(started.ref)).toBe(false);
    expect(api.sandboxes.has(old)).toBe(true);
  });

  it('a dropped connection restarts that home, not the whole move', async () => {
    const { api, host, streams } = setup({ tarWrite: [2, 0] });
    const old = api.seed(meta('gh-computer-c2-older'));
    const started = await host.start(row({ container_name: old }), spec());
    expect(started).toMatchObject({ imageId: TEMPLATE });
    expect(started.ref).not.toBe(old);
    // The agent home twice (the first copy failed), the browser home once.
    expect(streams.filter((s) => s.argv.includes('-xpf')).map((s) => s.argv[2])).toEqual([
      '/home/agent',
      '/home/agent',
      '/home/browser',
    ]);
    // tar exit 1 (a file changed while it was read) still counts as a complete copy.
    const tolerant = setup({ tarRead: 1 });
    const older = tolerant.api.seed(meta('gh-computer-c2-older'));
    await expect(tolerant.host.start(row({ container_name: older }), spec())).resolves.toMatchObject({
      imageId: TEMPLATE,
    });
  });

  it('a copy whose receiving end dropped first is drained and stopped — the start never hangs on it', async () => {
    const { api, host, streams } = setup({ sinkDrops: true });
    const old = api.seed(meta('gh-computer-c2-older'));
    // Before the fix the source's 'close' never came (nobody read it once the pipe let go): this hung.
    await expect(host.start(row({ container_name: old }), spec())).resolves.toMatchObject({ ref: old });
    expect(streams.filter((s) => s.argv.includes('-cpf'))).toHaveLength(3);
    expect(api.log).toContain(`root ${old} recover`);
  });

  it('a move that keeps failing gives the member the old computer back, and waits before trying again', async () => {
    const { api, host, streams, advance } = setup({ tarWrite: 2 });
    const old = api.seed(meta('gh-computer-c2-older'));
    const started = await host.start(row({ container_name: old }), spec());
    // The old one, its desktop started again after every agent process was ended (RECOVER_SCRIPT).
    expect(started).toMatchObject({ ref: old, imageId: 'gh-computer-c2-older' });
    expect(api.log).toContain(`root ${old} recover`);
    expect([...api.sandboxes.keys()]).toEqual([old]); // the new copy is gone
    expect(streams.filter((s) => s.argv.includes('-xpf'))).toHaveLength(3); // MOVE_ATTEMPTS tries of the first home
    // Asleep again and woken within the back-off: no new sandbox, no move — the old one, with its own settings.
    await api.pause(old);
    api.log.length = 0;
    const again = await host.start(row({ container_name: old }), spec());
    expect(again).toMatchObject({ ref: old, imageId: 'gh-computer-c2-older' });
    expect(api.log).toEqual([`connect ${old}`, `root ${old} read settings`, `root ${old} gh-e2b-boot --resume`]);
    // Its own settings, through the --resume every template knows (never the member's new ones).
    const woken = api.roots.filter((r) => r.command.endsWith('--resume')).pop()!;
    expect(Buffer.from(woken.envs.GH_COMPUTER_ENV_B64!, 'base64').toString()).toBe(KEPT_ENV);
    // After it, the next start tries the move again.
    await api.pause(old);
    advance(MOVE_RETRY_AFTER_MS);
    api.log.length = 0;
    await host.start(row({ container_name: old }), spec());
    expect(api.log[0]).toMatch(new RegExp(`^create \\S+ ${TEMPLATE} replaces ${old}$`));
  });

  it('a reset whose move fails says so (move_failed): no fresh system, the old one sleeps with its desktop back', async () => {
    const { api, host } = setup({ tarWrite: 2 });
    const old = api.seed(meta(TEMPLATE));
    const failure = await host
      .start(row({ container_name: old, state_reason: 'reset' }), spec(TEMPLATE, true))
      .catch((e) => e);
    expect(failure).toBeInstanceOf(ComputerStartError);
    expect(failure).toMatchObject({ reason: 'move_failed' });
    expect(api.log).toContain(`root ${old} recover`);
    expect([...api.sandboxes.keys()]).toEqual([old]);
    expect(api.sandboxes.get(old)?.state).toBe('paused');
    // The next (ordinary) start simply wakes it.
    api.log.length = 0;
    await expect(host.start(row({ container_name: old }), spec())).resolves.toMatchObject({ ref: old });
    expect(api.log).toEqual([`connect ${old}`, `root ${old} gh-e2b-boot --resume`]);
  });

  it('when the old one cannot be recovered either, the start fails as move_failed and it stays asleep', async () => {
    const { api, host } = setup({ tarWrite: 2 });
    api.rootExit = (_id, command) => (command === RECOVER_SCRIPT ? 5 : 0);
    const old = api.seed(meta('gh-computer-c2-older'));
    await expect(host.start(row({ container_name: old }), spec())).rejects.toMatchObject({ reason: 'move_failed' });
    expect([...api.sandboxes.keys()]).toEqual([old]);
    expect(api.sandboxes.get(old)?.state).toBe('paused');
  });

  it('a failed boot of a new sandbox removes it', async () => {
    const { api, host } = setup();
    api.rootExit = () => 1;
    await expect(host.start(row(), spec())).rejects.toThrow(/gh-e2b-boot exited 1/);
    expect(api.sandboxes.size).toBe(0);
  });

  it('never changes a sandbox’s settings in place: other settings move the home to a new one', async () => {
    const { api, host } = setup();
    const id = api.seed(meta(TEMPLATE));
    const started = await host.start(row({ container_name: id }), { ...spec(), timezone: 'Europe/Berlin' });
    expect(started.ref).not.toBe(id);
    expect(api.sandboxes.get(started.ref)?.metadata).toMatchObject({
      gh_replaces: id,
      gh_settings: settingsHash({ ...spec(), timezone: 'Europe/Berlin' }),
    });
  });

  it('a woken sandbox whose desktop is down is never restarted in place: its home moves on', async () => {
    const { api, host } = setup();
    const id = api.seed(meta(TEMPLATE));
    api.rootExit = (sandboxId, command) => (sandboxId === id && command.endsWith('--resume') ? 4 : 0);
    const started = await host.start(row({ container_name: id }), spec());
    expect(started.ref).not.toBe(id);
    expect(api.log.slice(0, 3)).toEqual([
      `connect ${id}`,
      `root ${id} gh-e2b-boot --resume`,
      `create ${started.ref} ${TEMPLATE} replaces ${id}`,
    ]);
    expect(api.sandboxes.get(id)?.state).toBe('paused');
  });

  it('refuses a provider that would delete a sandbox on timeout instead of pausing it', async () => {
    const { api, host } = setup();
    api.onTimeout = 'kill';
    await expect(host.start(row(), spec())).rejects.toMatchObject({ reason: 'provider_unsupported' });
    expect(api.sandboxes.size).toBe(0);
    // One that does not say is taken at its word (E2B and PPIO both report it).
    const quiet = setup();
    quiet.api.onTimeout = undefined;
    await expect(quiet.host.start(row(), spec())).resolves.toMatchObject({ imageId: TEMPLATE });
  });

  it('refuses without a ready template, and never touches another member’s sandbox', async () => {
    const { api, host } = setup();
    await expect(host.start(row(), spec(null))).rejects.toMatchObject({ reason: 'template_missing' });
    const theirs = api.seed(meta(TEMPLATE, 'someone-else'));
    await expect(host.start(row({ container_name: theirs }), spec())).rejects.toThrow(/does not belong/);
    // Another namespace's sandbox is not ours at all: a fresh one is created instead.
    const foreign = api.seed({ gh_ns: 'other', gh_user: 'u1', gh_template: TEMPLATE });
    const started = await host.start(row({ container_name: foreign }), spec());
    expect(started.ref).not.toBe(foreign);
    expect(api.sandboxes.get(foreign)?.state).toBe('paused');
  });
});

describe('e2b host: backups', () => {
  /** A backup whose homes read as `<user>-home`, or fail to read. */
  function backup(opts: { fails?: boolean } = {}): HomeRestore & { opened: string[] } {
    const opened: string[] = [];
    return {
      backupId: 'bkp_1',
      takenAt: '2026-10-09T08:00:00.000Z',
      opened,
      open: async (user) => {
        opened.push(user);
        if (!opts.fails) return Readable.from([Buffer.from(`${user}-home`)]);
        const broken = new PassThrough();
        setImmediate(() => broken.destroy(new Error('a record failed authentication')));
        return broken;
      },
    };
  }

  it('fills a new sandbox from the newest backup when the member’s sandbox is gone, before anything runs in it', async () => {
    const { api, host, streams } = setup();
    const source = backup();
    const restore = vi.fn(async () => source);
    const started = await host.start(row({ container_name: 'sandbox0999' }), { ...spec(), restore });
    expect(restore).toHaveBeenCalledOnce();
    expect(started.restoredFrom).toBe('bkp_1');
    expect(api.log).toEqual([
      `create ${started.ref} ${TEMPLATE}`,
      `root ${started.ref} gh-e2b-boot --bridges-only`,
      `root ${started.ref} gh-e2b-boot`,
    ]);
    // Each home as its own uid, through its own bridge, between the two boots.
    expect(streams).toEqual([
      { origin: `wss://7682-${started.ref}.sandbox.test`, argv: homeImportArgv('agent') },
      { origin: `wss://7681-${started.ref}.sandbox.test`, argv: homeImportArgv('browser') },
    ]);
    expect(source.opened).toEqual(['agent', 'browser']);
  });

  it('never restores over a home that still exists: a woken or moved computer keeps its own', async () => {
    const { api, host } = setup();
    const restore = vi.fn(async () => backup());
    const current = api.seed(meta(TEMPLATE));
    expect((await host.start(row({ container_name: current }), { ...spec(), restore })).restoredFrom).toBeUndefined();
    const older = api.seed(meta('gh-computer-c2-older'), 'paused');
    expect((await host.start(row({ container_name: older }), { ...spec(), restore })).restoredFrom).toBeUndefined();
    expect(restore).not.toHaveBeenCalled();
    // No backup to restore: the new home simply starts empty.
    const empty = await host.start(row({ container_name: 'sandbox0999' }), { ...spec(), restore: async () => null });
    expect(empty.restoredFrom).toBeUndefined();
  });

  it('a backup that cannot be restored fails the start as restore_failed and removes the half-filled sandbox', async () => {
    const { api, host } = setup();
    const failure = await host
      .start(row({ container_name: 'sandbox0999' }), { ...spec(), restore: async () => backup({ fails: true }) })
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ComputerStartError);
    expect((failure as ComputerStartError).reason).toBe('restore_failed');
    expect((failure as Error).message).toMatch(/2026-10-09T08:00:00.000Z.*authentication/);
    expect([...api.sandboxes.keys()]).toEqual([]);
    expect(api.log.at(-1)).toMatch(/^kill /);
  });

  it('streams a home out of a running sandbox as its own uid, caches left out', async () => {
    const { api, host, bridge } = setup();
    const id = api.seed(meta(TEMPLATE), 'running');
    const out = host.exportHome(id, 'browser');
    const chunks: Buffer[] = [];
    for await (const chunk of out.stdout!) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('home');
    // The target resolves once the sandbox is found (a stream starts before that).
    const [target, argv] = bridge.stream.mock.calls[0] as unknown as [Promise<{ origin: string }>, string[]];
    expect((await target).origin).toBe(`wss://7681-${id}.sandbox.test`);
    expect(argv).toEqual(homeExportArgv('browser'));
    expect(homeExportArgv('browser')).toEqual(
      expect.arrayContaining(['--exclude=./chromium/*/Cache', '--exclude=./chromium/Singleton*']),
    );
    expect(homeExportArgv('agent')).toContain('--exclude=./.cache');
  });
});

describe('e2b host: stops, wipes, listings', () => {
  it('stop and discard pause; a docker-style name is nothing to pause', async () => {
    const { api, host } = setup();
    const id = api.seed(meta(TEMPLATE), 'running');
    await host.stop(id);
    expect(api.sandboxes.get(id)?.state).toBe('paused');
    await host.discard('gh-computer-testns-u1');
    expect(api.log).toEqual([`pause ${id}`]);
  });

  it('wipe removes the member’s sandboxes (the replaced ones too), nobody else’s', async () => {
    const { api, host } = setup();
    const current = api.seed(meta(TEMPLATE));
    const replaced = api.seed(meta('gh-computer-c2-older'));
    const other = api.seed(meta(TEMPLATE, 'u2'));
    await host.wipe(row({ container_name: current }));
    expect([...api.sandboxes.keys()]).toEqual([other]);
    expect(api.log).toEqual(expect.arrayContaining([`kill ${current}`, `kill ${replaced}`]));
  });

  it('a sandbox that went to sleep on its own is asleep (absent/idle), a missing one exited', async () => {
    const { api, host } = setup();
    const id = api.seed(meta(TEMPLATE), 'paused');
    const [instance] = await host.list(NS);
    expect(instance).toMatchObject({ ref: id, userId: 'u1', running: false });
    expect(await host.verdict(id, instance)).toEqual({ state: 'absent', reason: 'provider_timeout' });
    expect(await host.verdict('sandbox9999', undefined)).toEqual({ state: 'error', reason: 'exited' });
    expect(await host.inspect(id)).toEqual({ running: false });
    expect(await host.inspect('gh-computer-testns-u1')).toBeNull();
  });

  it('orphans: a dead start’s sandbox goes after an hour, a replaced one after three days', async () => {
    const { api, host, advance } = setup();
    const created = new Date(T0).toISOString();
    const orphan = api.seed({ ...meta(TEMPLATE), gh_created: created });
    const replaced = api.seed({ ...meta('gh-computer-c2-older'), gh_created: created });
    api.seed({ ...meta(TEMPLATE), gh_created: created, gh_replaces: replaced });
    let all = await host.list(NS);
    const find = (ref: string) => all.find((i) => i.ref === ref)!;
    expect(await host.removeOrphan(find(orphan), all)).toBe(false);
    advance(ORPHAN_GRACE_MS + 1);
    all = await host.list(NS);
    expect(await host.removeOrphan(find(orphan), all)).toBe(true);
    expect(await host.removeOrphan(find(replaced), all)).toBe(false);
    advance(RETIRED_KEEP_MS);
    all = await host.list(NS);
    expect(await host.removeOrphan(find(replaced), all)).toBe(true);
    expect(api.sandboxes.has(replaced)).toBe(false);
  });

  it('keeps a running sandbox alive in steps, never more than an hour ahead', async () => {
    const { api, host, advance } = setup();
    const id = api.seed(meta(TEMPLATE), 'running');
    await host.keepAlive!(row({ container_name: id, state: 'running' }), 15);
    await host.keepAlive!(row({ container_name: id, state: 'running' }), 15);
    expect(api.timeouts).toEqual([[id, 25 * 60_000]]);
    advance(5 * 60_000);
    await host.keepAlive!(row({ container_name: id, state: 'running' }), 240);
    expect(api.timeouts[1]).toEqual([id, 60 * 60_000]);
  });
});

describe('e2b host: exec surface', () => {
  it('a door that refuses a running sandbox (a rotated key) gets its secrets rewritten once, then the call is retried', async () => {
    const { api, host, bridge } = setup();
    const id = api.seed(meta(TEMPLATE), 'running');
    bridge.exec.mockRejectedValueOnce(new BridgeConnectionError('refused', 403));
    await expect(host.exec({ container: id, user: 'agent', argv: ['true'], timeoutMs: 1000 })).resolves.toMatchObject({
      code: 0,
    });
    expect(api.roots.map((r) => r.command)).toEqual(['/usr/local/sbin/gh-e2b-boot --secrets-only']);
    expect(api.roots[0]!.envs.GH_BRIDGE_SECRET_AGENT).toBe(bridgeSecret(KEY, id, 'agent'));
    // Not again right away: a door that keeps refusing is a failure, not a loop.
    bridge.exec.mockRejectedValueOnce(new BridgeConnectionError('refused', 403));
    await expect(host.exec({ container: id, user: 'agent', argv: ['true'], timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'failed',
    });
    expect(api.roots).toHaveLength(1);
  });

  it('never wakes a sleeping computer for an exec, and classifies a broken connection', async () => {
    const { api, host, bridge } = setup();
    const id = api.seed(meta(TEMPLATE), 'paused');
    await expect(host.exec({ container: id, user: 'agent', argv: ['true'], timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'not_running',
    });
    expect(api.log).toEqual([]);
    await expect(
      host.exec({ container: 'sandbox9999', user: 'agent', argv: ['true'], timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: 'not_found' });

    api.sandboxes.get(id)!.state = 'running';
    bridge.exec.mockRejectedValueOnce(new BridgeConnectionError('refused', 502));
    await expect(host.exec({ container: id, user: 'agent', argv: ['true'], timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'failed',
    });
    // The provider paused it meanwhile: the controller hears not_running and settles the row.
    bridge.exec.mockImplementationOnce(async () => {
      api.sandboxes.get(id)!.state = 'paused';
      throw new BridgeConnectionError('gone', 502);
    });
    await expect(host.exec({ container: id, user: 'agent', argv: ['true'], timeoutMs: 1000 })).rejects.toBeInstanceOf(
      ComputerDockerError,
    );
  });
});

describe('e2b host: helpers', () => {
  it('derives one secret per sandbox and uid, and refuses a key that is not one', () => {
    expect(() => createE2bHost({ api: new FakeApi(), namespace: NS, secretKey: '' })).toThrow(/TOKEN_SIGNING_KEY/);
    const key = KEY;
    expect(bridgeSecret(key, 'sandbox0001', 'agent')).toMatch(/^[0-9a-f]{64}$/);
    expect(bridgeSecret(key, 'sandbox0001', 'agent')).not.toBe(bridgeSecret(key, 'sandbox0001', 'browser'));
    expect(bridgeSecret(key, 'sandbox0001', 'agent')).not.toBe(bridgeSecret(key, 'sandbox0002', 'agent'));
  });

  it('refuses a settings value the env file cannot carry', () => {
    expect(() => computerEnvFile({ ...spec(), timezone: 'UTC\nLD_PRELOAD=/x' })).toThrow(/cannot carry/);
  });

  it('maps provider failures: a bad key or no network closes the runtime, anything else one computer', () => {
    expect(providerError(new AuthenticationError('bad key'), 'x')).toMatchObject({ reason: 'provider_auth' });
    expect(providerError(Object.assign(new Error('nope'), { statusCode: 401 }), 'x')).toBeInstanceOf(
      ComputerRuntimeError,
    );
    expect(
      providerError(
        new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }),
        'x',
      ),
    ).toMatchObject({ reason: 'provider_unreachable' });
    // One request timing out or reset fails that call, not everyone's computer.
    expect(
      providerError(
        new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) }),
        'x',
      ),
    ).toMatchObject({ code: 'failed' });
    expect(providerError(new Error('rate limited'), 'x')).toMatchObject({ code: 'failed' });
  });
});
