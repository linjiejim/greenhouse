/**
 * Mission Sandbox Runner configuration — env-driven, disabled by default.
 *
 * `MISSION_*` / `SANDBOX_RUNNER_*` are the canonical names. The historical
 * `CLOUD_AGENT_*` variables remain read-only aliases while deployed hosts and
 * old runner images migrate (trusted-execution convergence spec D2/D10).
 */

import { resolve } from 'node:path';
import { DATA_DIR } from '../paths.js';

export interface SandboxRunnerConfig {
  /** Host directory holding per-user homes (workspaces + sessions). */
  dataRoot: string;
  /** Runner image tag (the package currently lives in apps/agent-runner). */
  image: string;
  /** API base URL as seen FROM INSIDE a container. */
  apiBase: string;
  /** Global concurrent-container cap (per-user cap is fixed at 1). */
  maxConcurrent: number;
  /**
   * Dedicated user-defined bridge (`docker network create <name>`) — isolates
   * agent containers from other containers on the host's default bridge.
   */
  network: string;
  /** Optional host dir of team skills, mounted read-only into the sandbox. */
  skillsDir: string | null;
  /** docker run --memory / --cpus values. */
  memory: string;
  cpus: string;
  /**
   * Container runtime (`docker run --runtime`). Mission defaults to runsc;
   * production is never allowed to fall back to the daemon default.
   */
  dockerRuntime: string | null;
  /** True unless an explicit local-only unhardened escape hatch is active. */
  requireHardenedRuntime: boolean;
  /** Aggregate persistent-workspace budget for one user. */
  userDiskQuotaBytes: number;
  /** Kernel hard inode limit for the same per-user project. */
  userInodeQuota: number;
  /** Root-owned ops attestation checked against a project-quota filesystem. */
  hardQuotaMarkerPath: string;
  /** Root-owned executable that attests the live per-user project quota. */
  quotaAttestCommand: string;
  /** Archive inactive workspaces after this many days. */
  archiveAfterDays: number;
  /** Default + fallback model registry ids for new runs. */
  defaultModel: string;
  fallbackModel: string;
}

function enabled(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function value(env: NodeJS.ProcessEnv, canonical: string, legacy: string): string | undefined {
  return env[canonical] ?? env[legacy];
}

export function isMissionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabled(value(env, 'MISSION_ENABLED', 'CLOUD_AGENT_ENABLED'));
}

