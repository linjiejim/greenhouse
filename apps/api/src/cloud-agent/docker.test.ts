import { describe, expect, it } from 'vitest';

import { buildDockerRunArgs, createDockerCli, type DockerCommand } from './docker.js';

describe('Sandbox Runner docker argv', () => {
  it('pins runsc and the complete container hardening posture', () => {
    const args = buildDockerRunArgs({
      runId: 'car_test',
      image: 'greenhouse/agent-runtime:latest',
      network: 'cloud-agent',
      memory: '1.5g',
      cpus: '2',
      runtime: 'runsc',
      mounts: [
        { host: '/host/workspace', container: '/workspace' },
        { host: '/host/session', container: '/session' },
        { host: '/host/skills', container: '/home/agent/.agents/skills', readonly: true },
      ],
      env: { GREENHOUSE_RUN_ID: 'car_test' },
    });

    expect(args).toEqual(
      expect.arrayContaining([
        '--runtime',
        'runsc',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--log-driver',
        'local',
        '--log-opt',
        'max-size=10m',
        '--log-opt',
        'max-file=3',
        '--pids-limit',
        '512',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=512m',
        '--tmpfs',
        '/home/agent:rw,nosuid,nodev,size=64m',
      ]),
    );
    expect(args).toContain('/host/skills:/home/agent/.agents/skills:ro');
    expect(args.at(-1)).toBe('greenhouse/agent-runtime:latest');
  });

  it('omits only the runtime flag for the explicit local escape hatch', () => {
    const args = buildDockerRunArgs({
      runId: 'car_local',
      image: 'image',
      network: 'network',
      memory: '1g',
      cpus: '1',
      runtime: null,
      mounts: [],
      env: {},
    });
    expect(args).not.toContain('--runtime');
    expect(args).toContain('--read-only');
  });
});

describe('Sandbox Runner docker cleanup', () => {
  it('treats only a confirmed missing container as an idempotent removal', async () => {
    const command: DockerCommand = async () => {
      const err = Object.assign(new Error('docker rm failed'), {
        stderr: 'Error response from daemon: No such container: car_missing',
      });
      throw err;
    };

    await expect(createDockerCli(command).removeContainer('car_missing')).resolves.toBeUndefined();
  });

  it('surfaces daemon and permission failures instead of pretending the container stopped', async () => {
    const command: DockerCommand = async () => {
      throw new Error('permission denied while connecting to the Docker daemon');
    };

    await expect(createDockerCli(command).removeContainer('car_live')).rejects.toThrow(
      'Failed to remove sandbox container car_live: permission denied',
    );
  });

  it('distinguishes a missing container from an unavailable Docker control plane during inspect', async () => {
    const missing: DockerCommand = async () => {
      throw Object.assign(new Error('inspect failed'), {
        stderr: 'Error: No such container: car_missing',
      });
    };
    await expect(createDockerCli(missing).inspectContainer('car_missing')).resolves.toBeNull();

    const unavailable: DockerCommand = async () => {
      throw new Error('Docker daemon request timed out');
    };
    await expect(createDockerCli(unavailable).inspectContainer('car_live')).rejects.toThrow(
      'Failed to inspect sandbox container car_live: Docker daemon request timed out',
    );
  });
});

describe('Sandbox Runner environment validation', () => {
  function preflightCommand(network: object): DockerCommand {
    return async (_executable, args) => {
      if (args[0] === 'network') return { stdout: JSON.stringify(network), stderr: '' };
      if (args[0] === 'info') return { stdout: JSON.stringify({ runsc: {} }), stderr: '' };
      return { stdout: '{}', stderr: '' };
    };
  }

  it('accepts only a bridge with IPv6 and east-west communication disabled', async () => {
    const docker = createDockerCli(
      preflightCommand({
        EnableIPv6: false,
        Options: { 'com.docker.network.bridge.enable_icc': 'false' },
      }),
    );
    await expect(
      docker.validateEnvironment?.({ image: 'image', network: 'mission', runtime: 'runsc' }),
    ).resolves.toBeUndefined();
  });

  it.each([
    { EnableIPv6: true, Options: { 'com.docker.network.bridge.enable_icc': 'false' } },
    { EnableIPv6: false, Options: {} },
  ])('rejects a network with an incomplete isolation posture', async (network) => {
    const docker = createDockerCli(preflightCommand(network));
    await expect(
      docker.validateEnvironment?.({ image: 'image', network: 'mission', runtime: 'runsc' }),
    ).rejects.toThrow('Mission Docker network is missing or unsafe');
  });
});
