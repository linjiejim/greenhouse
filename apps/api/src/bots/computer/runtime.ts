/**
 * Computer runtime — is this host able to run members' computers right now,
 * and the loops that keep them tidy. Public functions are re-exported by
 * ./index.ts (keep the names and signatures).
 *
 * Two drivers (BOTS_COMPUTER_DRIVER, host.ts): docker — the prechecks below,
 * the egress rules and the Docker disk guard — or e2b, a hosted sandbox
 * provider: its prechecks reach the provider with the key and make sure the
 * current template exists, building it there when it does not (a few
 * minutes; the runtime is `unavailable` / `template_building` meanwhile and
 * turns ready as soon as the build is done). Orphan sandboxes are reconciled
 * hourly as well as at boot.
 *
 * States: `disabled` (BOTS_COMPUTER_ENABLED off) → `checking` → `ready`, or
 * `unavailable{reason}` when a precheck fails (docker_cli_missing,
 * docker_unreachable, runtime_missing, image_missing, image_outdated,
 * network_invalid, or a BOTS_COMPUTER_* config error). Unavailable re-checks
 * every 60 s and heals without a restart; a host failure seen later (a loop or
 * a start hitting a dead daemon) flips back to unavailable the same way. One
 * member's broken container never does (controller.ts). Every time the host
 * becomes ready (boot included) the controller reconciles first, so orphans a
 * Docker outage left behind (a deleted member's container and volume, a
 * suspended member's computer) are cleared before anyone uses a computer.
 *
 * Hardened hosts also need the computers' egress rules
 * (`scripts/cloud-agent-net.sh --profile bots`: no private networks, no host,
 * no cloud metadata, zero allow rows). The precheck verifies them the way
 * Mission does, every 10 minutes after that, and each new computer proves
 * them from inside before it is used (controller.ts). Development
 * (unhardened) mode only reports that egress is not enforced — there are no
 * iptables on macOS/OrbStack.
 *
 * The Docker disk's free space is measured from inside running computers
 * (controller.ts); the latest reading lives here, refuses new starts below
 * 10 % and is the admin page's `host_disk` check.
 *
 * Shutting the API down never stops computers — they belong to the DB-backed
 * lifecycle and the other blue/green slot — it only closes this process's
 * tunnels.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDb, type BotComputerRow, type BotRequestRow } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type {
  BotRequestDecision,
  ComputerAdminRow,
  ComputerRuntimeView,
  ComputerStatusView,
} from '@greenhouse/types/bots';

import { userHasFeature } from '../../auth/features.js';
import { connectionManager } from '../../ws/connection-manager.js';
import {
  clampMaxRunning,
  ComputerConfigError,
  computerLang,
  greenhouseUrlBlocklist,
  isBotsComputerEnabled,
  loadBotsComputerConfig,
  resolveComputerKnobs,
  type BotsComputerConfig,
} from './config.js';
import {
  createComputerController,
  HOST_DISK_MIN_FREE_RATIO,
  type ComputerController,
  type ControllerEnvironment,
  type HostDiskReading,
} from './controller.js';
import { createDockerHost } from './docker-host.js';
import { ComputerRuntimeError, createDockerClient, type DockerClient, type ImageInfo } from './docker.js';
import { createE2bApi, createE2bHost, providerError } from './e2b-host.js';
import {
  buildComputerTemplate,
  computerTemplateName,
  templateStatus,
  type ComputerTemplateOptions,
  type TemplateStatus,
} from './e2b-template.js';
import { ComputerUnavailableError } from './errors.js';
import type { ComputerHost } from './host.js';
import {
  LABEL_COMPUTER,
  LABEL_IMAGE_CHROMIUM,
  LABEL_IMAGE_CONTRACT,
  LABEL_IMAGE_EXTRA_PACKAGES,
  LABEL_NAMESPACE,
} from './namespace.js';
import { onWorkspaceConfigRefreshed } from '../../settings/workspace-config.js';
import { checkProcessWatches, WATCH_CHECK_MS } from './process-watches.js';
import { computerLifecycleHooks } from './hooks.js';
import { HUMAN_WAIT_HOLD_MS } from './limits.js';

/**
 * The image contract this API speaks (apps/bot-computer/Dockerfile LABEL).
 * 2 = the desktop panel and window helper (gh-window), the terminal bridge
 * (gh-term), background jobs (gh-jobs) and the take-over kill that spares
 * them (gh-agent-kill), user-level pip/npm installs, per-member GH_COMPUTER_LANG.
 */
export const IMAGE_CONTRACT = '2';
/** Images older than this get a freshness warning (Chromium runs with --no-sandbox, spec D15). */
const IMAGE_STALE_MS = 30 * 24 * 60 * 60_000;

const RECHECK_MS = 60_000;
const IDLE_TICK_MS = 60_000;
const HEALTH_TICK_MS = 30_000;
const LEASE_TICK_MS = 30_000;
const DISK_TICK_MS = 60 * 60_000;
const FIRST_DISK_TICK_MS = 2 * 60_000;
const EGRESS_TICK_MS = 10 * 60_000;
/** Hosted computers: orphans (a dead start's sandbox, a replaced one past its keep) are cleared hourly. */
const RECONCILE_TICK_MS = 60 * 60_000;
/** A failed template build is retried after this long (or at the next restart). */
const TEMPLATE_RETRY_MS = 30 * 60_000;

