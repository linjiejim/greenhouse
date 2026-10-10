/**
 * The e2b host (host.ts): each member's computer is a sandbox at an
 * E2B-protocol provider (E2B; PPIO in China), built from the hosted template
 * (e2b-template.ts) and reached through the two bridges inside it (gh-bridge,
 * one per uid). The provider's own command API is only used as root for the
 * boot script and to stop a desktop: it decodes output as text and keeps all
 * of it in memory, so nothing of a member's (files, screens, shells) passes
 * through it.
 *
 * Lifecycle:
 * - start: resume the row's sandbox when it runs the current template with
 *   the member's current settings; otherwise — or after a reset, which must
 *   start everything but the home over, as a docker reset does — create one.
 *   A sandbox's desktop starts exactly once, before any agent process exists
 *   in it (gh-e2b-boot): settings never change in place and a desktop found
 *   down is never restarted where the Bot's processes may still run — both
 *   take the new-sandbox path. When an older one exists, the home moves into
 *   the new sandbox first — each uid copies its own home over its bridges (tar),
 *   with the old desktop stopped so the browser profile is consistent — and
 *   the old sandbox stays paused for RETIRED_KEEP_MS as a fallback copy. Every
 *   start then runs gh-e2b-boot as root (bridge secrets, the member's
 *   settings, the systemd units) and waits for both bridges.
 * - stop / discard = pause (memory and disk kept; a resume is ~1 s and every
 *   process, background jobs included, carries on). wipe = kill, predecessors
 *   too.
 * - The provider's timeout is the dead-man switch: a sandbox nobody renews
 *   (the API is gone) pauses itself after SANDBOX_TIMEOUT_MS; the health loop
 *   renews running ones (`keepAlive`).
 *
 * The bridge secrets are derived — HMAC of the deployment's TOKEN_SIGNING_KEY
 * over the sandbox id and the uid — so any API slot reaches any of its
 * sandboxes without storing a credential, and no secret opens another sandbox
 * or the other uid (after a key rotation the first refused call rewrites
 * them). A row's `container_name` is its sandbox id once started.
 *
 * Every start checks the provider still pauses the sandbox on timeout: a
 * provider that kills instead would lose the member's home whenever the API is
 * away longer than the timeout, so such a sandbox is refused.
 */

import { createHash, createHmac } from 'node:crypto';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import {
  AuthenticationError,
  CommandExitError,
  NotFoundError,
  Sandbox,
  SandboxNotFoundError,
  type SandboxInfo,
} from 'e2b';

import { CLEARED_PROXY_ENV, ComputerDockerError, ComputerRuntimeError } from './docker.js';
import { bridgeExec, bridgeStream, bridgeTunnel, BridgeConnectionError, type BridgeTarget } from './e2b-bridge.js';
import { EGRESS_APPLY_SCRIPT, egressApplyEnv, PROVIDER_DENY_OUT } from './e2b-egress.js';
import { HOME_USERS, homeExportArgv, homeImportArgv, homeOf, pipeIntoImport } from './home-archive.js';
import {
  ComputerStartError,
  type ComputerHost,
  type ComputerProcess,
  type ComputerStartSpec,
  type ComputerUser,
  type ExecOutcome,
  type HomeRestore,
  type HostInstance,
  type StartedComputer,
} from './host.js';

/** gh-bridge ports (apps/bot-computer/e2b/systemd/). */
export const BRIDGE_PORTS: Record<ComputerUser, number> = { browser: 7681, agent: 7682 };
/** A sandbox nobody renews pauses itself this long after its last renewal (or start). */
export const SANDBOX_TIMEOUT_MS = 30 * 60_000;
/** Renewals: at most this often per sandbox, and never past an hour ahead (every plan's ceiling). */
const RENEW_EVERY_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
/** A sandbox replaced by a newer one (its home moved) is kept paused this long. */
export const RETIRED_KEEP_MS = 3 * 24 * 60 * 60_000;
/** A sandbox no row points at (a start that died before recording it) is kept this long. */
export const ORPHAN_GRACE_MS = 60 * 60_000;
const BOOT_TIMEOUT_MS = 90_000;
/** Per bridge: how long a booted bridge may take to answer. */
const BRIDGE_WAIT_MS = 30_000;
/**
 * Moving both homes. The start holds the member's lock (a pooled connection in
 * an open transaction) and one of the start slots meanwhile, so it is bounded:
 * a home at the 5 GiB soft limit moves well within it next to the provider.
 */
const MOVE_TIMEOUT_MS = 10 * 60_000;
/** Tries per home within MOVE_TIMEOUT_MS (a dropped connection restarts that home). */
const MOVE_ATTEMPTS = 3;
/** Putting both homes back from a backup (bounded for the same reason as a move). */
const RESTORE_TIMEOUT_MS = 15 * 60_000;
/**
 * A move into a newer template that failed is not tried again on every start: the member
 * keeps the recovered old computer this long, then the next start tries again. Per API
 * process (a restart simply tries again sooner).
 */
