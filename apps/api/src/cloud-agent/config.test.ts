import { describe, expect, it } from 'vitest';

import { isMissionEnabled, loadSandboxRunnerConfig } from './config.js';

describe('Mission Sandbox Runner config', () => {
  it('recognizes the canonical feature switch and the legacy alias', () => {
    expect(isMissionEnabled({ MISSION_ENABLED: 'true' })).toBe(true);
    expect(isMissionEnabled({ CLOUD_AGENT_ENABLED: '1' })).toBe(true);
    expect(isMissionEnabled({})).toBe(false);
  });

  it('defaults enabled missions to runsc and rejects an implicit downgrade', () => {
    expect(loadSandboxRunnerConfig({ MISSION_ENABLED: 'true' }).dockerRuntime).toBe('runsc');
    expect(() =>
      loadSandboxRunnerConfig({
        MISSION_ENABLED: 'true',
        SANDBOX_RUNNER_DOCKER_RUNTIME: 'runc',
      }),
    ).toThrow(/runsc/);
  });

  it('allows an explicit unhardened local runner but never in production', () => {
    const local = loadSandboxRunnerConfig({
      NODE_ENV: 'development',
      MISSION_ENABLED: 'true',
      SANDBOX_RUNNER_ALLOW_UNHARDENED: 'true',
      SANDBOX_RUNNER_DOCKER_RUNTIME: 'runc',
    });
    expect(local.dockerRuntime).toBe('runc');
    expect(local.requireHardenedRuntime).toBe(false);
    expect(() =>
      loadSandboxRunnerConfig({
        NODE_ENV: 'production',
        MISSION_ENABLED: 'true',
        SANDBOX_RUNNER_ALLOW_UNHARDENED: 'true',
      }),
    ).toThrow(/only with NODE_ENV/);

    expect(() =>
      loadSandboxRunnerConfig({
        MISSION_ENABLED: 'true',
        SANDBOX_RUNNER_ALLOW_UNHARDENED: 'true',
      }),
    ).toThrow(/only with NODE_ENV/);
  });

  it('accepts canonical settings and legacy aliases during migration', () => {
    const config = loadSandboxRunnerConfig({
      MISSION_ENABLED: 'true',
      SANDBOX_RUNNER_DOCKER_RUNTIME: 'runsc',
      SANDBOX_RUNNER_USER_DISK_QUOTA_BYTES: '1048576',
      SANDBOX_RUNNER_USER_INODE_QUOTA: '12000',
      SANDBOX_RUNNER_HARD_QUOTA_MARKER: '/srv/greenhouse/quota.json',
      SANDBOX_RUNNER_QUOTA_ATTEST_COMMAND: '/usr/local/sbin/mission-quota-check',
      CLOUD_AGENT_ARCHIVE_AFTER_DAYS: '7',
    });
    expect(config.dockerRuntime).toBe('runsc');
    expect(config.requireHardenedRuntime).toBe(true);
    expect(config.userDiskQuotaBytes).toBe(1_048_576);
    expect(config.userInodeQuota).toBe(12_000);
    expect(config.hardQuotaMarkerPath).toBe('/srv/greenhouse/quota.json');
    expect(config.quotaAttestCommand).toBe('/usr/local/sbin/mission-quota-check');
    expect(config.archiveAfterDays).toBe(7);
  });

  it('rejects an invalid inode hard limit', () => {
    expect(() => loadSandboxRunnerConfig({ SANDBOX_RUNNER_USER_INODE_QUOTA: '0' })).toThrow(/USER_INODE_QUOTA/);
  });

  it('defaults both run models to the always-available flash entry', () => {
    const config = loadSandboxRunnerConfig({});
    expect(config.defaultModel).toBe('flash');
    // Flash, not Pro: the quota-exhaustion fallback should be the cheap,
    // always-reachable model that keeps a long run alive.
    expect(config.fallbackModel).toBe('flash');
  });

  it('lets a deployment override the fallback model', () => {
    const config = loadSandboxRunnerConfig({ MISSION_FALLBACK_MODEL: 'pro' });
    expect(config.fallbackModel).toBe('pro');
  });
});
