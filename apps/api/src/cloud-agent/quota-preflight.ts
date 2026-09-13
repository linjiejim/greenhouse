/** Kernel workspace-quota release gate for the Mission Sandbox Runner. */

import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';

import type { SandboxRunnerConfig } from './config.js';
import { userHomeFor } from './workspace.js';

const execFileAsync = promisify(execFile);
const PREFLIGHT_TIMEOUT_MS = 5_000;
const ATTEST_TIMEOUT_MS = 15_000;
const MAX_ATTEST_OUTPUT_BYTES = 64 * 1024;

type QuotaMechanism = 'xfs-project' | 'ext4-project';

export type WorkspaceQuotaPosture =
  | { mode: 'monitor-only' }
  | {
      mode: 'kernel-enforced';
      mechanism: QuotaMechanism;
      inodeLimit: number;
      verification: 'per-user-on-admission';
    };

interface QuotaMarker {
  version: 2;
  data_root: string;
  limit_bytes: number;
  inode_limit: number;
  scope: 'per-user';
  mechanism: QuotaMechanism;
  attest_command: string;
  verified_at: string;
}

export interface UserWorkspaceQuotaAttestation {
  version: 1;
  data_root: string;
  user_id: string;
  path: string;
  scope: 'per-user';
  mechanism: QuotaMechanism;
  project_id: number;
  limit_bytes: number;
  inode_limit: number;
  project_inherit: true;
  exclusive: true;
  verified_at: string;
}

export type QuotaCommandRunner = (command: string, args: readonly string[]) => Promise<{ stdout: string | Buffer }>;

export type AssertUserWorkspaceQuota = (userId: string) => Promise<void>;

/**
 * Per-user proof failures are an admission problem, not a global Docker
 * control-plane failure. Callers may turn this into a scoped 503 without
 * closing historical Mission reads or quarantining other users' runs.
 */
export class WorkspaceQuotaAttestationError extends Error {
  constructor(options?: ErrorOptions) {
    super('Mission workspace quota is not verified for this user', options);
    this.name = 'WorkspaceQuotaAttestationError';
  }
}

function localOnly(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function parseQuotaMarker(raw: string, config: SandboxRunnerConfig): QuotaMarker {
  const marker = parseJsonObject(raw, 'Sandbox workspace quota marker') as Partial<QuotaMarker>;
  if (marker.version !== 2) throw new Error('Sandbox workspace quota marker version is unsupported');
  if (resolve(String(marker.data_root ?? '')) !== resolve(config.dataRoot)) {
    throw new Error('Sandbox workspace quota marker does not match SANDBOX_RUNNER_DATA_ROOT');
  }
  if (marker.limit_bytes !== config.userDiskQuotaBytes) {
    throw new Error('Sandbox workspace quota marker does not match the configured byte limit');
  }
  if (marker.inode_limit !== config.userInodeQuota) {
    throw new Error('Sandbox workspace quota marker does not match the configured inode limit');
  }
  if (marker.scope !== 'per-user') {
    throw new Error('Sandbox workspace quota marker must attest per-user enforcement');
  }
  if (marker.mechanism !== 'xfs-project' && marker.mechanism !== 'ext4-project') {
    throw new Error('Sandbox workspace quota marker mechanism is unsupported');
  }
  if (resolve(String(marker.attest_command ?? '')) !== resolve(config.quotaAttestCommand)) {
    throw new Error('Sandbox workspace quota marker does not match SANDBOX_RUNNER_QUOTA_ATTEST_COMMAND');
  }
  if (typeof marker.verified_at !== 'string' || !Number.isFinite(Date.parse(marker.verified_at))) {
    throw new Error('Sandbox workspace quota marker requires a valid verified_at timestamp');
  }
  return marker as QuotaMarker;
}

export function parseUserWorkspaceQuotaAttestation(
  raw: string,
  expected: {
    config: SandboxRunnerConfig;
    posture: Extract<WorkspaceQuotaPosture, { mode: 'kernel-enforced' }>;
    userId: string;
    userHome: string;
  },
): UserWorkspaceQuotaAttestation {
  const proof = parseJsonObject(raw, 'Sandbox per-user quota attestation') as Partial<UserWorkspaceQuotaAttestation>;
  if (proof.version !== 1) throw new Error('Sandbox per-user quota attestation version is unsupported');
  if (resolve(String(proof.data_root ?? '')) !== resolve(expected.config.dataRoot)) {
    throw new Error('Sandbox per-user quota attestation has the wrong data root');
  }
  if (proof.user_id !== expected.userId) {
    throw new Error('Sandbox per-user quota attestation has the wrong user');
  }
  if (resolve(String(proof.path ?? '')) !== resolve(expected.userHome)) {
    throw new Error('Sandbox per-user quota attestation has the wrong path');
  }
  if (proof.scope !== 'per-user' || proof.exclusive !== true) {
    throw new Error('Sandbox per-user quota project must be exclusive to this user');
  }
  if (proof.mechanism !== expected.posture.mechanism) {
    throw new Error('Sandbox per-user quota attestation has the wrong mechanism');
  }
  if (!Number.isSafeInteger(proof.project_id) || Number(proof.project_id) < 1) {
    throw new Error('Sandbox per-user quota attestation requires a non-zero project id');
  }
  if (proof.limit_bytes !== expected.config.userDiskQuotaBytes) {
    throw new Error('Sandbox per-user quota attestation has the wrong byte hard limit');
  }
  if (proof.inode_limit !== expected.config.userInodeQuota) {
    throw new Error('Sandbox per-user quota attestation has the wrong inode hard limit');
  }
  if (proof.project_inherit !== true) {
    throw new Error('Sandbox per-user quota directory must inherit its project id');
  }
  if (typeof proof.verified_at !== 'string' || !Number.isFinite(Date.parse(proof.verified_at))) {
    throw new Error('Sandbox per-user quota attestation requires a valid verified_at timestamp');
  }
  return proof as UserWorkspaceQuotaAttestation;
}

async function assertRootOwnedFile(path: string, label: string, executable = false): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error(`Mission requires ${label} at ${path}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (typeof stat.uid === 'number' && stat.uid !== 0) throw new Error(`${label} must be owned by root`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label} must not be group/world writable`);
  if (executable && (stat.mode & 0o111) === 0) throw new Error(`${label} must be executable`);

  // Root ownership on the leaf is meaningless if the service account can
  // replace that leaf through a writable parent directory after boot.
  let parent = dirname(resolve(path));
  for (;;) {
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error(`${label} parent path must contain only real directories`);
    }
    if (typeof parentStat.uid === 'number' && parentStat.uid !== 0) {
      throw new Error(`${label} parent directories must be owned by root`);
    }
    if ((parentStat.mode & 0o022) !== 0) {
      throw new Error(`${label} parent directories must not be group/world writable`);
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}

/**
 * Shared/non-local Mission admission is impossible without all three:
 * - a root-owned marker matching this exact data root and hard limits;
 * - an ext4/XFS mount advertising project-quota support;
 * - a root-owned executable that will query each live user home on admission.
 *
 * The marker/mount only establish host capability. They do not prove a user
 * directory was assigned a project. That proof is deliberately deferred to
 * createUserWorkspaceQuotaVerifier() for every enqueue and container start.
 */
export async function validateWorkspaceQuota(
  config: SandboxRunnerConfig,
  env: NodeJS.ProcessEnv,
): Promise<WorkspaceQuotaPosture> {
  if (localOnly(env)) return { mode: 'monitor-only' };

  await assertRootOwnedFile(config.hardQuotaMarkerPath, 'a verified kernel workspace quota marker');
  const marker = parseQuotaMarker(await readFile(config.hardQuotaMarkerPath, 'utf8'), config);
  await assertRootOwnedFile(config.quotaAttestCommand, 'the Sandbox per-user quota attestation command', true);

  await mkdir(config.dataRoot, { recursive: true });
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('findmnt', ['-T', config.dataRoot, '-n', '-o', 'FSTYPE,OPTIONS'], {
      timeout: PREFLIGHT_TIMEOUT_MS,
    }));
  } catch {
    throw new Error('Mission cannot verify the workspace project-quota filesystem');
  }
  const [fsType = '', ...optionParts] = String(stdout).trim().split(/\s+/);
  const options = optionParts.join(',');
  const expectedFs = marker.mechanism === 'xfs-project' ? 'xfs' : 'ext4';
  if (fsType !== expectedFs || !/(^|,)(pquota|prjquota)(,|$)/.test(options)) {
    throw new Error(`Mission workspace filesystem must be ${expectedFs} with project quota enabled`);
  }
  return {
    mode: 'kernel-enforced',
    mechanism: marker.mechanism,
    inodeLimit: marker.inode_limit,
    verification: 'per-user-on-admission',
  };
}