export interface RuntimeCheck {
  id:
    | 'config'
    | 'docker'
    | 'runtime'
    | 'image'
    | 'image_fresh'
    | 'network'
    | 'egress'
    | 'capacity'
    | 'host_disk'
    | 'provider'
    | 'template';
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface PrecheckResult {
  ok: boolean;
  reason: string | null;
  checks: RuntimeCheck[];
  memTotal: number | null;
  image: ImageInfo | null;
  gateways: string[];
  /** e2b: the template new computers start from (null for docker). */
  template?: string | null;
}

interface RuntimeState {
  view: ComputerRuntimeView;
  config: BotsComputerConfig | null;
  checks: RuntimeCheck[];
  memTotal: number | null;
  image: ImageInfo | null;
  gateways: string[];
  /** Cached for the synchronous /health view (refreshed by the health loop). */
  running: number;
  maxRunning: number | null;
  /** The latest free-space reading of the Docker disk (null = not measured since boot). */
  hostDisk: HostDiskReading | null;
  /** e2b: the ready template new computers start from. */
  template: string | null;
}

const initialState = (): RuntimeState => ({
  view: { state: 'disabled', reason: null, hardened: false },
  config: null,
  checks: [],
  memTotal: null,
  image: null,
  gateways: [],
  running: 0,
  maxRunning: null,
  hostDisk: null,
  template: null,
});

let state: RuntimeState = initialState();
let docker: DockerClient = createDockerClient();
let host: ComputerHost = createDockerHost(docker);
let egressCheck: EgressCheck = checkComputerEgress;
let hostedDeps: HostedPrecheckDeps | null = null;
let controller: ComputerController | null = null;
let recheckTimer: NodeJS.Timeout | null = null;
const loopTimers: NodeJS.Timeout[] = [];
let checking: Promise<void> | null = null;

// ─── Egress rules (hardened hosts) ────────────────────────

export interface EgressCheckResult {
  ok: boolean;
  detail: string;
}

/** Verifies the computers' egress rules for a configuration (injectable for tests). */
export type EgressCheck = (config: BotsComputerConfig) => Promise<EgressCheckResult>;

const EGRESS_SCRIPT = fileURLToPath(new URL('../../../../../scripts/cloud-agent-net.sh', import.meta.url));

function lastLine(text: string): string {
  return text.trim().split('\n').pop()?.trim() ?? '';
}

/**
 * `scripts/cloud-agent-net.sh --profile bots --check` — the same anchored
 * DOCKER-USER + INPUT verification Mission runs (cloud-agent/docker.ts), with
 * the computers' own chains and zero allow rows. Needs the same privileges as
 * Mission's check on the API host.
 */
export function checkComputerEgress(config: BotsComputerConfig): Promise<EgressCheckResult> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [EGRESS_SCRIPT, '--profile', 'bots', '--check'],
      {
        env: { ...process.env, BOTS_COMPUTER_NETWORK: config.network, BOTS_COMPUTER_PROXY: config.proxy ?? '' },
        timeout: 30_000,
        maxBuffer: 256 * 1024,
      },
      (err, stdout, stderr) => {
        if (!err) resolve({ ok: true, detail: lastLine(stdout) });
        else resolve({ ok: false, detail: lastLine(stderr) || toErrorMessage(err) });
      },
    );
  });
}

/** The command an admin runs to apply the rules (and how to keep them across reboots). */
function egressFix(config: BotsComputerConfig): string {
  const proxy = config.proxy ? ` BOTS_COMPUTER_PROXY=${config.proxy}` : '';
  return [
    `sudo BOTS_COMPUTER_NETWORK=${config.network}${proxy} bash scripts/cloud-agent-net.sh --profile bots`,
    '# iptables rules do not survive a reboot: run the same command from a systemd oneshot after docker (like cloud-agent-net.service)',
  ].join('\n');
}

// ─── Prechecks (pure over a DockerClient; unit-tested) ────

function networkFix(config: BotsComputerConfig): string {
  return config.hardened
    ? [
        `docker network create --driver bridge --ipv6=false --opt com.docker.network.bridge.enable_icc=false ${config.network}`,
        egressFix(config),
      ].join('\n')
    : `docker network rm ${config.network}  # the API recreates it with inter-container traffic off`;
}