export const MOVE_RETRY_AFTER_MS = 6 * 60 * 60_000;
/**
 * Gives an OLD sandbox whose home failed to move out its desktop back (the move stopped it).
 * Run by the API as root, NOT as a mode of the sandbox's gh-e2b-boot: the old sandbox runs the
 * OLD template, whose script may predate any of this — and a move into a newer template is
 * exactly that case. Only commands every template has. Every process of uid agent is ended and
 * proven gone before the desktop starts again, the same guarantee as a first start (see
 * gh-e2b-boot's header); gh-e2b-rundir (the desktop's ExecStartPre) still refuses a squatted
 * runtime directory.
 */
export const RECOVER_SCRIPT = [
  'set -eu',
  // The agent bridge first, so it starts nothing new. Its socket stays with PID 1; a connection
  // now would start it again — the loop ends that one too.
  'systemctl stop gh-bridge-agent.service',
  'for _ in $(seq 1 20); do pkill -KILL -u agent 2>/dev/null || true; pgrep -u agent >/dev/null || break; sleep 0.25; done',
  'if pgrep -u agent >/dev/null; then echo "processes of uid agent are still running" >&2; exit 5; fi',
  'systemctl start gh-desktop.service',
  'systemctl start gh-bridge-browser.socket gh-bridge-agent.socket gh-bridge-browser.service gh-bridge-agent.service',
].join('\n');
/** After a refused bridge upgrade (a rotated signing key), rewrite the secrets at most this often. */
const REKEY_EVERY_MS = 5 * 60_000;

/** Sandbox metadata keys (the provider stores them with the sandbox). */
const META = {
  namespace: 'gh_ns',
  user: 'gh_user',
  template: 'gh_template',
  /** Hash of the member's settings the sandbox was booted with (they never change in place). */
  settings: 'gh_settings',
  created: 'gh_created',
  replaces: 'gh_replaces',
} as const;

