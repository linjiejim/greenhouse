/**
 * The E2B driver of a member's cloud computer: one sandbox from the configured
 * template (E2B's stock `base` unless set), created on first use and killed
 * when it stops. Ported from the v2 line's adapter
 * (packages/providers/src/sandbox/e2b/adapter.ts) with everything a plain
 * shell computer does not need left behind: no desktop, browser, VNC or
 * DevTools bridges, no pause / resume, no backups, no per-agent computers, no
 * custom template.
 *
 * Kept from v2: the control plane over plain HTTP (api.ts), commands through
 * envd's process API with the deadline enforced inside the computer as well
 * (`timeout -k`), the provider's timeout as a dead-man switch (a computer
 * nobody renews is killed by E2B on its own), public traffic off and the
 * private address ranges denied at the provider's edge.
 *
 * How to reach a sandbox (its envd token) is kept in memory per process; a
 * process that did not create it asks the provider (`connect`) once.
 */

import { createHash } from 'node:crypto';
import type { ComputerDriver } from '../driver.js';
import { COMPUTER_HOME, COMPUTER_USER, type E2bConfig } from '../config.js';
import { createE2bApi, type Connected } from './api.js';
import { ProviderRequestError } from './http.js';
import { ENVD_PORT, envdReadFile, envdRun, envdWriteFile, type EnvdTarget } from './envd.js';

/** Private ranges no computer may reach, filtered by the provider outside the VM. */
export const PROVIDER_DENY_OUT = ['10.0.0.0/8', '100.64.0.0/10', '172.16.0.0/12', '192.168.0.0/16'];
/** `timeout -k`: a command that ignores the deadline's TERM is killed this much later. */
const KILL_AFTER_S = 5;
/** After the deadline inside the computer, how long the API waits before it gives up on the answer. */
const EXEC_GRACE_MS = 15_000;
/** When the API reaches a sandbox it did not create, it renews it for this long. */
const CONNECT_TIMEOUT_SECONDS = 15 * 60;
const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** argv with its deadline enforced inside the computer: TERM at the deadline, KILL a little later. */
export function withDeadline(argv: string[], timeoutMs: number, timeoutBin = '/usr/bin/timeout'): string[] {
  return [timeoutBin, '-k', String(KILL_AFTER_S), (Math.max(timeoutMs, 1000) / 1000).toFixed(3), ...argv];
}

interface Handle {
  domain: string;
  envdToken?: string;
}

/** Sandboxes this process knows how to reach, per provider account. */
const handlesByAccount = new Map<string, Map<string, Handle>>();

function handlesOf(config: E2bConfig): Map<string, Handle> {
  const key = `${config.domain}|${createHash('sha256').update(config.apiKey).digest('hex').slice(0, 16)}`;
  let handles = handlesByAccount.get(key);
  if (!handles) {
    handles = new Map();
    handlesByAccount.set(key, handles);
  }
  return handles;
}

export function createE2bDriver(config: E2bConfig, fetchImpl: typeof fetch = fetch): ComputerDriver {
  if (!config.apiKey) throw new ProviderRequestError('The cloud computer needs an E2B API key.');
  const api = createE2bApi(config.domain, config.apiKey, fetchImpl);
  const handles = handlesOf(config);
  const secrets = [config.apiKey];

  const remember = (id: string, connected: Connected): Handle => {
    const handle: Handle = {
      domain: (connected.domain || config.domain).toLowerCase(),
      ...(connected.envdAccessToken ? { envdToken: connected.envdAccessToken } : {}),
    };
    handles.set(id, handle);
    return handle;
  };

  async function target(id: string): Promise<EnvdTarget> {
    let handle = handles.get(id);
    if (!handle) {
      const connected = await api.connect(id, CONNECT_TIMEOUT_SECONDS);
      if (!connected) throw new ProviderRequestError('The cloud computer is gone.', 404);
      handle = remember(id, connected);
    }
    return {
      origin: `https://${ENVD_PORT}-${id}.${handle.domain}`,
      sandboxId: id,
      ...(handle.envdToken ? { accessToken: handle.envdToken } : {}),
    };
  }

  return {
    async create({ computerId, userId, timeoutSeconds }) {
      const connected = await api.create({
        templateID: config.template,
        timeout: timeoutSeconds,
        autoPause: false,
        metadata: { gh_computer: computerId, gh_member: userId },
        network: { allowPublicTraffic: false, denyOut: PROVIDER_DENY_OUT },
      });
      if (!connected.sandboxID) throw new ProviderRequestError('The provider created no sandbox id.');
      remember(connected.sandboxID, connected);
      return { sandboxId: connected.sandboxID };
    },

    async exec(id, input) {
      const timeoutMs = Math.max(input.timeoutMs, 1000);
      const started = Date.now();
      const result = await envdRun(
        fetchImpl,
        await target(id),
        {
          argv: withDeadline(['/bin/bash', '-lc', input.command], timeoutMs),
          user: COMPUTER_USER,
          cwd: input.cwd ?? COMPUTER_HOME,
          envs: { PATH, HOME: COMPUTER_HOME },
          timeoutMs: timeoutMs + EXEC_GRACE_MS,
          maxOutputBytes: input.maxOutputBytes,
        },
        secrets,
      );
      // 124: `timeout` ended it; 137: it had to kill it. Only past the deadline is it the deadline's doing.
      const deadline = (result.exitCode === 124 || result.exitCode === 137) && Date.now() - started >= timeoutMs;
      return { ...result, timedOut: result.timedOut || deadline };
    },

    async readFile(id, input) {
      return envdReadFile(fetchImpl, await target(id), { ...input, user: COMPUTER_USER }, secrets);
    },

    async writeFile(id, input) {
      await envdWriteFile(fetchImpl, await target(id), { ...input, user: COMPUTER_USER }, secrets);
    },

    async renew(id, timeoutSeconds) {
      const alive = await api.setTimeout(id, timeoutSeconds);
      if (!alive) handles.delete(id);
      return alive;
    },

    async kill(id) {
      await api.kill(id);
      handles.delete(id);
    },
  };
}