/** Everything a host needs before the first `docker run`, as admin-page checks. */
export async function runComputerPrechecks(
  client: DockerClient,
  config: BotsComputerConfig,
  opts: { egressCheck?: EgressCheck } = {},
): Promise<PrecheckResult> {
  const checks: RuntimeCheck[] = [];
  const fail = (reason: string, check: RuntimeCheck): PrecheckResult => {
    checks.push(check);
    return { ok: false, reason, checks, memTotal: null, image: null, gateways: [] };
  };

  let version: string;
  try {
    version = await client.version();
  } catch (err) {
    const reason = err instanceof ComputerRuntimeError ? err.reason : 'docker_unreachable';
    return fail(reason, {
      id: 'docker',
      ok: false,
      detail: toErrorMessage(err),
      fix:
        reason === 'docker_cli_missing'
          ? 'Install the Docker CLI on the API host (computers need the API and Docker on the same machine).'
          : 'Start Docker and make sure the API user can run `docker ps` (add it to the docker group).',
    });
  }
  checks.push({ id: 'docker', ok: true, detail: `Docker ${version}` });

  let memTotal: number | null;
  try {
    const info = await client.info();
    memTotal = info.memTotal;
    if (!info.runtimes.includes(config.runtime)) {
      return fail('runtime_missing', {
        id: 'runtime',
        ok: false,
        detail: `Docker has no "${config.runtime}" runtime (has: ${info.runtimes.join(', ') || 'none'})`,
        fix:
          config.runtime === 'runsc'
            ? 'Install gVisor (https://gvisor.dev/docs/user_guide/install/), then `sudo runsc install && sudo systemctl restart docker`.'
            : `Register the ${config.runtime} runtime with Docker or unset BOTS_COMPUTER_RUNTIME.`,
      });
    }
    checks.push({
      id: 'runtime',
      ok: true,
      detail: config.hardened ? `${config.runtime} (gVisor)` : `${config.runtime} (development, unhardened)`,
    });
  } catch (err) {
    const reason = err instanceof ComputerRuntimeError ? err.reason : 'docker_unreachable';
    return fail(reason, { id: 'runtime', ok: false, detail: toErrorMessage(err) });
  }

  const image = await client.imageInspect(config.image).catch(() => null);
  if (!image) {
    return fail('image_missing', {
      id: 'image',
      ok: false,
      detail: `Image ${config.image} is not on this host`,
      fix: 'bash scripts/build-bot-computer.sh',
    });
  }
  const contract = image.labels[LABEL_IMAGE_CONTRACT];
  if (contract !== IMAGE_CONTRACT) {
    return fail('image_outdated', {
      id: 'image',
      ok: false,
      detail: `Image ${config.image} speaks contract ${contract ?? 'none'}; this API needs ${IMAGE_CONTRACT}`,
      fix: 'bash scripts/build-bot-computer.sh',
    });
  }
  const chromium = image.labels[LABEL_IMAGE_CHROMIUM];
  // What an operator baked in (BOTS_COMPUTER_EXTRA_PACKAGES) — the admin page's only record of it.
  const extraPackages = image.labels[LABEL_IMAGE_EXTRA_PACKAGES]?.trim().replace(/\s+/g, ' ');
  checks.push({
    id: 'image',
    ok: true,
    detail: `${config.image} · ${image.id.slice(7, 19)}${chromium ? ` · Chromium ${chromium}` : ''}${
      extraPackages ? ` · extra packages: ${extraPackages}` : ''
    }`,
  });
  const builtAt = Date.parse(image.created);
  const stale = Number.isFinite(builtAt) && Date.now() - builtAt > IMAGE_STALE_MS;
  checks.push({
    id: 'image_fresh',
    ok: !stale,
    detail: Number.isFinite(builtAt)
      ? `Built ${new Date(builtAt).toISOString().slice(0, 10)}${stale ? ' — older than 30 days; browser security fixes arrive with a rebuild' : ''}`
      : 'Build date unknown',
    ...(stale ? { fix: 'bash scripts/build-bot-computer.sh' } : {}),
  });

  let network = await client.networkInspect(config.network).catch(() => null);
  if (!network && config.networkManaged) {
    try {
      await client.networkCreate(config.network, { [LABEL_COMPUTER]: '1', [LABEL_NAMESPACE]: config.namespace });
      network = await client.networkInspect(config.network);
    } catch (err) {
      return fail('network_invalid', {
        id: 'network',
        ok: false,
        detail: toErrorMessage(err),
        fix: networkFix(config),
      });
    }
  }
  if (!network) {
    return fail('network_invalid', {
      id: 'network',
      ok: false,
      detail: `Network ${config.network} does not exist`,
      fix: networkFix(config),
    });
  }
  const problems: string[] = [];
  if (network.driver !== 'bridge') problems.push(`driver is ${network.driver}, expected bridge`);
  if (network.icc) problems.push('inter-container traffic is on');
  if (config.hardened && network.ipv6) problems.push('IPv6 is on');
  if (problems.length > 0) {
    return fail('network_invalid', {
      id: 'network',
      ok: false,
      detail: `Network ${config.network}: ${problems.join('; ')}`,
      fix: networkFix(config),
    });
  }
  checks.push({
    id: 'network',
    ok: true,
    detail: `${config.network} (bridge, inter-container traffic off${network.ipv6 ? '' : ', IPv6 off'}${network.internal ? ', internal' : ''})`,
  });

  // ICC off only separates computers from each other; the host, the LAN and
  // cloud metadata are the egress rules' job, and hardened mode needs them.
  if (config.hardened) {
    const egress = await (opts.egressCheck ?? checkComputerEgress)(config).catch(
      (err: unknown): EgressCheckResult => ({ ok: false, detail: toErrorMessage(err) }),
    );
    if (!egress.ok) {
      return fail('network_invalid', {
        id: 'egress',
        ok: false,
        detail: `Egress rules for ${config.network} are missing or unsafe: ${egress.detail}`,
        fix: egressFix(config),
      });
    }
    checks.push({
      id: 'egress',
      ok: true,
      detail: `Private networks, this host and cloud metadata are blocked${config.proxy ? ` (proxy ${config.proxy} allowed when private)` : ''}`,
    });
  } else {
    checks.push({
      id: 'egress',
      ok: true,
      detail: 'Not enforced in development mode: computers can reach this machine and its network',
    });
  }
  return { ok: true, reason: null, checks, memTotal, image, gateways: network.gateways };
}

