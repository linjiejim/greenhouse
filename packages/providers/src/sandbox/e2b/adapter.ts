/**
 * Agent computers at an E2B-protocol provider (E2B; PPIO and other hosts that speak its API): one
 * microVM per computer, from the template built out of apps/bot-computer (its Dockerfile plus the
 * hosted layer in apps/bot-computer/e2b/; scripts/e2b-template.mts builds it and prints its name).
 * Ported from v1, which ran this design in production.
 *
 * A computer is the sandbox whose metadata names it (gh_ns + gh_name). Stop pauses it: memory and
 * disk are kept, so the home and every process carry on when it resumes, in about a second; there
 * is no volume, the paused sandbox is the home. Remove kills it, and with it the home. The
 * provider's timeout is the dead-man switch: a running computer nobody renews (the API is gone)
 * pauses itself; a provider that says it would kill instead is refused, so no home is lost.
 *
 * Every port is private: created with public traffic off, the provider's edge refuses a request
 * without the sandbox's traffic token, and each of the two bridges (bridge.ts) also checks its
 * account's secret, an HMAC of the API key over the sandbox and the account. The screen and
 * DevTools stay 0600 Unix sockets of the browser account that only its bridge opens. envd, the
 * provider's agent, does root work only (egress.ts, the boot script, a restart); before a computer
 * is used its network rules are applied and probed from both member accounts.
 */

import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { ProviderRequestError } from '../../http.js';
import { assertPinned } from '../../pinned-fetch.js';
import type {
  ExecResult,
  ProviderAdapter,
  ProviderPreset,
  SandboxClient,
  SandboxSpec,
  SandboxStream,
} from '../../types.js';
import { createE2bApi, findTemplate, type Connected, type E2bApi, type SandboxInfo } from './api.js';
import {
  BridgeError,
  BridgeStream,
  bridgeRun,
  connectWebSocket,
  type BridgeMode,
  type BridgeTarget,
  type Connector,
} from './bridge.js';
import { EGRESS_APPLY_SCRIPT, EGRESS_PROBE_ARGV, PROVIDER_DENY_OUT, egressApplyEnv, egressLeaks } from './egress.js';
import { ENVD_PORT, envdRun, type EnvdTarget } from './envd.js';

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const e2bConfigSchema = z.object({
  /** The provider: its API is https://api.<domain>, a computer's ports <port>-<id>.<domain>. */
  domain: z.string().regex(DOMAIN).default('e2b.app'),
  /** The computer template's name or id (scripts/e2b-template.mts builds it). */
  template: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$/),
  /** This deployment's computers; a second deployment on the same account (a restored copy) needs its own. */
  namespace: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
    .default('greenhouse'),
  /** A running computer pauses itself this long after the API last reached it. */
  timeoutMinutes: z.number().int().min(10).max(1440).default(60),
});
export type E2bConfig = z.infer<typeof e2bConfigSchema>;

export const E2B_PRESETS: readonly ProviderPreset[] = [
  { id: 'e2b', label: 'E2B', config: { domain: 'e2b.app' }, docsUrl: 'https://e2b.dev/docs' },
  {
    id: 'ppio',
    label: 'PPIO 派欧云',
    config: { domain: 'cn-beijing-1.sandbox.ppio.com' },
    docsUrl: 'https://ppio.com/docs/sandbox/overview',
  },
];

/** gh-bridge ports (apps/bot-computer/e2b/systemd/). */
export const BRIDGE_PORTS = { browser: 7681, agent: 7682 } as const;
type Account = keyof typeof BRIDGE_PORTS;

const NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const TIMEZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;
const AGENT_HOME = '/home/agent';
const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const DEFAULT_OUTPUT_CAP = 1024 * 1024;
/** The boot script, the network rules and a restart. */
const ROOT_TIMEOUT_MS = 90_000;
/** Per bridge: how long a booted bridge may take to answer. */
const BRIDGE_WAIT_MS = 30_000;
/** `timeout -k`: a command that ignores the deadline's TERM is killed this much later. */
const KILL_AFTER_S = 5;
/** After the deadline inside the computer, how long the API waits before it gives up on the answer. */
const EXEC_GRACE_MS = 15_000;
/** Renewals of the provider's timeout: at most this often per computer, also while a stream is open. */
const RENEW_EVERY_MS = 5 * 60_000;
/** After a refused bridge connection (a new API key), rewrite the secrets at most this often. */
const REKEY_EVERY_MS = 5 * 60_000;
/** What a fresh docker computer has in its environment: no proxy inherited from anywhere. */
const CLEARED_PROXY_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
];