/** One sandbox as the host uses it: its bridges' address and root commands. */
export interface SandboxHandle {
  id: string;
  /** `<port>-<id>.<domain>`. */
  host(port: number): string;
  /** The edge's token for this sandbox's ports (null when public traffic is allowed). */
  trafficToken: string | null;
  /** A root command through the provider's agent (short, text output). */
  runRoot(
    command: string,
    envs: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** The provider calls the host makes (the e2b SDK; tests fake it). */
export interface E2bApi {
  create(template: string, metadata: Record<string, string>): Promise<SandboxHandle>;
  /** Connect (resuming a paused sandbox). */
  connect(id: string): Promise<SandboxHandle>;
  /** null when the sandbox does not exist (any more). */
  getInfo(id: string): Promise<SandboxInfo | null>;
  pause(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  setTimeout(id: string, ms: number): Promise<void>;
  /** This namespace's sandboxes, running and paused. */
  list(namespace: string): Promise<SandboxInfo[]>;
}

/** HostInstance plus what the orphan rules read. */
interface E2bInstance extends HostInstance {
  createdAt: number;
  replaces: string | null;
}

export interface E2bHostOptions {
  api: E2bApi;
  namespace: string;
  /** TOKEN_SIGNING_KEY: the bridge secrets are derived from it. */
  secretKey: string;
  now?: () => number;
  /** Test seam: the bridge client. */
  bridge?: {
    exec: typeof bridgeExec;
    stream: typeof bridgeStream;
    tunnel: typeof bridgeTunnel;
  };
}

/** A provider sandbox id (as opposed to the docker-style name a row starts with). */
export function isSandboxId(ref: string): boolean {
  return /^[a-z0-9]{8,64}$/.test(ref);
}

/** The bridge secret of one uid in one sandbox. */
export function bridgeSecret(secretKey: string, sandboxId: string, user: ComputerUser): string {
  return createHmac('sha256', secretKey).update(`gh-bridge:${sandboxId}:${user}`).digest('hex');
}

/** What a sandbox records of the settings it was booted with. */
export function settingsHash(spec: ComputerStartSpec): string {
  return createHash('sha256').update(computerEnvFile(spec)).digest('hex').slice(0, 16);
}

/**
 * /etc/gh-computer/env — the member's settings as a systemd EnvironmentFile
 * (what a docker computer gets as `docker run -e`). Every value is validated
 * before it gets here (config.ts); a line break would still be refused.
 */
export function computerEnvFile(spec: ComputerStartSpec): string {
  const entries: Array<[string, string]> = [
    ...CLEARED_PROXY_ENV.map((key): [string, string] => [key, '']),
    ['GH_COMPUTER_PROXY', spec.config.proxy ?? ''],
    ['GH_COMPUTER_URL_BLOCKLIST', spec.urlBlocklist.join(',')],
    ['GH_COMPUTER_LANG', spec.lang],
    ['TZ', spec.timezone],
  ];
  for (const [key, value] of entries) {
    if (/[\r\n"'\\]/.test(value)) throw new Error(`${key} has a character the computer's settings file cannot carry`);
  }
  return entries.map(([key, value]) => `${key}=${value}`).join('\n');
}

/**
 * The provider cannot be reached at all (its name does not resolve, nothing
 * answers): closes the runtime until the re-check. A timeout or a reset on one
 * request is not that — it fails only the call that met it.
 */
const UNREACHABLE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo/;

function errorCode(err: unknown): string {
  const own = (err as { code?: unknown })?.code;
  const cause = (err as { cause?: { code?: unknown } })?.cause?.code;
  return [own, cause].filter((value) => typeof value === 'string').join(' ');
}

/** A provider call that failed, as the error class the controller acts on. */
export function providerError(err: unknown, what: string): Error {
  if (err instanceof ComputerRuntimeError || err instanceof ComputerDockerError) return err;
  const status = (err as { statusCode?: unknown })?.statusCode;
  if (err instanceof AuthenticationError || status === 401 || status === 403) {
    return new ComputerRuntimeError('provider_auth', `${what}: the sandbox provider refused the API key`, {
      cause: err,
    });
  }
  const message = toErrorMessage(err);
  const cause = (err as { cause?: unknown })?.cause;
  if (UNREACHABLE.test(`${errorCode(err)} ${message} ${cause ? toErrorMessage(cause) : ''}`)) {
    return new ComputerRuntimeError(
      'provider_unreachable',
      `${what}: the sandbox provider is unreachable (${message})`,
      {
        cause: err,
      },
    );
  }
  if (err instanceof SandboxNotFoundError) return new ComputerDockerError('not_found', `${what}: ${message}`);
  return new ComputerDockerError('failed', `${what}: ${message}`);
}

/** The real provider through the e2b SDK. */
export function createE2bApi(conn: { apiKey: string; domain?: string }): E2bApi {
  const opts = { apiKey: conn.apiKey, ...(conn.domain ? { domain: conn.domain } : {}) };
  const handle = (sandbox: Sandbox): SandboxHandle => ({
    id: sandbox.sandboxId,
    host: (port) => sandbox.getHost(port),
    trafficToken: sandbox.trafficAccessToken ?? null,
    async runRoot(command, envs, timeoutMs) {
      try {
        const result = await sandbox.commands.run(command, { user: 'root', cwd: '/', envs, timeoutMs });
        return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch (err) {
        if (err instanceof CommandExitError) return { code: err.exitCode, stdout: err.stdout, stderr: err.stderr };
        throw err;
      }
    },
  });
  return {
    async create(template, metadata) {
      return handle(
        await Sandbox.create(template, {
          ...opts,
          metadata,
          timeoutMs: SANDBOX_TIMEOUT_MS,
          // Every port needs the edge's token (the bridges add their own secret on top); private
          // ranges are refused outside the VM, whatever runs in it (e2b-egress.ts).
          network: { allowPublicTraffic: false, denyOut: PROVIDER_DENY_OUT },
          // Paused by the dead-man timeout, resumed only by the controller.
          lifecycle: { onTimeout: 'pause', autoResume: false },
        }),
      );
    },
    async connect(id) {
      return handle(await Sandbox.connect(id, { ...opts, timeoutMs: SANDBOX_TIMEOUT_MS }));
    },
    async getInfo(id) {
      try {
        return await Sandbox.getInfo(id, opts);
      } catch (err) {
        if (err instanceof NotFoundError) return null;
        throw err;
      }
    },
    async pause(id) {
      try {
        await Sandbox.pause(id, opts);
      } catch (err) {
        if (err instanceof NotFoundError) return;
        throw err;
      }
    },
    async kill(id) {
      await Sandbox.kill(id, opts);
    },
    async setTimeout(id, ms) {
      await Sandbox.setTimeout(id, ms, opts);
    },
    async list(namespace) {
      const paginator = Sandbox.list({
        ...opts,
        query: { metadata: { [META.namespace]: namespace }, state: ['running', 'paused'] },
      });
      const items: SandboxInfo[] = [];
      while (paginator.hasNext) items.push(...(await paginator.nextItems()));
      return items;
    },
  };
}

export function createE2bHost(opts: E2bHostOptions): ComputerHost {
  const { api, namespace, secretKey } = opts;
  // An empty or short key would make every bridge secret derivable from the sandbox id the agent can read.
  if (!/^[0-9a-fA-F]{64}$/.test(secretKey)) {
    throw new Error('The hosted computer driver needs TOKEN_SIGNING_KEY (64 hex characters) for its bridge secrets');
  }
  const now = opts.now ?? Date.now;
  const bridge = opts.bridge ?? { exec: bridgeExec, stream: bridgeStream, tunnel: bridgeTunnel };
  /** Connected sandboxes (their edge token), by id. */
  const handles = new Map<string, Promise<SandboxHandle>>();
  const renewedAt = new Map<string, number>();
  const rekeyedAt = new Map<string, number>();
  /** Members whose move into a newer template failed: keep waking `from` until `at` (MOVE_RETRY_AFTER_MS). */
  const moveRetry = new Map<string, { from: string; at: number }>();
  let lifecycleUnreported = false;

  function movingBackOff(userId: string, sandboxId: string): boolean {
    const entry = moveRetry.get(userId);
    if (!entry) return false;
    if (entry.from === sandboxId && now() < entry.at) return true;
    moveRetry.delete(userId);
    return false;
  }

  const ours = (info: SandboxInfo | null): info is SandboxInfo => info?.metadata?.[META.namespace] === namespace;

  function remember(sandbox: SandboxHandle): SandboxHandle {
    handles.set(sandbox.id, Promise.resolve(sandbox));
    return sandbox;
  }

  function forget(id: string): void {
    handles.delete(id);
    renewedAt.delete(id);
  }

  async function info(id: string): Promise<SandboxInfo | null> {
    if (!isSandboxId(id)) return null;
    try {
      const found = await api.getInfo(id);
      return ours(found) ? found : null;
    } catch (err) {
      throw providerError(err, 'Reading the computer');
    }
  }

  /**
   * A running sandbox's handle for the exec surface. A miss never resumes a
   * paused one (that is a start, the controller's call): it reports the
   * computer as not running instead.
   */
  async function handleFor(id: string): Promise<SandboxHandle> {
    const cached = handles.get(id);
    if (cached) return await cached;
    const pending = (async () => {
      const found = await info(id);
      if (!found) throw new ComputerDockerError('not_found', 'The computer is gone');
      if (found.state !== 'running') throw new ComputerDockerError('not_running', 'The computer is asleep');
      try {
        return await api.connect(id);
      } catch (err) {
        throw providerError(err, 'Connecting to the computer');
      }
    })();
    handles.set(id, pending);
    try {
      return await pending;
    } catch (err) {
      if (handles.get(id) === pending) handles.delete(id);
      throw err;
    }
  }

  function targetOf(sandbox: SandboxHandle, user: ComputerUser): BridgeTarget {
    const headers: Record<string, string> = { 'x-gh-bridge-secret': bridgeSecret(secretKey, sandbox.id, user) };
    if (sandbox.trafficToken) headers['e2b-traffic-access-token'] = sandbox.trafficToken;
    return { origin: `wss://${sandbox.host(BRIDGE_PORTS[user])}`, headers };
  }

  /** A bridge connection failed: is the computer still there (the controller acts on not_found / not_running)? */
  async function classify(id: string, err: unknown): Promise<Error> {
    if (!(err instanceof BridgeConnectionError)) return err instanceof Error ? err : new Error(String(err));
    forget(id);
    const found = await info(id).catch(() => undefined);
    if (found === null) return new ComputerDockerError('not_found', 'The computer is gone');
    if (found && found.state !== 'running') return new ComputerDockerError('not_running', 'The computer is asleep');
    return new ComputerDockerError('failed', err.message);
  }

  async function runRootCommand(
    sandbox: SandboxHandle,
    command: string,
    envs: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      return await sandbox.runRoot(command, envs, timeoutMs);
    } catch (err) {
      throw providerError(err, command.split(' ')[0] ?? 'A root command');
    }
  }

  async function runRoot(sandbox: SandboxHandle, command: string, envs: Record<string, string>, timeoutMs: number) {
    const result = await runRootCommand(sandbox, command, envs, timeoutMs);
    if (result.code !== 0) {
      throw new ComputerDockerError(
        'failed',
        `${command.split(' ')[0]} exited ${result.code}: ${result.stderr.trim().slice(-400)}`,
      );
    }
  }

  const secretEnv = (sandbox: SandboxHandle) => ({
    GH_BRIDGE_SECRET_BROWSER: bridgeSecret(secretKey, sandbox.id, 'browser'),
    GH_BRIDGE_SECRET_AGENT: bridgeSecret(secretKey, sandbox.id, 'agent'),
  });

  /**
   * gh-e2b-boot (secrets, the member's settings, the units), then wait for the
   * bridges. `resume` answers `fresh` when this sandbox cannot carry on as it
   * is: its desktop is down, or it was booted with other settings.
   */
  /**
   * The member uids' egress table (e2b-egress.ts), as root, before anything of the member runs —
   * on every boot (it is idempotent): a computer of any template gets the API's current rules.
   */
  async function applyEgress(sandbox: SandboxHandle): Promise<void> {
    const result = await runRootCommand(sandbox, EGRESS_APPLY_SCRIPT, egressApplyEnv(), BOOT_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new ComputerDockerError(
        'failed',
        `Applying the computer's egress rules failed (exit ${result.code}): ${result.stderr.trim().slice(-300)}`,
      );
    }
  }

  async function boot(
    sandbox: SandboxHandle,
    spec: ComputerStartSpec,
    mode: 'first' | 'bridges-only' | 'resume',
    /** The env file to boot with, base64 — default: the member's current settings. */
    envFile: string = Buffer.from(computerEnvFile(spec)).toString('base64'),
  ): Promise<'ok' | 'fresh'> {
    await applyEgress(sandbox);
    const flag = mode === 'first' ? '' : ` --${mode}`;
    const result = await runRootCommand(
      sandbox,
      `/usr/local/sbin/gh-e2b-boot${flag}`,
      { ...secretEnv(sandbox), GH_COMPUTER_ENV_B64: envFile },
      BOOT_TIMEOUT_MS,
    );
    if (mode === 'resume' && (result.code === 3 || result.code === 4)) return 'fresh';
    if (result.code !== 0) {
      throw new ComputerDockerError('failed', `gh-e2b-boot exited ${result.code}: ${result.stderr.trim().slice(-400)}`);
    }
    await waitForBridges(sandbox);
    return 'ok';
  }

  /** A refused bridge upgrade on a running sandbox: the signing key may have rotated — rewrite the secrets once. */
  async function rekey(id: string): Promise<boolean> {
    if (now() - (rekeyedAt.get(id) ?? 0) < REKEY_EVERY_MS) return false;
    rekeyedAt.set(id, now());
    forget(id);
    try {
      const sandbox = await handleFor(id);
      await runRoot(sandbox, '/usr/local/sbin/gh-e2b-boot --secrets-only', secretEnv(sandbox), BOOT_TIMEOUT_MS);
      logger.info('[bots-computer] rewrote the bridge secrets of a computer that refused them', { container: id });
      return true;
    } catch (err) {
      logger.warn(`[bots-computer] could not rewrite the bridge secrets of ${id}: ${toErrorMessage(err)}`);
      return false;
    }
  }

  /**
   * The provider must pause this sandbox on timeout, never kill it (the dead-man
   * switch must not delete the member's home). A provider that does not report
   * its lifecycle is warned about once.
   */
  async function assertPausesOnTimeout(id: string): Promise<void> {
    const found = await info(id);
    const onTimeout = found?.lifecycle?.onTimeout;
    if (onTimeout === 'pause') return;
    if (onTimeout === undefined) {
      if (!lifecycleUnreported) {
        lifecycleUnreported = true;
        logger.warn('[bots-computer] the sandbox provider does not report what it does on timeout; assuming pause');
      }
      return;
    }
    throw new ComputerRuntimeError(
      'provider_unsupported',
      `The sandbox provider would ${onTimeout} computer ${id} on timeout instead of pausing it; computers stay off so no home is lost`,
    );
  }

  async function waitForBridges(sandbox: SandboxHandle): Promise<void> {
    for (const user of ['agent', 'browser'] as const) {
      const deadline = now() + BRIDGE_WAIT_MS;
      for (;;) {
        let last: string;
        try {
          const result = await bridge.exec(targetOf(sandbox, user), { argv: ['true'], timeoutMs: 10_000 });
          if (result.code === 0) break;
          last = `exit ${result.code}`;
        } catch (err) {
          last = toErrorMessage(err);
        }
        if (now() >= deadline) throw new ComputerDockerError('timeout', `The ${user} bridge did not answer (${last})`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  /**
   * Each uid streams its own home from the old sandbox into the new one (tar over the two
   * bridges). One home is tried up to MOVE_ATTEMPTS times within the move's overall deadline:
   * a dropped connection restarts that home from the top (tar -x overwrites what landed).
   */
  async function moveHome(from: SandboxHandle, to: SandboxHandle): Promise<void> {
    const deadline = now() + MOVE_TIMEOUT_MS;
    // The old browser first: Chromium writes its profile out as it closes.
    await runRoot(from, 'systemctl stop gh-desktop.service', {}, 60_000);
    for (const [user, home] of [
      ['agent', '/home/agent'],
      ['browser', '/home/browser'],
    ] as const) {
      for (let attempt = 1; ; attempt++) {
        try {
          await moveOneHome(from, to, user, home, deadline);
          break;
        } catch (err) {
          if (attempt >= MOVE_ATTEMPTS || now() >= deadline) throw err;
          logger.warn(
            `[bots-computer] moving ${home} failed (attempt ${attempt}), trying again: ${toErrorMessage(err)}`,
          );
        }
      }
    }
  }

  async function moveOneHome(
    from: SandboxHandle,
    to: SandboxHandle,
    user: ComputerUser,
    home: string,
    deadline: number,
  ): Promise<void> {
    // A file this uid cannot read (the other uid's 0600 file in Downloads) is skipped, not fatal; the
    // new home's own folders (Downloads is setgid, shared with the browser) keep their owner and mode.
    const source = bridge.stream(targetOf(from, user), ['tar', '-C', home, '--ignore-failed-read', '-cpf', '-', '.'], {
      cwd: '/',
    });
    const sink = bridge.stream(targetOf(to, user), ['tar', '-C', home, '--no-overwrite-dir', '-xpf', '-'], {
      cwd: '/',
    });
    source.stdout!.pipe(sink.stdin!);
    // Like a child's, a stream's 'close' waits for its stdout to be read: tar -x prints nothing, drain it anyway.
    sink.stdout!.resume();
    // The same rule bites the source when the sink goes first: the pipe lets go, nobody reads the source
    // any more and its 'close' never comes — the start would hang for ever, holding the member's lock.
    const drainSource = () => {
      source.stdout!.unpipe(sink.stdin!);
      source.stdout!.resume();
    };
    sink.once('exit', (code: number | null) => {
      drainSource();
      // A sink that failed (its connection dropped) has no use for the rest: stop the source as well. One
      // that succeeded read the whole archive (tar may exit at its end marker) — the source ends on its own.
      if (code !== 0) source.kill('SIGKILL');
    });
    const timer = setTimeout(
      () => {
        drainSource();
        source.kill('SIGKILL');
        sink.kill('SIGKILL');
      },
      Math.max(0, deadline - now()),
    );
    try {
      const [read, write] = await Promise.all([finished(source), finished(sink)]);
      // GNU tar: 1 = a file changed while it was read (a job still writing) — the copy is still complete.
      if ((read.code !== 0 && read.code !== 1) || write.code !== 0) {
        throw new ComputerDockerError(
          'failed',
          `Moving ${home} failed (read ${read.code}, write ${write.code}): ${(read.stderr || write.stderr).slice(-300)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Put a backup into a new sandbox's homes, each as its own uid through its bridge (home-archive.ts). */
  async function restoreHome(to: SandboxHandle, source: HomeRestore): Promise<void> {
    const deadline = now() + RESTORE_TIMEOUT_MS;
    for (const user of HOME_USERS) {
      const data = await source.open(user);
      const sink = bridge.stream(targetOf(to, user), homeImportArgv(user), { cwd: '/' });
      await pipeIntoImport(data, sink, Math.max(1, deadline - now()));
    }
  }

  /** The env file a sandbox was booted with, base64 (null when it cannot be read: move instead). */
  async function keptSettings(sandbox: SandboxHandle): Promise<string | null> {
    const result = await runRootCommand(sandbox, 'base64 -w0 /etc/gh-computer/env', {}, BOOT_TIMEOUT_MS);
    const value = result.stdout.trim();
    return result.code === 0 && /^[A-Za-z0-9+/]+=*$/.test(value) ? value : null;
  }

  /**
   * After a failed move: give the OLD sandbox its desktop back (RECOVER_SCRIPT ends every agent
   * process first — the start-once guarantee), so the member is not locked out of a computer
   * whose home is intact. False when that did not work; the caller then leaves it paused as before.
   */
  async function recoverOld(old: SandboxHandle): Promise<boolean> {
    try {
      const sandbox = await resume(old.id);
      // The member gets this one back: with the current rules, before its desktop starts again.
      await applyEgress(sandbox);
      const result = await runRootCommand(sandbox, RECOVER_SCRIPT, {}, BOOT_TIMEOUT_MS);
      if (result.code !== 0) {
        logger.warn(
          `[bots-computer] could not recover ${old.id}: exit ${result.code}: ${result.stderr.trim().slice(-300)}`,
        );
        return false;
      }
      await waitForBridges(sandbox);
      return true;
    } catch (err) {
      logger.warn(`[bots-computer] could not recover ${old.id}: ${toErrorMessage(err)}`);
      return false;
    }
  }

  async function pauseQuietly(id: string, why: string): Promise<void> {
    try {
      await api.pause(id);
    } catch (err) {
      logger.warn(`[bots-computer] could not pause ${id} (${why}): ${toErrorMessage(err)}`);
    }
  }

  async function killQuietly(id: string, why: string): Promise<void> {
    forget(id);
    try {
      await api.kill(id);
    } catch (err) {
      logger.warn(`[bots-computer] could not remove ${id} (${why}): ${toErrorMessage(err)}`);
    }
  }

  async function create(
    row: { user_id: string },
    template: string,
    settings: string,
    replaces: string | null,
  ): Promise<SandboxHandle> {
    try {
      return remember(
        await api.create(template, {
          [META.namespace]: namespace,
          [META.user]: row.user_id,
          [META.template]: template,
          [META.settings]: settings,
          [META.created]: new Date(now()).toISOString(),
          ...(replaces ? { [META.replaces]: replaces } : {}),
        }),
      );
    } catch (err) {
      throw providerError(err, 'Creating the computer');
    }
  }

  async function resume(id: string): Promise<SandboxHandle> {
    forget(id);
    try {
      return remember(await api.connect(id));
    } catch (err) {
      throw providerError(err, 'Waking the computer');
    }
  }

  const host: ComputerHost = {
    kind: 'e2b',
    sharedDisk: false,

    async exec(spec): Promise<ExecOutcome> {
      const sandbox = await handleFor(spec.container);
      try {
        return await bridge.exec(targetOf(sandbox, spec.user), spec);
      } catch (err) {
        // Refused at the door of a sandbox that is up: a rotated key (or a stale edge token). Once, and
        // only when the input can be sent again.
        const replayable = !(spec.input && typeof (spec.input as { pipe?: unknown }).pipe === 'function');
        if (err instanceof BridgeConnectionError && err.status === 403 && replayable && (await rekey(spec.container))) {
          try {
            return await bridge.exec(targetOf(await handleFor(spec.container), spec.user), spec);
          } catch (retryErr) {
            throw await classify(spec.container, retryErr);
          }
        }
        throw await classify(spec.container, err);
      }
    },

    execStream(container, user, argv, streamOpts = {}): ComputerProcess {
      return bridge.stream(
        handleFor(container).then((sandbox) => targetOf(sandbox, user)),
        argv,
        streamOpts,
      );
    },

    exportHome(container, user): ComputerProcess {
      return bridge.stream(
        handleFor(container).then((sandbox) => targetOf(sandbox, user)),
        homeExportArgv(user),
        { cwd: homeOf(user) },
      );
    },

    openTunnel(container, target): ComputerProcess {
      return bridge.tunnel(
        handleFor(container).then((sandbox) => targetOf(sandbox, 'browser')),
        target === 'vnc' ? '/vnc' : '/cdp',
      );
    },

    openPort(container, port): ComputerProcess {
      // The agent bridge (GH_BRIDGE_PORTS), which checks the port again.
      return bridge.tunnel(
        handleFor(container).then((sandbox) => targetOf(sandbox, 'agent')),
        `/port?n=${port}`,
      );
    },

    async start(row, spec): Promise<StartedComputer> {
      const template = spec.image;
      if (!template) throw new ComputerRuntimeError('template_missing', 'The computer template is not ready yet');
      const settings = settingsHash(spec);
      const current = await info(row.container_name);
      if (row.container_name && isSandboxId(row.container_name) && !current) {
        logger.warn('[bots-computer] the computer recorded for this member is gone; starting a new one', {
          user_id: row.user_id,
          container: row.container_name,
        });
      }
      if (current && current.metadata[META.user] !== row.user_id) {
        throw new ComputerDockerError('failed', `Sandbox ${current.sandboxId} does not belong to this member`);
      }

      // The same template and settings: wake it. So too an older one while a move into the
      // current template backs off after failing (MOVE_RETRY_AFTER_MS) — with the settings it has.
      const backingOff = current ? movingBackOff(row.user_id, current.sandboxId) : false;
      const matches = current?.metadata[META.template] === template && current?.metadata[META.settings] === settings;
      if (current && !spec.fresh && (matches || backingOff)) {
        const sandbox = await resume(current.sandboxId);
        await assertPausesOnTimeout(sandbox.id);
        // Backing off, it keeps the settings it has: read them back, and wake it with the plain
        // `--resume` every template knows (an older template's gh-e2b-boot is what runs here).
        const envFile = matches ? undefined : await keptSettings(sandbox);
        if (envFile !== null && (await boot(sandbox, spec, 'resume', envFile)) === 'ok') {
          return {
            ref: sandbox.id,
            imageId: current.metadata[META.template] ?? template,
            abandon: async () => {
              forget(sandbox.id);
              await api.pause(sandbox.id);
            },
          };
        }
        // Its desktop is down: never restarted where the Bot's processes may run — start over around the home.
        logger.info('[bots-computer] a woken computer cannot carry on as it is; moving its home to a new one', {
          user_id: row.user_id,
          container: sandbox.id,
        });
      }

      // Nothing to move from although the member had a computer (gone, another provider): the newest backup.
      const restoreFrom = !current && spec.restore ? await spec.restore() : null;
      // A new sandbox — the first one, or one replacing an older template, other settings, a reset.
      const fresh = await create(row, template, settings, current?.sandboxId ?? null);
      /** Set once the old sandbox was woken for the move: from then on its desktop may be down. */
      let movedFrom: SandboxHandle | null = null;
      try {
        await assertPausesOnTimeout(fresh.id);
        if (restoreFrom) {
          await boot(fresh, spec, 'bridges-only');
          const startedAt = now();
          try {
            await restoreHome(fresh, restoreFrom);
          } catch (err) {
            throw new ComputerStartError(
              'restore_failed',
              `Restoring the backup of ${restoreFrom.takenAt} failed: ${toErrorMessage(err)}`,
              { cause: err },
            );
          }
          logger.info('[bots-computer] restored a home from its backup', {
            user_id: row.user_id,
            backup: restoreFrom.backupId,
            to: fresh.id,
            duration_ms: now() - startedAt,
          });
        }
        if (current) {
          await boot(fresh, spec, 'bridges-only');
          movedFrom = await resume(current.sandboxId);
          const startedAt = now();
          await moveHome(movedFrom, fresh);
          logger.info('[bots-computer] moved a home to a new computer', {
            user_id: row.user_id,
            from: current.sandboxId,
            to: fresh.id,
            template,
            duration_ms: now() - startedAt,
          });
          // Kept paused as the fallback copy (RETIRED_KEEP_MS, removeOrphan).
          await pauseQuietly(current.sandboxId, 'replaced');
        }
        await boot(fresh, spec, 'first');
      } catch (err) {
        await killQuietly(fresh.id, 'start failed');
        if (!current) throw err;
        if (!movedFrom) {
          await pauseQuietly(current.sandboxId, 'start failed');
          throw err;
        }
        // The move stopped the old desktop. Left like that, this computer could only ever start
        // by moving again — every start, however bad the link. Give the old one its desktop back.
        const recovered = await recoverOld(movedFrom);
        logger.warn('[bots-computer] moving a home failed', {
          user_id: row.user_id,
          from: current.sandboxId,
          recovered,
          reset: spec.fresh,
          error: toErrorMessage(err),
        });
        if (recovered && !spec.fresh) {
          // An upgrade or new settings: the member carries on with the old computer; the move waits.
          moveRetry.set(row.user_id, { from: current.sandboxId, at: now() + MOVE_RETRY_AFTER_MS });
          return {
            ref: current.sandboxId,
            imageId: current.metadata[META.template] ?? template,
            abandon: async () => {
              forget(current.sandboxId);
              await api.pause(current.sandboxId);
            },
          };
        }
        // A reset asked for a fresh system: say it did not happen (the next start wakes the old one).
        await pauseQuietly(current.sandboxId, 'start failed');
        throw new ComputerStartError(
          'move_failed',
          `Moving the home to a new computer failed: ${toErrorMessage(err)}`,
          {
            cause: err,
          },
        );
      }
      moveRetry.delete(row.user_id);
      return {
        ref: fresh.id,
        imageId: template,
        ...(restoreFrom ? { restoredFrom: restoreFrom.backupId } : {}),
        // The row still points at the old sandbox (or none): this one holds nothing it needs.
        abandon: () => killQuietly(fresh.id, 'start abandoned'),
      };
    },

    async stop(ref) {
      forget(ref);
      if (!isSandboxId(ref)) return;
      try {
        await api.pause(ref);
      } catch (err) {
        throw providerError(err, 'Pausing the computer');
      }
    },

    async discard(ref) {
      await host.stop(ref);
    },

    async wipe(row) {
      const doomed = new Set<string>();
      if (isSandboxId(row.container_name)) doomed.add(row.container_name);
      try {
        for (const sandbox of await api.list(namespace)) {
          if (sandbox.metadata?.[META.user] === row.user_id) doomed.add(sandbox.sandboxId);
        }
      } catch (err) {
        throw providerError(err, 'Listing the computers');
      }
      for (const id of doomed) {
        forget(id);
        try {
          await api.kill(id);
        } catch (err) {
          if (err instanceof NotFoundError) continue;
          throw providerError(err, 'Removing the computer');
        }
      }
    },

    async list(ns) {
      let sandboxes: SandboxInfo[];
      try {
        sandboxes = await api.list(ns);
      } catch (err) {
        throw providerError(err, 'Listing the computers');
      }
      return sandboxes.map((sandbox): E2bInstance => {
        const created = Date.parse(sandbox.metadata?.[META.created] ?? '');
        return {
          ref: sandbox.sandboxId,
          userId: sandbox.metadata?.[META.user] ?? '',
          running: sandbox.state === 'running',
          createdAt: Number.isFinite(created) ? created : sandbox.startedAt.getTime(),
          replaces: sandbox.metadata?.[META.replaces] ?? null,
        };
      });
    },

    async inspect(ref) {
      const found = await info(ref);
      return found ? { running: found.state === 'running' } : null;
    },

    async verdict(ref, instance) {
      const found = instance ?? (await info(ref).then((i) => (i ? { running: i.state === 'running' } : undefined)));
      // Paused without the controller — the plan's session limit, or the dead-man timeout
      // while the API was away: asleep, not broken, and NOT idle (work may have been running;
      // it is frozen and carries on at the next start). The member is told which it was.
      if (found && !found.running) return { state: 'absent', reason: 'provider_timeout' };
      return { state: 'error', reason: 'exited' };
    },

    async removeOrphan(instance, all) {
      const orphan = instance as E2bInstance;
      const replacement = (all as E2bInstance[]).find((other) => other.replaces === orphan.ref);
      const since = replacement ? replacement.createdAt : orphan.createdAt;
      if (now() - since < (replacement ? RETIRED_KEEP_MS : ORPHAN_GRACE_MS)) return false;
      forget(orphan.ref);
      try {
        await api.kill(orphan.ref);
      } catch (err) {
        if (err instanceof NotFoundError) return false;
        throw providerError(err, 'Removing an orphan computer');
      }
      return true;
    },

    async sweepStorage() {
      // A sandbox is its own storage: removeOrphan covers it.
      return 0;
    },

    async keepAlive(row, idleMinutes) {
      const id = row.container_name;
      if (!isSandboxId(id)) return;
      const last = renewedAt.get(id) ?? 0;
      if (now() - last < RENEW_EVERY_MS) return;
      // Stamped before the call: a failing renewal is retried on the same schedule, not every health tick.
      renewedAt.set(id, now());
      try {
        await api.setTimeout(id, Math.min((idleMinutes + 10) * 60_000, MAX_TIMEOUT_MS));
      } catch (err) {
        throw providerError(err, 'Renewing the computer');
      }
    },

    async memoryUsage() {
      return new Map<string, number>();
    },
  };
  return host;
}

/** A stream's exit code and the tail of its stderr. */
function finished(child: ComputerProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.once('error', () => {});
    child.once('close', (code) => resolve({ code, stderr }));
  });
}