export function loadSandboxRunnerConfig(env: NodeJS.ProcessEnv = process.env): SandboxRunnerConfig {
  const maxConcurrent = Number(value(env, 'SANDBOX_RUNNER_MAX_CONCURRENT', 'CLOUD_AGENT_MAX_CONCURRENT') ?? 3);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('SANDBOX_RUNNER_MAX_CONCURRENT must be a positive integer');
  }
  const userDiskQuotaBytes = Number(
    value(env, 'SANDBOX_RUNNER_USER_DISK_QUOTA_BYTES', 'CLOUD_AGENT_USER_DISK_QUOTA_BYTES') ?? 5 * 1024 * 1024 * 1024,
  );
  if (!Number.isSafeInteger(userDiskQuotaBytes) || userDiskQuotaBytes < 1) {
    throw new Error('SANDBOX_RUNNER_USER_DISK_QUOTA_BYTES must be a positive safe integer');
  }
  const userInodeQuota = Number(env.SANDBOX_RUNNER_USER_INODE_QUOTA ?? 25_000);
  if (!Number.isSafeInteger(userInodeQuota) || userInodeQuota < 1) {
    throw new Error('SANDBOX_RUNNER_USER_INODE_QUOTA must be a positive safe integer');
  }
  const archiveAfterDays = Number(
    value(env, 'SANDBOX_RUNNER_ARCHIVE_AFTER_DAYS', 'CLOUD_AGENT_ARCHIVE_AFTER_DAYS') ?? 14,
  );
  if (!Number.isFinite(archiveAfterDays) || archiveAfterDays <= 0) {
    throw new Error('SANDBOX_RUNNER_ARCHIVE_AFTER_DAYS must be a positive number');
  }

  const dockerRuntime = value(env, 'SANDBOX_RUNNER_DOCKER_RUNTIME', 'CLOUD_AGENT_DOCKER_RUNTIME')?.trim() || 'runsc';
  const allowUnhardened = enabled(env.SANDBOX_RUNNER_ALLOW_UNHARDENED);
  const requireHardenedRuntime = !allowUnhardened;
  if (isMissionEnabled(env) && allowUnhardened && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new Error('SANDBOX_RUNNER_ALLOW_UNHARDENED is allowed only with NODE_ENV=development or test');
  }
  if (isMissionEnabled(env) && requireHardenedRuntime && dockerRuntime !== 'runsc') {
    throw new Error('Mission requires SANDBOX_RUNNER_DOCKER_RUNTIME=runsc');
  }

  return {
    // Anchored to the repo data/ dir, NOT process cwd — `pnpm --filter` starts
    // the api with cwd=apps/api and would otherwise grow a stray data tree.
    dataRoot: value(env, 'SANDBOX_RUNNER_DATA_ROOT', 'CLOUD_AGENT_DATA_ROOT')
      ? resolve(value(env, 'SANDBOX_RUNNER_DATA_ROOT', 'CLOUD_AGENT_DATA_ROOT')!)
      : resolve(DATA_DIR, 'cloud-agent'),
    // Keep the deployed storage/image/network defaults stable: changing these
    // names would strand persistent workspaces and require an ops cutover for
    // zero user value. Sandbox Runner is the package/process name, not a second
    // storage namespace (convergence spec D10).
    image: value(env, 'SANDBOX_RUNNER_IMAGE', 'CLOUD_AGENT_IMAGE') ?? 'greenhouse/agent-runtime:latest',
    apiBase: value(env, 'SANDBOX_RUNNER_API_BASE', 'CLOUD_AGENT_API_BASE') ?? 'http://host.docker.internal:3000',
    maxConcurrent,
    network: value(env, 'SANDBOX_RUNNER_NETWORK', 'CLOUD_AGENT_NETWORK') ?? 'cloud-agent',
    skillsDir: value(env, 'SANDBOX_RUNNER_SKILLS_DIR', 'CLOUD_AGENT_SKILLS_DIR')
      ? resolve(value(env, 'SANDBOX_RUNNER_SKILLS_DIR', 'CLOUD_AGENT_SKILLS_DIR')!)
      : null,
    memory: value(env, 'SANDBOX_RUNNER_MEMORY', 'CLOUD_AGENT_MEMORY') ?? '1.5g',
    cpus: value(env, 'SANDBOX_RUNNER_CPUS', 'CLOUD_AGENT_CPUS') ?? '2',
    dockerRuntime,
    requireHardenedRuntime,
    userDiskQuotaBytes,
    userInodeQuota,
    hardQuotaMarkerPath: resolve(env.SANDBOX_RUNNER_HARD_QUOTA_MARKER ?? '/etc/greenhouse/sandbox-runner-quota.json'),
    quotaAttestCommand: resolve(
      env.SANDBOX_RUNNER_QUOTA_ATTEST_COMMAND ?? '/usr/local/sbin/greenhouse-sandbox-runner-quota',
    ),
    archiveAfterDays,
    // `flash` is the one catalog id every deployment has (it follows LLM_*), so
    // it is the default for both roles. Point MISSION_DEFAULT_MODEL at a stronger
    // catalog entry (e.g. `pro`) once its key is configured; the
    // fallback is what a run continues on when that model's provider 429s or is
    // otherwise unavailable — deliberately the cheap, always-reachable one that
    // keeps a long run alive, not the pricier one.
    defaultModel: value(env, 'MISSION_DEFAULT_MODEL', 'CLOUD_AGENT_DEFAULT_MODEL') ?? 'flash',
    fallbackModel: value(env, 'MISSION_FALLBACK_MODEL', 'CLOUD_AGENT_FALLBACK_MODEL') ?? 'flash',
  };
}

/** Compatibility exports. New code must use Mission/Sandbox Runner names. */
export type CloudAgentConfig = SandboxRunnerConfig;
export const isCloudAgentEnabled = isMissionEnabled;
export const loadCloudAgentConfig = loadSandboxRunnerConfig;
