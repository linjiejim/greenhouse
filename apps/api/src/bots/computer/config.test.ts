import { describe, expect, it, vi } from 'vitest';

// config.ts reads the two knobs through the settings module; the pure parts tested here never touch it.
vi.mock('../../settings/workspace-config.js', () => ({ getWorkspaceValue: vi.fn() }));

import {
  clampMaxRunning,
  ComputerConfigError,
  computerLang,
  greenhouseUrlBlocklist,
  loadBotsComputerConfig,
  namespaceFromDatabaseUrl,
  parseIdleMinutes,
  parseMaxRunning,
  parseMemoryBytes,
  parseTimezone,
} from './config.js';

const DB = 'postgresql://greenhouse:pw@localhost:5432/greenhouse';
const dev = {
  NODE_ENV: 'development',
  BOTS_COMPUTER_ALLOW_UNHARDENED: '1',
  BOTS_COMPUTER_RUNTIME: 'runc',
  DATABASE_URL: DB,
};

function reasonOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof ComputerConfigError ? err.reason : 'other';
  }
}

describe('bots computer config', () => {
  it('BOTS_COMPUTER_DRIVER=e2b: a provider key instead of Docker; the size as whole vCPUs and even MiB', () => {
    const hosted = { NODE_ENV: 'production', DATABASE_URL: DB, BOTS_COMPUTER_DRIVER: 'e2b' };
    expect(reasonOf(() => loadBotsComputerConfig(hosted))).toBe('config_invalid');
    const config = loadBotsComputerConfig({
      ...hosted,
      BOTS_COMPUTER_E2B_API_KEY: 'e2b_test',
      BOTS_COMPUTER_MEMORY: '1.5g',
      BOTS_COMPUTER_CPUS: '1.5',
    });
    // No Docker network, no unhardened mode: a microVM per computer is the boundary.
    expect(config).toMatchObject({ driver: 'e2b', hardened: true, runtime: 'e2b', network: '', networkManaged: false });
    expect(config.e2b).toEqual({ apiKey: 'e2b_test', domain: null, cpuCount: 2, memoryMB: 1536 });
    expect(
      loadBotsComputerConfig({
        ...hosted,
        BOTS_COMPUTER_E2B_API_KEY: 'k',
        BOTS_COMPUTER_E2B_DOMAIN: 'CN-Beijing-1.sandbox.ppio.com',
        BOTS_COMPUTER_MEMORY: '2049m',
      }).e2b,
    ).toMatchObject({ domain: 'cn-beijing-1.sandbox.ppio.com', memoryMB: 2050 });
    expect(
      reasonOf(() =>
        loadBotsComputerConfig({ ...hosted, BOTS_COMPUTER_E2B_API_KEY: 'k', BOTS_COMPUTER_E2B_DOMAIN: 'https://x/y' }),
      ),
    ).toBe('config_invalid');
    expect(reasonOf(() => loadBotsComputerConfig({ ...hosted, BOTS_COMPUTER_DRIVER: 'kvm' }))).toBe('config_invalid');
    // The docker driver is the default and carries no provider.
    expect(
      loadBotsComputerConfig({ NODE_ENV: 'production', DATABASE_URL: DB, BOTS_COMPUTER_NETWORK: 'gh-bots' }),
    ).toMatchObject({ driver: 'docker', e2b: null });
  });

  it('defaults to hardened gVisor and requires a dedicated network', () => {
    expect(reasonOf(() => loadBotsComputerConfig({ NODE_ENV: 'production', DATABASE_URL: DB }))).toBe(
      'network_invalid',
    );
    const config = loadBotsComputerConfig({
      NODE_ENV: 'production',
      DATABASE_URL: DB,
      BOTS_COMPUTER_NETWORK: 'gh-bots',
    });
    expect(config).toMatchObject({
      hardened: true,
      runtime: 'runsc',
      network: 'gh-bots',
      networkManaged: false,
      memory: '2g',
      memoryBytes: 2 * 1024 ** 3,
      cpus: '1.5',
      proxy: null,
      image: 'greenhouse/bot-computer:latest',
    });
  });

  it('refuses runc without the escape hatch, and the escape hatch outside development/test', () => {
    expect(
      reasonOf(() =>
        loadBotsComputerConfig({
          NODE_ENV: 'development',
          BOTS_COMPUTER_RUNTIME: 'runc',
          BOTS_COMPUTER_NETWORK: 'gh-bots',
        }),
      ),
    ).toBe('runtime_not_hardened');
    expect(
      reasonOf(() => loadBotsComputerConfig({ ...dev, NODE_ENV: 'production', BOTS_COMPUTER_NETWORK: 'gh-bots' })),
    ).toBe('unhardened_not_allowed');
    expect(reasonOf(() => loadBotsComputerConfig({ ...dev, NODE_ENV: undefined }))).toBe('unhardened_not_allowed');
  });

  it('refuses bridge, host, none and the Mission network in hardened mode', () => {
    for (const network of ['bridge', 'host', 'none', 'cloud-agent']) {
      expect(reasonOf(() => loadBotsComputerConfig({ DATABASE_URL: DB, BOTS_COMPUTER_NETWORK: network }))).toBe(
        'network_invalid',
      );
    }
    expect(
      reasonOf(() =>
        loadBotsComputerConfig({
          DATABASE_URL: DB,
          SANDBOX_RUNNER_NETWORK: 'mission-net',
          BOTS_COMPUTER_NETWORK: 'mission-net',
        }),
      ),
    ).toBe('network_invalid');
  });

  it('gives development a per-namespace managed bridge and still refuses host networking', () => {
    const config = loadBotsComputerConfig(dev);
    expect(config.hardened).toBe(false);
    expect(config.runtime).toBe('runc');
    expect(config.networkManaged).toBe(true);
    expect(config.network).toBe(`gh-bots-${config.namespace}`);
    expect(reasonOf(() => loadBotsComputerConfig({ ...dev, BOTS_COMPUTER_NETWORK: 'host' }))).toBe('network_invalid');
    expect(loadBotsComputerConfig({ ...dev, BOTS_COMPUTER_NETWORK: 'bridge' }).network).toBe('bridge');
  });

  it('derives a stable namespace from the database identity (not the password)', () => {
    const a = namespaceFromDatabaseUrl('postgresql://u:one@localhost:5432/greenhouse');
    const b = namespaceFromDatabaseUrl('postgresql://u:two@localhost:5432/greenhouse');
    const c = namespaceFromDatabaseUrl('postgresql://u:one@localhost:5432/greenhouse_wt2');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(loadBotsComputerConfig({ ...dev, BOTS_COMPUTER_NAMESPACE: 'blue1' }).namespace).toBe('blue1');
    expect(reasonOf(() => loadBotsComputerConfig({ ...dev, BOTS_COMPUTER_NAMESPACE: 'Bad-NS' }))).toBe(
      'config_invalid',
    );
  });

  it('validates resources and the proxy', () => {
    expect(parseMemoryBytes('1.5g')).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(parseMemoryBytes('512m')).toBe(512 * 1024 ** 2);
    expect(parseMemoryBytes('lots')).toBeNull();
    expect(reasonOf(() => loadBotsComputerConfig({ ...dev, BOTS_COMPUTER_MEMORY: '256m' }))).toBe('config_invalid');
    expect(reasonOf(() => loadBotsComputerConfig({ ...dev, BOTS_COMPUTER_CPUS: '0' }))).toBe('config_invalid');
    expect(loadBotsComputerConfig({ ...dev, BOTS_COMPUTER_PROXY: 'http://host.docker.internal:7890/' }).proxy).toBe(
      'http://host.docker.internal:7890',
    );
    expect(reasonOf(() => loadBotsComputerConfig({ ...dev, BOTS_COMPUTER_PROXY: 'http://user:pw@proxy:1' }))).toBe(
      'config_invalid',
    );
    expect(reasonOf(() => loadBotsComputerConfig({ ...dev, BOTS_COMPUTER_PROXY: 'ftp://proxy:1' }))).toBe(
      'config_invalid',
    );
  });

  it('blocks greenhouse itself and cloud metadata in the browser', () => {
    expect(
      greenhouseUrlBlocklist(
        {
          PUBLIC_BASE_URL: 'https://green.example.com',
          WEB_BASE_URL: 'https://green.example.com/app',
          CORS_ALLOWED_ORIGINS: 'http://localhost:4400, https://admin.example.com:8443',
          API_PORT: '4401',
          WEB_PORT: '4400',
        },
        ['172.30.0.1'],
      ),
    ).toEqual([
      '100.100.100.200',
      '169.254.169.254',
      '172.30.0.1',
      'admin.example.com:8443',
      'green.example.com',
      'host.docker.internal:4400',
      'host.docker.internal:4401',
      'localhost:4400',
      'metadata.google.internal',
    ]);
  });
});