/**
 * A restart in place, as root: every process of the member accounts ends (proven gone before the
 * desktop starts again, so nothing of the Agent's can hold the display's names), their leftovers in
 * the temporary folders go as a docker computer's fresh tmpfs would, and the boot script starts
 * the bridges and the desktop with the caller's settings, or else the ones it had. The home stays.
 */
export const RESET_SCRIPT = [
  'set -eu',
  'systemctl stop gh-desktop.service gh-bridge-agent.service gh-bridge-browser.service',
  'for _ in $(seq 1 40); do',
  '  pkill -KILL -u agent 2>/dev/null || true',
  '  pkill -KILL -u browser 2>/dev/null || true',
  '  pgrep -u agent >/dev/null || pgrep -u browser >/dev/null || break',
  '  sleep 0.25',
  'done',
  'if pgrep -u agent >/dev/null || pgrep -u browser >/dev/null; then',
  '  echo "processes of the member accounts are still running" >&2',
  '  exit 5',
  'fi',
  'find /tmp /var/tmp /dev/shm -xdev -mindepth 1 -maxdepth 1 \\( -user agent -o -user browser \\) -exec rm -rf -- {} + 2>/dev/null || true',
  'if [ -z "${GH_COMPUTER_ENV_B64:-}" ]; then GH_COMPUTER_ENV_B64=$(base64 -w0 /etc/gh-computer/env); export GH_COMPUTER_ENV_B64; fi',
  'rm -f /etc/gh-computer/env',
  'exec /usr/local/sbin/gh-e2b-boot',
].join('\n');

/** The bridge secret of one account in one sandbox: only the API, which holds the key, can make it. */
export function bridgeSecret(apiKey: string, sandboxId: string, account: Account): string {
  return createHmac('sha256', apiKey).update(`gh-bridge:${sandboxId}:${account}`).digest('hex');
}

/** /etc/gh-computer/env: what a docker computer gets as `docker run -e`. */
export function settingsOf(spec: Pick<SandboxSpec, 'timezone'>): string {
  if (!TIMEZONE.test(spec.timezone)) {
    throw new ProviderRequestError(`"${spec.timezone.slice(0, 64)}" is not a time zone the computer can use.`);
  }
  return [...CLEARED_PROXY_ENV.map((key) => `${key}=`), `TZ=${spec.timezone}`].join('\n');
}

/** argv with its deadline enforced inside the computer: TERM at the deadline, KILL a little later. */
export function withDeadline(argv: string[], timeoutMs: number, timeoutBin = 'timeout'): string[] {
  return [timeoutBin, '-k', String(KILL_AFTER_S), (Math.max(timeoutMs, 1000) / 1000).toFixed(3), ...argv];
}

/** How to reach one running sandbox. */
interface Handle {
  id: string;
  domain: string;
  envdToken?: string;
  trafficToken: string;
}

/** What this process knows about one instance's computers; clients are made per call, this outlives them. */
interface Directory {
  handles: Map<string, Handle>;
  locks: Map<string, Promise<void>>;
  renewedAt: Map<string, number>;
  rekeyedAt: Map<string, number>;
  warnedLifecycle: boolean;
}

const directories = new Map<string, Directory>();

function directoryOf(config: E2bConfig, apiKey: string): Directory {
  const key = `${config.domain}|${config.namespace}|${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
  let directory = directories.get(key);
  if (!directory) {
    directory = {
      handles: new Map(),
      locks: new Map(),
      renewedAt: new Map(),
      rekeyedAt: new Map(),
      warnedLifecycle: false,
    };
    directories.set(key, directory);
  }
  return directory;
}

export const e2bEndpoints = (config: Pick<E2bConfig, 'domain'>) => [
  `https://api.${config.domain}`,
  `https://*.${config.domain}`,
];

export type TemplateState = { state: 'ready'; buildId: string } | { state: 'building' | 'failed' | 'missing' };