// ─── Hosted prechecks (BOTS_COMPUTER_DRIVER=e2b) ──────────

/** The provider calls the hosted prechecks make (tests fake them). */
export interface HostedPrecheckDeps {
  status(name: string): Promise<TemplateStatus>;
  /** Build the template on the provider; resolves once it is ready. */
  build(onLog: (line: string) => void): Promise<void>;
}

/** The template build this process runs (at most one), and how the last one ended. */
interface TemplateBuild {
  name: string;
  startedAt: number;
  running: boolean;
  failedAt: number | null;
  error: string | null;
  lines: string[];
}
let templateBuild: TemplateBuild | null = null;

export function templateOptions(config: BotsComputerConfig): ComputerTemplateOptions {
  return { contract: IMAGE_CONTRACT, cpuCount: config.e2b!.cpuCount, memoryMB: config.e2b!.memoryMB };
}

/** Start building `name` in the background (once per process; a failure waits TEMPLATE_RETRY_MS). */
function startTemplateBuild(name: string, deps: HostedPrecheckDeps, now: number): TemplateBuild {
  const build: TemplateBuild = { name, startedAt: now, running: true, failedAt: null, error: null, lines: [] };
  templateBuild = build;
  logger.info('[bots-computer] building the computer template on the sandbox provider', { template: name });
  void deps
    .build((line) => {
      build.lines.push(line.slice(0, 300));
      if (build.lines.length > 40) build.lines.shift();
      if (/error|fail/i.test(line)) logger.warn(`[bots-computer] template build: ${line.slice(0, 300)}`);
    })
    .then(
      () => {
        build.running = false;
        logger.info('[bots-computer] computer template ready', {
          template: name,
          duration_ms: Date.now() - build.startedAt,
        });
        // Ready now, not at the next recheck.
        if (state.view.state !== 'ready') void check();
      },
      (err: unknown) => {
        build.running = false;
        build.failedAt = Date.now();
        build.error = toErrorMessage(err).slice(0, 1000);
        logger.warn(`[bots-computer] computer template build failed: ${build.error}`, { template: name });
      },
    );
  return build;
}

/**
 * The provider answers to the key, and the current template is ready there —
 * built here first when it is not. Pure over `deps` (unit-tested).
 */
export async function runHostedPrechecks(
  config: BotsComputerConfig,
  deps: HostedPrecheckDeps,
  now = Date.now(),
): Promise<PrecheckResult> {
  const checks: RuntimeCheck[] = [];
  const fail = (reason: string, check: RuntimeCheck): PrecheckResult => {
    checks.push(check);
    return { ok: false, reason, checks, memTotal: null, image: null, gateways: [], template: null };
  };
  const provider = config.e2b?.domain ?? 'e2b.app';
  const name = await computerTemplateName(templateOptions(config));

  let status: TemplateStatus;
  try {
    status = await deps.status(name);
  } catch (err) {
    const mapped = providerError(err, 'Reaching the sandbox provider');
    const reason = mapped instanceof ComputerRuntimeError ? mapped.reason : 'provider_unreachable';
    return fail(reason, {
      id: 'provider',
      ok: false,
      detail: toErrorMessage(mapped),
      fix:
        reason === 'provider_auth'
          ? 'Check BOTS_COMPUTER_E2B_API_KEY (and BOTS_COMPUTER_E2B_DOMAIN for PPIO) and restart the API.'
          : `Make sure this server can reach api.${provider} over HTTPS.`,
    });
  }
  checks.push({
    id: 'provider',
    ok: true,
    detail: `${provider} · ${config.e2b?.cpuCount} vCPU / ${config.e2b?.memoryMB} MiB per computer`,
  });

  if (status.state === 'ready') {
    checks.push({ id: 'template', ok: true, detail: `${name} · build ${status.buildId?.slice(0, 8) ?? '?'}` });
    return { ok: true, reason: null, checks, memTotal: null, image: null, gateways: [], template: name };
  }
  const build = templateBuild?.name === name ? templateBuild : null;
  if (build?.running || status.state === 'building') {
    const minutes = build ? Math.max(0, Math.round((now - build.startedAt) / 60_000)) : null;
    return fail('template_building', {
      id: 'template',
      ok: false,
      detail: `Building ${name} on the provider${minutes !== null ? ` (${minutes} min so far)` : ''}; computers start once it is ready (usually 2–5 minutes).`,
    });
  }
  if (build?.failedAt && now - build.failedAt < TEMPLATE_RETRY_MS) {
    return fail('template_failed', {
      id: 'template',
      ok: false,
      detail: `Building ${name} failed: ${build.error ?? 'unknown error'}\n${build.lines.slice(-8).join('\n')}`,
      fix: 'The build is retried 30 minutes after it failed, or when the API restarts. The log lines above come from the provider.',
    });
  }
  startTemplateBuild(name, deps, now);
  return fail('template_building', {
    id: 'template',
    ok: false,
    detail: `Building ${name} on the provider now; computers start once it is ready (usually 2–5 minutes).`,
  });
}

// ─── State ────────────────────────────────────────────────

function setView(view: ComputerRuntimeView): void {
  const previous = state.view;
  state.view = view;
  if (previous.state !== view.state || previous.reason !== view.reason) {
    logger.info('[bots-computer] runtime transition', {
      from: previous.state,
      to: view.state,
      reason: view.reason,
      hardened: view.hardened,
    });
  }
}