describe('per member: browser language, timezone, job keep-awake', () => {
  it('takes the language from the member’s locale unless the operator set BOTS_COMPUTER_LANG', () => {
    expect(computerLang(null, 'zh')).toBe('zh-CN');
    expect(computerLang(null, 'zh-TW')).toBe('zh-CN');
    expect(computerLang(null, ' ZH-cn ')).toBe('zh-CN');
    expect(computerLang(null, 'en')).toBe('en-US');
    expect(computerLang(null, 'ja')).toBe('en-US');
    expect(computerLang(null, null)).toBe('en-US');
    expect(computerLang('ja-JP', 'zh')).toBe('ja-JP');
    expect(loadBotsComputerConfig(dev).lang).toBeNull(); // per member unless overridden
    expect(loadBotsComputerConfig({ ...dev, BOTS_COMPUTER_LANG: 'zh-CN' }).lang).toBe('zh-CN');
  });

  it('accepts IANA zone names only, as the browser reports them', () => {
    expect(parseTimezone('Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(parseTimezone(' America/Argentina/Buenos_Aires ')).toBe('America/Argentina/Buenos_Aires');
    expect(parseTimezone('UTC')).toBe('UTC');
    expect(parseTimezone('Etc/GMT+8')).toBe('Etc/GMT+8');
    expect(parseTimezone('asia/shanghai')).toBe('Asia/Shanghai'); // the container's zone files are case-sensitive
    for (const bad of [
      'Mars/Olympus_Mons',
      '+08:00',
      '+0800',
      '',
      '   ',
      'Asia/Shanghai; rm -rf /',
      `Asia/${'x'.repeat(70)}`,
    ]) {
      expect(parseTimezone(bad), bad).toBeNull();
    }
    expect(parseTimezone(8)).toBeNull();
    expect(parseTimezone(null)).toBeNull();
  });

  it('validates BOTS_COMPUTER_JOB_MAX_HOURS (default 8, 0 = never, at most a week)', () => {
    expect(loadBotsComputerConfig(dev).jobMaxHours).toBe(8);
    expect(loadBotsComputerConfig({ ...dev, BOTS_COMPUTER_JOB_MAX_HOURS: '' }).jobMaxHours).toBe(8);
    expect(loadBotsComputerConfig({ ...dev, BOTS_COMPUTER_JOB_MAX_HOURS: '0' }).jobMaxHours).toBe(0);
    expect(loadBotsComputerConfig({ ...dev, BOTS_COMPUTER_JOB_MAX_HOURS: '168' }).jobMaxHours).toBe(168);
    for (const bad of ['169', '-1', '2.5', 'forever']) {
      expect(
        reasonOf(() => loadBotsComputerConfig({ ...dev, BOTS_COMPUTER_JOB_MAX_HOURS: bad })),
        bad,
      ).toBe('config_invalid');
    }
  });
});

describe('computer knobs', () => {
  it('accepts integers in range only', () => {
    expect(parseIdleMinutes('15')).toBe(15);
    expect(parseIdleMinutes(240)).toBe(240);
    expect(parseIdleMinutes('4')).toBeNull();
    expect(parseIdleMinutes('241')).toBeNull();
    expect(parseIdleMinutes('7.5')).toBeNull();
    expect(parseMaxRunning('1')).toBe(1);
    expect(parseMaxRunning('50')).toBe(50);
    expect(parseMaxRunning('0')).toBeNull();
    expect(parseMaxRunning('lots')).toBeNull();
  });

  it('caps concurrency by host memory after a 4 GiB reserve', () => {
    const gib = 1024 ** 3;
    expect(clampMaxRunning(10, 15 * gib, 2 * gib)).toBe(5);
    expect(clampMaxRunning(2, 15 * gib, 2 * gib)).toBe(2);
    expect(clampMaxRunning(4, 4 * gib, 2 * gib)).toBe(1);
    expect(clampMaxRunning(4, null, 2 * gib)).toBe(4);
  });
});