/** Whether the template exists at the provider with a finished build: proves the key on the way. */
export async function templateState(api: E2bApi, template: string): Promise<TemplateState> {
  const found = findTemplate(await api.templates(), template);
  if (!found) return { state: 'missing' };
  if (found.buildID) return { state: 'ready', buildId: found.buildID };
  return { state: found.buildStatus === 'building' || found.buildStatus === 'waiting' ? 'building' : 'failed' };
}

/** templateState for the build script and the live test, through a fetch pinned like the API's. */
export function e2bTemplateState(
  fetchImpl: typeof fetch,
  config: Pick<E2bConfig, 'domain' | 'template'>,
  apiKey: string,
): Promise<TemplateState> {
  return templateState(createE2bApi(config.domain, apiKey, fetchImpl), config.template);
}

export interface E2bDeps {
  /** Pinned to the instance's endpoints (the API gives every client one). */
  fetch: typeof fetch;
  /** Opens the bridges' WebSockets; tests point it at a local bridge. */
  connect?: Connector;
  now?: () => number;
}

/** What `test` needs from a client the providers service made. */
const checks = new WeakMap<SandboxClient, () => Promise<void>>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The oldest of several sandboxes with one name: the one every API process agrees on. */
function canonical(found: SandboxInfo[]): SandboxInfo | null {
  const created = (info: SandboxInfo) => info.metadata?.gh_created ?? '\uffff';
  return (
    [...found].sort((a, b) => created(a).localeCompare(created(b)) || a.sandboxID.localeCompare(b.sandboxID))[0] ?? null
  );
}

/** Labels as metadata keys a provider accepts. */
function labelsOf(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [
      key.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64),
      value.slice(0, 200),
    ]),
  );
}