export function getComputerRuntime(): ComputerRuntimeView {
  return { ...state.view, driver: state.config?.driver ?? 'docker' };
}

async function environment(): Promise<ControllerEnvironment> {
  const config = state.config;
  if (!config) throw new ComputerUnavailableError('disabled', 'The computer is not enabled on this deployment');
  const knobs = await resolveComputerKnobs();
  const maxRunning = clampMaxRunning(knobs.maxRunningSetting, state.memTotal, config.memoryBytes);
  state.maxRunning = maxRunning;
  if (config.driver === 'e2b') {
    return {
      config,
      maxRunning,
      idleMinutes: knobs.idleMinutes,
      urlBlocklist: greenhouseUrlBlocklist(process.env),
      imageId: state.template,
      // The provider keeps sandboxes off private networks; its in-VM metadata service answers by design.
      egressProbe: [],
      hostDisk: null,
    };
  }
  return {
    config,
    maxRunning,
    idleMinutes: knobs.idleMinutes,
    urlBlocklist: greenhouseUrlBlocklist(process.env, state.gateways),
    imageId: state.image?.id ?? null,
    egressProbe: config.hardened ? egressProbeTargets(state.gateways) : [],
    hostDisk: state.hostDisk,
  };
}

/** What a hardened computer must not reach: this API on the bridge gateway, and cloud metadata. */
function egressProbeTargets(gateways: string[]): string[] {
  const port = /^\d{1,5}$/.test(process.env.API_PORT?.trim() ?? '') ? process.env.API_PORT!.trim() : '3000';
  return [...gateways.map((gateway) => `http://${gateway}:${port}/`), 'http://169.254.169.254/'];
}

async function userIsActive(userId: string): Promise<boolean | null> {
  const user = await getDb().users.getById(userId);
  if (!user) return null;
  if (user.status !== 'active' || (user.role !== 'super' && user.role !== 'team')) return false;
  return await userHasFeature(user.id, user.role, 'bots');
}

/** A Bot of the member waits on a secure sign-in or take-over card (see controller.ts). */
async function awaitingHuman(userId: string): Promise<boolean> {
  const since = Date.now() - HUMAN_WAIT_HOLD_MS;
  const pending = await getDb().bots.listRequests(userId, { status: 'pending', kinds: ['login', 'takeover'] });
  return pending.some((request) => Date.parse(request.created_at) >= since);
}

function notifyOwner(row: BotComputerRow): void {
  connectionManager.sendToUser(row.user_id, {
    type: 'bots:computer',
    state: row.state,
    controller: row.lease_controller,
  });
}

/** A host failure seen outside the prechecks: close the runtime and start healing. */
function onRuntimeError(err: ComputerRuntimeError): void {
  if (state.view.state !== 'ready') return;
  logger.warn(`[bots-computer] host failure, closing computers: ${err.message}`);
  setView({ state: 'unavailable', reason: err.reason, hardened: state.view.hardened });
  scheduleRecheck();
}

/** Rules can vanish after the precheck (a firewall reload, a reboot without persistence). */
async function reverifyEgress(): Promise<void> {
  const config = state.config;
  if (!config?.hardened || config.driver !== 'docker') return;
  const result = await egressCheck(config);
  if (result.ok) return;
  state.checks = state.checks.map((c) =>
    c.id === 'egress'
      ? {
          id: 'egress',
          ok: false,
          detail: `Egress rules for ${config.network} are gone: ${result.detail}`,
          fix: egressFix(config),
        }
      : c,
  );
  onRuntimeError(
    new ComputerRuntimeError('network_invalid', `Computer egress rules failed verification: ${result.detail}`),
  );
}

function scheduleRecheck(): void {
  if (recheckTimer) return;
  recheckTimer = setTimeout(() => {
    recheckTimer = null;
    void check();
  }, RECHECK_MS);
  recheckTimer.unref?.();
}

async function check(): Promise<void> {
  if (checking) return await checking;
  checking = (async () => {
    const config = state.config;
    if (!config) return;
    setView({ state: 'checking', reason: null, hardened: config.hardened });
    try {
      const result =
        config.driver === 'e2b' && hostedDeps
          ? await runHostedPrechecks(config, hostedDeps)
          : await runComputerPrechecks(docker, config, { egressCheck });
      state.checks = result.checks;
      if (!result.ok) {
        setView({ state: 'unavailable', reason: result.reason, hardened: config.hardened });
        scheduleRecheck();
        return;
      }
      state.memTotal = result.memTotal;
      state.image = result.image;
      state.gateways = result.gateways;
      state.template = result.template ?? null;
      // Before anyone can use a computer again: clear what an outage left
      // behind (a deleted member's container and volume, a suspended
      // member's computer, starts and stops whose process died).
      if (controller) {
        try {
          await controller.reconcile();
        } catch (err) {
          logger.warn(`[bots-computer] reconcile failed: ${toErrorMessage(err)}`);
        }
      }
      const env = await environment();
      state.checks.push({
        id: 'capacity',
        ok: true,
        detail:
          config.driver === 'e2b'
            ? `${env.maxRunning} at once, idle after ${env.idleMinutes} min (asleep computers cost nothing at the provider). A plan may cap continuous running (E2B Hobby: 1 h): a computer that reaches it pauses, its work frozen, and carries on at its next use.`
            : `${env.maxRunning} at once at ${config.memory} each${
                result.memTotal ? ` (host memory ${(result.memTotal / 1024 ** 3).toFixed(1)} GiB)` : ''
              }, idle after ${env.idleMinutes} min`,
      });
      setView({ state: 'ready', reason: null, hardened: config.hardened });
      // Ready before the scheduled re-check (a template build that just finished): it has nothing left to do.
      if (recheckTimer) {
        clearTimeout(recheckTimer);
        recheckTimer = null;
      }
    } catch (err) {
      logger.warn(`[bots-computer] precheck crashed: ${toErrorMessage(err)}`);
      setView({
        state: 'unavailable',
        reason: config.driver === 'e2b' ? 'provider_unreachable' : 'docker_unreachable',
        hardened: config.hardened,
      });
      scheduleRecheck();
    }
  })();
  try {
    await checking;
  } finally {
    checking = null;
  }
}

