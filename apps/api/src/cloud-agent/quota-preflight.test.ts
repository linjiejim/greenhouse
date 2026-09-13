import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SandboxRunnerConfig } from './config.js';
import {
  createUserWorkspaceQuotaVerifier,
  parseQuotaMarker,
  parseUserWorkspaceQuotaAttestation,
  validateWorkspaceQuota,
  WorkspaceQuotaAttestationError,
  type WorkspaceQuotaPosture,
} from './quota-preflight.js';

let tempRoot: string | null = null;

function config(dataRoot = '/srv/greenhouse/mission'): SandboxRunnerConfig {
  return {
    dataRoot,
    image: 'image',
    apiBase: 'http://host.docker.internal:3101',
    maxConcurrent: 1,
    network: 'mission',
    skillsDir: null,
    memory: '1g',
    cpus: '1',
    dockerRuntime: 'runsc',
    requireHardenedRuntime: true,
    userDiskQuotaBytes: 5_000,
    userInodeQuota: 25_000,
    hardQuotaMarkerPath: '/definitely-missing/greenhouse-quota.json',
    quotaAttestCommand: '/usr/local/sbin/greenhouse-sandbox-runner-quota',
    archiveAfterDays: 14,
    defaultModel: 'flash',
    fallbackModel: 'flash',
  };
}

function kernelPosture(): Extract<WorkspaceQuotaPosture, { mode: 'kernel-enforced' }> {
  return {
    mode: 'kernel-enforced',
    mechanism: 'xfs-project',
    inodeLimit: 25_000,
    verification: 'per-user-on-admission',
  };
}

function userProof(cfg: SandboxRunnerConfig, userId = 'user_1') {
  return {
    version: 1,
    data_root: cfg.dataRoot,
    user_id: userId,
    path: join(cfg.dataRoot, 'homes', userId),
    scope: 'per-user',
    mechanism: 'xfs-project',
    project_id: 100_001,
    limit_bytes: cfg.userDiskQuotaBytes,
    inode_limit: cfg.userInodeQuota,
    project_inherit: true,
    exclusive: true,
    verified_at: '2026-08-12T00:00:00.000Z',
  } as const;
}

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('Mission workspace quota release gate', () => {
  it('accepts only the v2 host marker bound to the live attestation command and both hard limits', () => {
    const cfg = config();
    expect(
      parseQuotaMarker(
        JSON.stringify({
          version: 2,
          data_root: cfg.dataRoot,
          limit_bytes: cfg.userDiskQuotaBytes,
          inode_limit: cfg.userInodeQuota,
          scope: 'per-user',
          mechanism: 'xfs-project',
          attest_command: cfg.quotaAttestCommand,
          verified_at: '2026-08-12T00:00:00.000Z',
        }),
        cfg,
      ),
    ).toMatchObject({ mechanism: 'xfs-project', inode_limit: 25_000 });
  });

  it('rejects a legacy marker and markers for another root, limit, or command', () => {
    const cfg = config();
    const marker = {
      version: 2,
      data_root: '/wrong',
      limit_bytes: cfg.userDiskQuotaBytes,
      inode_limit: cfg.userInodeQuota,
      scope: 'per-user',
      mechanism: 'ext4-project',
      attest_command: cfg.quotaAttestCommand,
      verified_at: '2026-08-12T00:00:00.000Z',
    };
    expect(() => parseQuotaMarker(JSON.stringify({ ...marker, version: 1 }), cfg)).toThrow('version is unsupported');
    expect(() => parseQuotaMarker(JSON.stringify(marker), cfg)).toThrow('does not match SANDBOX_RUNNER_DATA_ROOT');
    expect(() =>
      parseQuotaMarker(JSON.stringify({ ...marker, data_root: cfg.dataRoot, inode_limit: 24_999 }), cfg),
    ).toThrow('configured inode limit');
    expect(() =>
      parseQuotaMarker(JSON.stringify({ ...marker, data_root: cfg.dataRoot, attest_command: '/tmp/untrusted' }), cfg),
    ).toThrow('QUOTA_ATTEST_COMMAND');
  });

  it('requires a non-zero exclusive project with exact byte/inode hard limits and inheritance', () => {
    const cfg = config();
    const expected = {
      config: cfg,
      posture: kernelPosture(),
      userId: 'user_1',
      userHome: join(cfg.dataRoot, 'homes', 'user_1'),
    };
    expect(parseUserWorkspaceQuotaAttestation(JSON.stringify(userProof(cfg)), expected)).toMatchObject({
      project_id: 100_001,
      exclusive: true,
    });
    expect(() =>
      parseUserWorkspaceQuotaAttestation(JSON.stringify({ ...userProof(cfg), project_id: 0 }), expected),
    ).toThrow('non-zero project id');
    expect(() =>
      parseUserWorkspaceQuotaAttestation(JSON.stringify({ ...userProof(cfg), exclusive: false }), expected),
    ).toThrow('exclusive to this user');
    expect(() =>
      parseUserWorkspaceQuotaAttestation(JSON.stringify({ ...userProof(cfg), limit_bytes: 4_999 }), expected),
    ).toThrow('byte hard limit');
    expect(() =>
      parseUserWorkspaceQuotaAttestation(JSON.stringify({ ...userProof(cfg), inode_limit: 24_999 }), expected),
    ).toThrow('inode hard limit');
    expect(() =>
      parseUserWorkspaceQuotaAttestation(JSON.stringify({ ...userProof(cfg), project_inherit: false }), expected),
    ).toThrow('inherit its project id');
  });

  it('queries the exact user home on every production admission and accepts a real directory only', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mission-user-quota-'));
    const cfg = config(tempRoot);
    const userHome = join(tempRoot, 'homes', 'user_1');
    await mkdir(userHome, { recursive: true });
    const execute = vi.fn(async () => ({ stdout: JSON.stringify(userProof(cfg)) }));
    const verify = createUserWorkspaceQuotaVerifier(cfg, { NODE_ENV: 'production' }, kernelPosture(), execute);

    await expect(verify('user_1')).resolves.toBeUndefined();
    await expect(verify('user_1')).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(cfg.quotaAttestCommand, [
      'attest',
      '--data-root',
      cfg.dataRoot,
      '--user-id',
      'user_1',
      '--path',
      userHome,
      '--limit-bytes',
      String(cfg.userDiskQuotaBytes),
      '--inode-limit',
      String(cfg.userInodeQuota),
      '--mechanism',
      'xfs-project',
    ]);
  });

  it('fails only that admission when the live proof is missing or project 0', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mission-user-quota-fail-'));
    const cfg = config(tempRoot);
    await mkdir(join(tempRoot, 'homes', 'user_bad'), { recursive: true });
    const verify = createUserWorkspaceQuotaVerifier(cfg, { NODE_ENV: 'production' }, kernelPosture(), async () => ({
      stdout: JSON.stringify({ ...userProof(cfg, 'user_bad'), project_id: 0 }),
    }));

    await expect(verify('user_bad')).rejects.toBeInstanceOf(WorkspaceQuotaAttestationError);
  });

  it('keeps local development explicit monitor-only but fails closed elsewhere without ops proof', async () => {
    await expect(validateWorkspaceQuota(config(), { NODE_ENV: 'test' })).resolves.toEqual({ mode: 'monitor-only' });
    await expect(validateWorkspaceQuota(config(), { NODE_ENV: 'production' })).rejects.toThrow(
      'requires a verified kernel workspace quota marker',
    );
  });
});