export function createE2bSandbox(config: E2bConfig, apiKey: string, deps: E2bDeps): SandboxClient {
  if (!apiKey) throw new ProviderRequestError('The E2B sandbox needs an API key.');
  const api = createE2bApi(config.domain, apiKey, deps.fetch);
  const connect = deps.connect ?? connectWebSocket;
  const now = deps.now ?? Date.now;
  const endpoints = e2bEndpoints(config);
  const dir = directoryOf(config, apiKey);
  const timeoutSeconds = config.timeoutMinutes * 60;

  const checkName = (name: string) => {
    if (!NAME.test(name)) throw new ProviderRequestError(`Invalid computer name "${name.slice(0, 80)}".`);
    return name;
  };
  const metadataOf = (name: string) => ({ gh_ns: config.namespace, gh_name: name });
  const ours = (info: SandboxInfo, name: string) =>
    info.metadata?.gh_ns === config.namespace && info.metadata?.gh_name === name;
  const notRunning = (message: string) => new ProviderRequestError(message, 409);

  async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const run = (dir.locks.get(name) ?? Promise.resolve()).then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    dir.locks.set(name, tail);
    try {
      return await run;
    } finally {
      if (dir.locks.get(name) === tail) dir.locks.delete(name);
    }
  }

  /** The computer's sandbox, running or paused; null when there is none. */
  async function locate(name: string): Promise<SandboxInfo | null> {
    const cached = dir.handles.get(name);
    if (cached) {
      const info = await api.info(cached.id);
      if (info && ours(info, name)) return info;
      dir.handles.delete(name);
    }
    return canonical((await api.list(metadataOf(name))).filter((info) => ours(info, name)));
  }

  function handleOf(connected: Connected): Handle {
    // Without the token every port would be open to anyone who knows the sandbox's address.
    if (!connected.trafficAccessToken) {
      throw new ProviderRequestError(
        `${config.domain} did not keep the computer's ports private (it gave no traffic access token), so the computer is not used.`,
      );
    }
    const domain = (connected.domain || config.domain).toLowerCase();
    return {
      id: connected.sandboxID,
      domain,
      ...(connected.envdAccessToken ? { envdToken: connected.envdAccessToken } : {}),
      trafficToken: connected.trafficAccessToken,
    };
  }

  /** Connects to a sandbox, resuming it when paused; remembers how to reach it. */
  async function attach(name: string, id: string): Promise<Handle> {
    const connected = await api.connect(id, timeoutSeconds);
    if (!connected) throw notRunning('The computer is gone.');
    const handle = handleOf({ ...connected, sandboxID: connected.sandboxID || id });
    dir.handles.set(name, handle);
    dir.renewedAt.set(handle.id, now());
    return handle;
  }

  function renew(id: string) {
    if (now() - (dir.renewedAt.get(id) ?? 0) < RENEW_EVERY_MS) return;
    // Stamped first: a failing renewal is tried again on the same schedule, not on every call.
    dir.renewedAt.set(id, now());
    api
      .setTimeout(id, timeoutSeconds)
      .catch((error: unknown) =>
        logger.warn('[sandbox:e2b] could not renew a computer', { sandbox: id, error: toErrorMessage(error) }),
      );
  }

  /** A running computer for a command or a stream; never resumes one (that is ensure's work). */
  async function running(name: string): Promise<Handle> {
    const cached = dir.handles.get(name);
    if (cached) {
      renew(cached.id);
      return cached;
    }
    const found = await locate(name);
    if (!found) throw notRunning('The computer does not exist.');
    if (found.state !== 'running') throw notRunning('The computer is not running.');
    return attach(name, found.sandboxID);
  }

  function bridgeTarget(handle: Handle, account: Account): BridgeTarget {
    const url = `wss://${BRIDGE_PORTS[account]}-${handle.id}.${handle.domain}`;
    assertPinned(endpoints, url.replace(/^wss:/, 'https:'));
    return {
      url,
      headers: {
        'e2b-traffic-access-token': handle.trafficToken,
        'x-gh-bridge-secret': bridgeSecret(apiKey, handle.id, account),
      },
    };
  }

  const envdTarget = (handle: Handle): EnvdTarget => ({
    origin: `https://${ENVD_PORT}-${handle.id}.${handle.domain}`,
    sandboxId: handle.id,
    ...(handle.envdToken ? { accessToken: handle.envdToken } : {}),
  });

  const secretEnv = (handle: Handle) => ({
    GH_BRIDGE_SECRET_BROWSER: bridgeSecret(apiKey, handle.id, 'browser'),
    GH_BRIDGE_SECRET_AGENT: bridgeSecret(apiKey, handle.id, 'agent'),
  });

  /** A root script through envd, with its deadline inside the computer. */
  function root(handle: Handle, script: string, envs: Record<string, string> = {}): Promise<ExecResult> {
    return envdRun(
      deps.fetch,
      envdTarget(handle),
      {
        argv: withDeadline(['/bin/bash', '-c', script], ROOT_TIMEOUT_MS, '/usr/bin/timeout'),
        user: 'root',
        cwd: '/',
        envs: { PATH, ...envs },
        timeoutMs: ROOT_TIMEOUT_MS + EXEC_GRACE_MS,
        maxOutputBytes: 64 * 1024,
      },
      [apiKey, handle.trafficToken],
    );
  }

  const failed = (step: string, result: ExecResult) =>
    new ProviderRequestError(
      `${step} failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}): ${result.stderr.trim().slice(-300) || 'no output'}`,
    );

  async function applyEgress(handle: Handle) {
    const result = await root(handle, EGRESS_APPLY_SCRIPT, egressApplyEnv());
    if (result.exitCode !== 0) throw failed("Applying the computer's network rules", result);
  }

  /** gh-e2b-boot: the bridge secrets, the settings, the bridges and, first or after a reset, the desktop. */
  async function boot(handle: Handle, mode: 'first' | 'resume', settings: string): Promise<'ok' | 'stale'> {
    const result = await root(handle, `/usr/local/sbin/gh-e2b-boot${mode === 'resume' ? ' --resume' : ''}`, {
      ...secretEnv(handle),
      GH_COMPUTER_ENV_B64: Buffer.from(settings).toString('base64'),
    });
    // 3: started with other settings; 4: its desktop is down. Either way it starts over in place.
    if (mode === 'resume' && (result.exitCode === 3 || result.exitCode === 4)) return 'stale';
    if (result.exitCode !== 0) throw failed('Starting the computer', result);
    return 'ok';
  }

  async function reset(handle: Handle, settings: string | null) {
    const result = await root(handle, RESET_SCRIPT, {
      ...secretEnv(handle),
      ...(settings ? { GH_COMPUTER_ENV_B64: Buffer.from(settings).toString('base64') } : {}),
    });
    if (result.exitCode !== 0) throw failed('Restarting the computer', result);
  }

  /** A command through one account's bridge to its end, the deadline enforced inside the computer. */
  async function bridged(
    handle: Handle,
    account: Account,
    argv: string[],
    options: { cwd?: string; timeoutMs: number; maxOutputBytes: number },
  ): Promise<ExecResult> {
    const mode: BridgeMode = {
      kind: 'exec',
      argv: withDeadline(argv, options.timeoutMs),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    };
    const stream = new BridgeStream(Promise.resolve(bridgeTarget(handle, account)), mode, connect);
    const result = await bridgeRun(stream, {
      deadlineMs: options.timeoutMs + EXEC_GRACE_MS,
      maxOutputBytes: options.maxOutputBytes,
    });
    // 124: `timeout` ended it; 137: it had to kill it. Only past the deadline is it the deadline's doing.
    const deadline = (result.exitCode === 124 || result.exitCode === 137) && result.elapsedMs >= options.timeoutMs;
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut || deadline,
    };
  }

  async function waitForBridges(handle: Handle) {
    for (const account of ['agent', 'browser'] as const) {
      const deadline = Date.now() + BRIDGE_WAIT_MS;
      for (;;) {
        let last: string;
        try {
          const result = await bridged(handle, account, ['true'], { timeoutMs: 10_000, maxOutputBytes: 1024 });
          if (result.exitCode === 0) break;
          last = `exit ${result.exitCode}`;
        } catch (error) {
          last = toErrorMessage(error);
        }
        if (Date.now() >= deadline) {
          throw new ProviderRequestError(`The computer's ${account} bridge did not answer (${last}).`);
        }
        await sleep(500);
      }
    }
  }

  /** Every blocked target must be refused from both member accounts before the computer is used. */
  async function probeEgress(handle: Handle) {
    for (const account of ['agent', 'browser'] as const) {
      const result = await bridged(handle, account, EGRESS_PROBE_ARGV, {
        cwd: '/',
        timeoutMs: 60_000,
        maxOutputBytes: 64 * 1024,
      });
      if (result.exitCode !== 0) {
        throw failed(`Checking the computer's network rules as ${account}`, result);
      }
      const leaks = egressLeaks(result.stdout);
      if (leaks.length) {
        throw new ProviderRequestError(
          `The computer's network rules are not in force (the ${account} account reached ${leaks.join(', ')}), so it is not used.`,
        );
      }
    }
  }

  async function assertPausesOnTimeout(id: string) {
    const onTimeout = (await api.info(id))?.lifecycle?.onTimeout;
    if (onTimeout === 'pause') return;
    if (onTimeout === undefined) {
      if (!dir.warnedLifecycle) {
        dir.warnedLifecycle = true;
        logger.warn('[sandbox:e2b] the provider does not say what it does on timeout; assuming it pauses', {
          domain: config.domain,
        });
      }
      return;
    }
    throw new ProviderRequestError(
      `${config.domain} would ${onTimeout} a computer on timeout instead of pausing it; computers stay off so no home is lost.`,
    );
  }

  /** A new sandbox; when another API process made one for this name at the same moment, theirs stays. */
  async function create(name: string, spec: SandboxSpec): Promise<Handle> {
    const connected = await api.create({
      templateID: config.template,
      timeout: timeoutSeconds,
      autoPause: true,
      autoResume: { enabled: false },
      metadata: {
        ...labelsOf(spec.labels),
        gh_ns: config.namespace,
        gh_name: name,
        gh_created: new Date(now()).toISOString(),
      },
      network: { allowPublicTraffic: false, denyOut: PROVIDER_DENY_OUT },
    });
    let handle: Handle;
    try {
      handle = handleOf(connected);
      const first = canonical((await api.list(metadataOf(name))).filter((info) => ours(info, name)));
      if (first && first.sandboxID !== handle.id) {
        throw notRunning('The computer is being started elsewhere. Try again in a moment.');
      }
    } catch (error) {
      await api.kill(connected.sandboxID).catch(() => undefined);
      throw error;
    }
    dir.handles.set(name, handle);
    dir.renewedAt.set(handle.id, now());
    return handle;
  }

  /**
   * Opens a stream through a bridge. While it is open the computer is renewed; a connection the
   * bridge refused rewrites the secrets for the next one, any other failure forgets the handle.
   */
  function open(name: string, account: Account, mode: BridgeMode): SandboxStream {
    const handle = Promise.resolve().then(() => running(checkName(name)));
    const stream = new BridgeStream(
      handle.then((resolved) => bridgeTarget(resolved, account)),
      mode,
      connect,
    );
    handle.catch(() => undefined);
    const keepAlive = setInterval(() => {
      const current = dir.handles.get(name);
      if (current) renew(current.id);
    }, RENEW_EVERY_MS);
    keepAlive.unref();
    void stream.exited.then(async () => {
      clearInterval(keepAlive);
      const failure = stream.failure;
      if (!failure) return;
      const resolved = await handle.catch(() => null);
      if (!resolved) return;
      if (failure.status === 403) void rekey(name, resolved);
      else if (dir.handles.get(name) === resolved) dir.handles.delete(name);
    });
    return stream;
  }

  /** A refused bridge connection on a running computer: the API key changed, so the secrets did. */
  async function rekey(name: string, stale: Handle): Promise<boolean> {
    if (now() - (dir.rekeyedAt.get(stale.id) ?? 0) < REKEY_EVERY_MS) return false;
    dir.rekeyedAt.set(stale.id, now());
    if (dir.handles.get(name) === stale) dir.handles.delete(name);
    try {
      const handle = await running(name);
      const result = await root(handle, '/usr/local/sbin/gh-e2b-boot --secrets-only', secretEnv(handle));
      if (result.exitCode !== 0) throw failed('Rewriting the bridge secrets', result);
      logger.info('[sandbox:e2b] rewrote the bridge secrets of a computer that refused them', { sandbox: handle.id });
      return true;
    } catch (error) {
      logger.warn('[sandbox:e2b] could not rewrite the bridge secrets', {
        sandbox: stale.id,
        error: toErrorMessage(error),
      });
      return false;
    }
  }

  /** Why a bridge connection failed, in the words the caller needs: gone, asleep, or the failure itself. */
  async function explain(name: string, error: BridgeError): Promise<Error> {
    dir.handles.delete(name);
    const found = await locate(name).catch(() => undefined);
    if (found === null) return notRunning('The computer does not exist.');
    if (found && found.state !== 'running') return notRunning('The computer is not running.');
    return new ProviderRequestError(error.message, error.status ?? undefined);
  }

  const client: SandboxClient = {
    backgroundNetwork: 'domains',
    async setEgress(name, domains) {
      const handle = await running(checkName(name));
      await api.network(
        handle.id,
        domains === null ? { denyOut: PROVIDER_DENY_OUT } : { allowOut: [...domains], denyOut: ['0.0.0.0/0'] },
      );
    },
    async ensure(spec) {
      const name = checkName(spec.name);
      const settings = settingsOf(spec);
      await withLock(name, async () => {
        const found = await locate(name);
        const wasRunning = found?.state === 'running';
        let created: Handle | null = null;
        try {
          const handle = found ? await attach(name, found.sandboxID) : (created = await create(name, spec));
          await assertPausesOnTimeout(handle.id);
          await applyEgress(handle);
          if ((await boot(handle, found ? 'resume' : 'first', settings)) === 'stale') {
            logger.info('[sandbox:e2b] a woken computer could not carry on as it was; restarting it', {
              sandbox: handle.id,
            });
            await reset(handle, settings);
          }
          await waitForBridges(handle);
          await probeEgress(handle);
        } catch (error) {
          dir.handles.delete(name);
          // A new one that never worked goes; one that was asleep goes back to sleep.
          if (created) await api.kill(created.id).catch(() => undefined);
          else if (found && !wasRunning) await api.pause(found.sandboxID).catch(() => undefined);
          throw error;
        }
      });
    },

    async status(name) {
      const found = await locate(checkName(name));
      if (found?.state === 'running') {
        renew(found.sandboxID);
        return 'running';
      }
      dir.handles.delete(name);
      return found ? 'stopped' : 'missing';
    },

    async exec(name, input) {
      checkName(name);
      const timeoutMs = Math.max(input.timeoutMs, 1000);
      const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_OUTPUT_CAP;
      const handle = await running(name);
      if (input.user === 'root') {
        const started = now();
        try {
          const result = await envdRun(
            deps.fetch,
            envdTarget(handle),
            {
              argv: withDeadline(input.argv, timeoutMs, '/usr/bin/timeout'),
              user: 'root',
              cwd: input.cwd ?? '/',
              envs: { PATH },
              timeoutMs: timeoutMs + EXEC_GRACE_MS,
              maxOutputBytes,
            },
            [apiKey, handle.trafficToken],
          );
          const deadline = (result.exitCode === 124 || result.exitCode === 137) && now() - started >= timeoutMs;
          return { ...result, timedOut: result.timedOut || deadline };
        } catch (error) {
          if (dir.handles.get(name) === handle) dir.handles.delete(name);
          throw error;
        }
      }
      const options = { cwd: input.cwd ?? AGENT_HOME, timeoutMs, maxOutputBytes };
      try {
        return await bridged(handle, 'agent', input.argv, options);
      } catch (error) {
        if (!(error instanceof BridgeError)) throw error;
        // Refused at the door of a running computer: the secrets went stale. Once, then again.
        if (error.status === 403 && (await rekey(name, handle))) {
          try {
            return await bridged(await running(name), 'agent', input.argv, options);
          } catch (retried) {
            if (!(retried instanceof BridgeError)) throw retried;
            throw await explain(name, retried);
          }
        }
        throw await explain(name, error);
      }
    },

    homeExists: async (name) => (await client.status(name)) !== 'missing',

    stream: (name, input) =>
      open(name, input.user, { kind: 'exec', argv: input.argv, cwd: input.cwd ?? `/home/${input.user}` }),

    screen: (name) => open(name, 'browser', { kind: 'tunnel', path: '/vnc' }),

    devtools: (name) => open(name, 'browser', { kind: 'tunnel', path: '/cdp' }),

    async stop(name) {
      checkName(name);
      await withLock(name, async () => {
        const found = await locate(name);
        dir.handles.delete(name);
        if (found?.state === 'running') await api.pause(found.sandboxID);
      });
    },

    async restart(name) {
      checkName(name);
      await withLock(name, async () => {
        const handle = await running(name);
        try {
          await applyEgress(handle);
          await reset(handle, null);
          await waitForBridges(handle);
          await probeEgress(handle);
        } catch (error) {
          dir.handles.delete(name);
          throw error;
        }
      });
    },

    async remove(name, options) {
      checkName(name);
      await withLock(name, async () => {
        dir.handles.delete(name);
        const all = (await api.list(metadataOf(name))).filter((info) => ours(info, name));
        for (const info of all) {
          // The paused sandbox is the home: keeping the home keeps it, paused.
          if (!options.keepHome) await api.kill(info.sandboxID);
          else if (info.state === 'running') await api.pause(info.sandboxID);
        }
      });
    },
  };

  checks.set(client, async () => {
    const found = await templateState(api, config.template);
    if (found.state === 'ready') return;
    throw new ProviderRequestError(
      found.state === 'missing'
        ? `There is no template "${config.template}" at ${config.domain}. Build it with scripts/e2b-template.mts.`
        : `The template "${config.template}" has no finished build yet (${found.state}).`,
    );
  });
  return client;
}

export const e2bAdapter: ProviderAdapter<'sandbox', E2bConfig> = {
  capability: 'sandbox',
  kind: 'e2b',
  label: 'E2B',
  configSchema: e2bConfigSchema as z.ZodType<E2bConfig>,
  secretKeys: ['apiKey'],
  requiredSecrets: ['apiKey'],
  presets: E2B_PRESETS,
  // The API, and each computer's own name under the same domain (envd and the two bridges).
  endpoints: e2bEndpoints,
  create: ({ config, secrets, fetch }) => createE2bSandbox(config, secrets.apiKey ?? '', { fetch }),
  async test(client) {
    // The key and the template, without starting a computer.
    const check = checks.get(client);
    if (!check) throw new Error('This client was not made by the E2B adapter.');
    await check();
  },
};