function every(ms: number, name: string, fn: () => Promise<void>, firstDelayMs = ms): void {
  let running = false;
  const tick = async () => {
    if (running || state.view.state !== 'ready' || !controller) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      logger.warn(`[bots-computer] ${name} loop failed: ${toErrorMessage(err)}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => {
    void tick();
    const timer = setInterval(() => void tick(), ms);
    timer.unref?.();
    loopTimers.push(timer);
  }, firstDelayMs);
  first.unref?.();
  loopTimers.push(first);
}

/**
 * The settings the runtime was started with that only a restart applies: on/off, the
 * driver and the sandbox provider (key, domain). Runtime Config can change the provider's
 * (bots.computer_sandbox_*), so an admin write that changes them restarts the runtime.
 */
function providerSettings(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.BOTS_COMPUTER_E2B_API_KEY?.trim() ?? '';
  return JSON.stringify([
    env.BOTS_COMPUTER_ENABLED?.trim() ?? '',
    env.BOTS_COMPUTER_DRIVER?.trim() ?? '',
    key ? createHash('sha256').update(key).digest('hex') : '',
    env.BOTS_COMPUTER_E2B_DOMAIN?.trim() ?? '',
  ]);
}
let startedWith: string | null = null;
let restarting: Promise<void> | null = null;

onWorkspaceConfigRefreshed(async () => {
  if (startedWith === null || providerSettings() === startedWith) return;
  if (restarting) return await restarting;
  logger.info('[bots-computer] the sandbox provider settings changed; restarting the computer runtime');
  restarting = (async () => {
    await shutdownBotComputers();
    await initBotComputers();
  })();
  try {
    await restarting;
  } finally {
    restarting = null;
  }
});

export async function initBotComputers(): Promise<void> {
  startedWith = providerSettings();
  // A restart (new provider settings) starts from nothing: a disabled runtime reports no driver of before.
  state.config = null;
  if (!isBotsComputerEnabled()) {
    setView({ state: 'disabled', reason: null, hardened: false });
    return;
  }
  try {
    state.config = loadBotsComputerConfig();
  } catch (err) {
    const reason = err instanceof ComputerConfigError ? err.reason : 'config_invalid';
    state.checks = [
      { id: 'config', ok: false, detail: toErrorMessage(err), fix: 'Fix BOTS_COMPUTER_* in .env and restart the API.' },
    ];
    setView({ state: 'unavailable', reason, hardened: true });
    logger.warn(`[bots-computer] configuration rejected: ${toErrorMessage(err)}`);
    return;
  }
  if (state.config.driver === 'e2b') {
    const e2b = state.config.e2b!;
    const conn = { apiKey: e2b.apiKey, ...(e2b.domain ? { domain: e2b.domain } : {}) };
    const signingKey = process.env.TOKEN_SIGNING_KEY?.trim() ?? '';
    try {
      host = createE2bHost({ api: createE2bApi(conn), namespace: state.config.namespace, secretKey: signingKey });
    } catch (err) {
      // Never reached past the auth guard at boot; kept closed should that order ever change.
      state.checks = [
        { id: 'config', ok: false, detail: toErrorMessage(err), fix: 'Set TOKEN_SIGNING_KEY and restart the API.' },
      ];
      setView({ state: 'unavailable', reason: 'config_invalid', hardened: true });
      return;
    }
    const options = templateOptions(state.config);
    hostedDeps = {
      status: (name) => templateStatus(conn, name),
      build: async (onLog) => {
        await buildComputerTemplate(conn, options, onLog);
      },
    };
  }
  controller = createComputerController({
    store: getDb().botComputers,
    host,
    environment,
    userIsActive,
    awaitingHuman,
    memberLocale: async (userId) => (await getDb().users.getById(userId))?.locale ?? null,
    // Loaded lazily: jobs.ts sits above the runtime (it reaches containers through it).
    runningJobs: async (container) => (await import('./jobs.js')).runningJobCount(container, { host: () => host }),
    onState: notifyOwner,
    onStopped: (userId, reason) => computerLifecycleHooks.stopped(userId, reason),
    onRuntimeError,
    onHostDisk: (reading) => {
      state.hostDisk = reading;
    },
  });
  await check();
  every(IDLE_TICK_MS, 'idle', () => controller!.idleTick());
  every(HEALTH_TICK_MS, 'health', async () => {
    await controller!.healthTick();
    state.running = (await getDb().botComputers.listByStates(['starting', 'running'])).length;
  });
  every(LEASE_TICK_MS, 'lease', () => computerLifecycleHooks.leaseTick());
  every(DISK_TICK_MS, 'disk', () => controller!.diskTick(), FIRST_DISK_TICK_MS);
  if (state.config.driver === 'docker' && state.config.hardened) {
    every(EGRESS_TICK_MS, 'egress', () => reverifyEgress());
  }
  if (state.config.driver === 'e2b') every(RECONCILE_TICK_MS, 'reconcile', () => controller!.reconcile());
  // jobs.ts and the engine it wakes sit above the runtime: loaded lazily, as for runningJobs.
  every(WATCH_CHECK_MS, 'process watches', async () => {
    const [{ listJobsIfRunning }, engine] = await Promise.all([import('./jobs.js'), import('../engine/index.js')]);
    await checkProcessWatches({
      store: getDb().botComputers,
      listJobs: (userId) => listJobsIfRunning(userId),
      deliver: (sessionId, item) => engine.deliverToConversation(sessionId, item),
    });
  });
  logger.info('[bots-computer] runtime initialised', {
    state: state.view.state,
    reason: state.view.reason,
    namespace: state.config.namespace,
    driver: state.config.driver,
    ...(state.config.driver === 'docker'
      ? { runtime: state.config.runtime, network: state.config.network }
      : { provider: state.config.e2b?.domain ?? 'e2b.app' }),
  });
}

export async function shutdownBotComputers(): Promise<void> {
  for (const timer of loopTimers.splice(0)) clearTimeout(timer);
  if (recheckTimer) clearTimeout(recheckTimer);
  recheckTimer = null;
  await computerLifecycleHooks.shutdown();
}

/** The controller and the host computers run on, or a ComputerUnavailableError the caller can show. */
export function requireComputerRuntime(): {
  controller: ComputerController;
  host: ComputerHost;
  config: BotsComputerConfig;
} {
  if (!state.config || state.view.state === 'disabled') {
    throw new ComputerUnavailableError('disabled', 'The computer is not enabled on this deployment');
  }
  if (state.view.state !== 'ready' || !controller) {
    throw new ComputerUnavailableError(
      'unavailable',
      `Computers are unavailable on this server right now (${state.view.reason ?? state.view.state})`,
    );
  }
  return { controller, host, config: state.config };
}

/**
 * The deployment namespace once BOTS_COMPUTER_* is loaded — even while the
 * host is unavailable — for writes that only need the member's row (their
 * timezone); null when computers are off or misconfigured.
 */
export function computerNamespace(): string | null {
  return state.config?.namespace ?? null;
}

/**
 * Timestamps leave the API as ISO 8601: Postgres' text form
 * ("2026-10-05 08:00:00.123+00") is not parseable by every browser's Date.
 */
function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export async function computerStatusFor(userId: string): Promise<ComputerStatusView> {
  const db = getDb();
  const [row, user] = await Promise.all([db.botComputers.get(userId), db.users.getById(userId)]);
  return {
    runtime: getComputerRuntime(),
    state: row?.state ?? 'absent',
    state_reason: row?.state_reason ?? null,
    controller: row?.lease_controller ?? 'bot',
    controller_since: iso(row?.lease_since),
    last_active_at: iso(row?.last_active_at),
    queue_position: controller?.queuePosition(userId) ?? null,
    disk_bytes: row?.disk_bytes ?? null,
    timezone: row?.timezone ?? null,
    lang: computerLang(state.config?.lang ?? null, user?.locale),
  };
}

/** Stop a member's computer (volume kept). No-op when there is none or computers are off. */
export async function stopUserComputer(userId: string, reason: string): Promise<void> {
  if (!controller) return;
  const known = ['idle', 'lru', 'reset', 'suspend', 'admin', 'user', 'purge'] as const;
  const stopReason = (known as readonly string[]).includes(reason) ? (reason as (typeof known)[number]) : 'admin';
  await controller.stop(userId, stopReason);
}

/** Host failures under which a host call can only fail or hang: cleanup waits for reconcile. */
const DOCKER_DOWN = new Set(['docker_unreachable', 'docker_cli_missing', 'provider_unreachable', 'provider_auth']);

/**
 * Suspend / delete / feature off (`suspend`, `admin`): stop the computer,
 * close live viewers and this process's DevTools connection, and cancel the
 * member's background Bot tasks; `wipe` (member deleted) also removes the
 * home volume. Revocations never fail on Docker: a broken host is logged and
 * the next reconcile (the host coming back) clears the container and volume —
 * the start gate already refuses this member. `reset` (an admin's "reset and
 * wipe") stays strict, so a wipe that did not happen is reported.
 */
export async function purgeUserComputer(
  userId: string,
  opts: { wipe: boolean; reason?: 'suspend' | 'reset' | 'admin' },
): Promise<void> {
  const reason = opts.reason ?? 'suspend';
  const revocation = reason !== 'reset';
  computerLifecycleHooks.purged(userId);
  if (revocation) await cancelBackgroundTasks(userId);
  if (!controller) return;
  if (state.view.state === 'unavailable' && DOCKER_DOWN.has(state.view.reason ?? '')) {
    if (!revocation) {
      throw new ComputerUnavailableError('unavailable', 'Computers are unavailable on this server right now');
    }
    logger.warn('[bots-computer] docker is down; the computer is cleared when it is back', { user_id: userId, reason });
    return;
  }
  try {
    await controller.purge(userId, { wipe: opts.wipe, reason });
  } catch (err) {
    if (!revocation) throw err;
    logger.warn('[bots-computer] purge failed; reconcile clears it when the host is back', {
      user_id: userId,
      reason,
      error: toErrorMessage(err),
    });
  }
}

/**
 * The engine owns background tasks; loaded lazily like lease.ts does (the
 * engine sits above the computer). Best effort: a failure is logged.
 */
async function cancelBackgroundTasks(userId: string): Promise<void> {
  try {
    const engine = await import('../engine/index.js');
    await engine.cancelBotTasksForUser(getDb(), userId);
  } catch (err) {
    logger.warn('[bots-computer] could not cancel background tasks', { user_id: userId, error: toErrorMessage(err) });
  }
}

/**
 * A decision on a take-over card (see lease.ts). Loaded lazily: the lease
 * module sits above the runtime (it wakes Bots through the engine), and the
 * runtime stays importable on its own (e.g. by /health).
 */
export async function handleTakeoverDecision(args: {
  userId: string;
  request: BotRequestRow;
  decision: BotRequestDecision;
}): Promise<void> {
  const lease = await import('./lease.js');
  await lease.handleTakeoverDecision(args);
}

/** Public /health block: no user ids, paths or image names. */
export function botsComputerHealthView(): {
  state: string;
  reason?: string;
  running?: number;
  max_running?: number;
} {
  const view = state.view;
  if (view.state === 'disabled' || view.state === 'checking') return { state: view.state };
  if (view.state === 'unavailable') return { state: view.state, ...(view.reason ? { reason: view.reason } : {}) };
  return { state: view.state, running: state.running, max_running: state.maxRunning ?? undefined };
}

/** The admin page's view of the Docker disk guard (computed: the reading changes between prechecks). */
function hostDiskCheck(): RuntimeCheck {
  const reading = state.hostDisk;
  if (!reading) return { id: 'host_disk', ok: true, detail: 'not measured yet' };
  const ok = reading.freeRatio >= HOST_DISK_MIN_FREE_RATIO;
  return {
    id: 'host_disk',
    ok,
    detail: `${Math.floor(reading.freeRatio * 100)}% free on the Docker disk`,
    ...(ok
      ? {}
      : {
          fix: [
            '# New computers do not start below 10 % free; running ones keep running. Free space on the Docker host, e.g.:',
            'docker image prune -a   # images no container uses (old bot-computer builds)',
            'docker system df        # what else takes the space',
          ].join('\n'),
        }),
  };
}

/** GET /api/admin/bot-computers. */
export async function adminComputersView(): Promise<{
  runtime: ComputerRuntimeView;
  computers: ComputerAdminRow[];
  settings: { idle_minutes: number; max_running: number };
  checks: RuntimeCheck[];
}> {
  const db = getDb();
  const knobs = await resolveComputerKnobs();
  const rows = await db.botComputers.list();
  const users = await Promise.all(rows.map((row) => db.users.getById(row.user_id)));
  const running = rows.filter((row) => row.state === 'running').map((row) => row.container_name);
  let memory = new Map<string, number>();
  if (state.view.state === 'ready' && running.length > 0) {
    memory = await host.memoryUsage(running).catch(() => new Map<string, number>());
  }
  const computers: ComputerAdminRow[] = rows
    .map((row, index) => ({
      user_id: row.user_id,
      nickname: users[index]?.nickname || users[index]?.email || row.user_id,
      state: row.state,
      state_reason: row.state_reason,
      controller: row.lease_controller,
      last_active_at: iso(row.last_active_at),
      last_started_at: iso(row.last_started_at),
      disk_bytes: row.disk_bytes,
      memory_bytes: memory.get(row.container_name) ?? null,
    }))
    .sort((a, b) => Date.parse(b.last_active_at ?? '') - Date.parse(a.last_active_at ?? ''));
  const effective = state.config
    ? clampMaxRunning(knobs.maxRunningSetting, state.memTotal, state.config.memoryBytes)
    : knobs.maxRunningSetting;
  return {
    runtime: getComputerRuntime(),
    computers,
    settings: { idle_minutes: knobs.idleMinutes, max_running: effective },
    checks: [...state.checks.map((c) => ({ ...c })), ...(state.config?.driver === 'docker' ? [hostDiskCheck()] : [])],
  };
}

// ─── Test seams ───────────────────────────────────────────

/** Replace the docker client, the egress check and/or state (tests and the live verification harness only). */
export function _setComputerRuntimeForTests(overrides: {
  docker?: DockerClient;
  egressCheck?: EgressCheck;
  reset?: boolean;
}): void {
  if (overrides.reset) {
    for (const timer of loopTimers.splice(0)) clearTimeout(timer);
    if (recheckTimer) clearTimeout(recheckTimer);
    recheckTimer = null;
    state = initialState();
    controller = null;
    egressCheck = checkComputerEgress;
    hostedDeps = null;
    templateBuild = null;
  }
  if (overrides.docker) {
    docker = overrides.docker;
    host = createDockerHost(docker);
  }
  if (overrides.egressCheck) egressCheck = overrides.egressCheck;
}