async function runQuotaCommand(command: string, args: readonly string[]): Promise<{ stdout: string | Buffer }> {
  const result = await execFileAsync(command, [...args], {
    timeout: ATTEST_TIMEOUT_MS,
    maxBuffer: MAX_ATTEST_OUTPUT_BYTES,
    cwd: '/',
    env: {
      PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
    },
  });
  return { stdout: result.stdout };
}

/**
 * Build the per-user admission fence. The external command is read-only from
 * the API's perspective: an ops provisioner may create/configure homes, but
 * this verifier only accepts fresh evidence queried from the kernel. Missing
 * homes therefore fail before controller mkdir() can silently create project
 * 0 storage.
 */
export function createUserWorkspaceQuotaVerifier(
  config: SandboxRunnerConfig,
  env: NodeJS.ProcessEnv,
  posture: WorkspaceQuotaPosture,
  execute: QuotaCommandRunner = runQuotaCommand,
): AssertUserWorkspaceQuota {
  if (localOnly(env) || posture.mode === 'monitor-only') return async () => undefined;

  return async (userId: string) => {
    const userHome = userHomeFor(config.dataRoot, userId);
    try {
      const { stdout } = await execute(config.quotaAttestCommand, [
        'attest',
        '--data-root',
        config.dataRoot,
        '--user-id',
        userId,
        '--path',
        userHome,
        '--limit-bytes',
        String(config.userDiskQuotaBytes),
        '--inode-limit',
        String(config.userInodeQuota),
        '--mechanism',
        posture.mechanism,
      ]);
      parseUserWorkspaceQuotaAttestation(String(stdout), { config, posture, userId, userHome });

      const stat = await lstat(userHome);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Sandbox per-user quota path is not a real directory');
      }
      const canonicalRoot = await realpath(config.dataRoot);
      if (resolve(await realpath(userHome)) !== resolve(canonicalRoot, 'homes', userId)) {
        throw new Error('Sandbox per-user quota path resolves outside its declared location');
      }
    } catch (err) {
      logger.error('[mission] per-user workspace quota attestation failed', {
        userId,
        reason: toErrorMessage(err),
      });
      throw new WorkspaceQuotaAttestationError({ cause: err });
    }
  };
}
