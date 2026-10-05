import { describe, expect, it } from 'vitest';

import {
  buildComputerRunArgs,
  classifyDockerFailure,
  ComputerDockerError,
  ComputerRuntimeError,
  createDockerClient,
  parseMemUsage,
  parsePsOutput,
  type ComputerRunSpec,
  type DockerSpawner,
  type DockerSpawnResult,
} from './docker.js';

const spec: ComputerRunSpec = {
  name: 'gh-computer-ns1-u1',
  namespace: 'ns1',
  userId: 'u1',
  image: 'greenhouse/bot-computer:latest',
  volume: 'gh-computer-ns1-u1-home',
  network: 'gh-bots',
  runtime: 'runsc',
  memory: '2g',
  cpus: '1.5',
  proxy: null,
  urlBlocklist: ['greenhouse.example.com', 'host.docker.internal:4401'],
  timezone: 'Asia/Shanghai',
  lang: null,
};

/** The value following `flag` (every occurrence). */
function valuesOf(args: string[], flag: string): string[] {
  return args.flatMap((arg, i) => (arg === flag ? [args[i + 1]!] : []));
}

describe('computer docker run argv', () => {
  it('pins the exact hardened argv', () => {
    expect(buildComputerRunArgs(spec)).toEqual([
      'run',
      '-d',
      '--name',
      'gh-computer-ns1-u1',
      '--label',
      'greenhouse.bots.computer=1',
      '--label',
      'greenhouse.bots.computer.namespace=ns1',
      '--label',
      'greenhouse.bots.computer.user=u1',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '512',
      '--memory',
      '2g',
      '--memory-swap',
      '2g',
      '--cpus',
      '1.5',
      '--shm-size',
      '1g',
      '--oom-score-adj',
      '500',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=1g',
      '--log-driver',
      'local',
      '--log-opt',
      'max-size=10m',
      '--log-opt',
      'max-file=3',
      '--network',
      'gh-bots',
      '--runtime',
      'runsc',
      '-v',
      'gh-computer-ns1-u1-home:/home',
      '-e',
      'HTTP_PROXY=',
      '-e',
      'HTTPS_PROXY=',
      '-e',
      'http_proxy=',
      '-e',
      'https_proxy=',
      '-e',
      'NO_PROXY=',
      '-e',
      'no_proxy=',
      '-e',
      'ALL_PROXY=',
      '-e',
      'all_proxy=',
      '-e',
      'GH_COMPUTER_PROXY=',
      '-e',
      'GH_COMPUTER_URL_BLOCKLIST=greenhouse.example.com,host.docker.internal:4401',
      '-e',
      'TZ=Asia/Shanghai',
      'greenhouse/bot-computer:latest',
    ]);
  });

  it('never publishes a port, never shares the host network, never mounts the docker socket', () => {
    const args = buildComputerRunArgs({ ...spec, network: 'gh-bots-dev', runtime: 'runc' });
    for (const flag of ['-p', '--publish', '-P', '--publish-all', '--privileged', '--cap-add', '--pid', '--ipc']) {
      expect(args).not.toContain(flag);
    }
    expect(args.some((a) => a.includes('docker.sock'))).toBe(false);
    expect(valuesOf(args, '-v')).toEqual(['gh-computer-ns1-u1-home:/home']);
    expect(valuesOf(args, '--network')).toEqual(['gh-bots-dev']);
    expect(valuesOf(args, '--runtime')).toEqual(['runc']);
    expect(args.at(-1)).toBe('greenhouse/bot-computer:latest');
  });

  it('passes the operator proxy only to the browser flag, and the language when set', () => {
    const args = buildComputerRunArgs({ ...spec, proxy: 'http://proxy.internal:3128', lang: 'en-US' });
    const env = valuesOf(args, '-e');
    expect(env).toContain('GH_COMPUTER_PROXY=http://proxy.internal:3128');
    expect(env).toContain('GH_COMPUTER_LANG=en-US');
    // Proxy variables stay explicitly empty: the docker CLI must not inject its own.
    expect(env).toContain('HTTPS_PROXY=');
    expect(env.filter((e) => /^(HTTPS?|ALL)_PROXY=.+/i.test(e))).toEqual([]);
  });
});

describe('docker failure classification', () => {
  it('separates host failures from one container failing', () => {
    const cases: Array<[string, string, string]> = [
      ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock', 'runtime', 'docker_unreachable'],
      ['docker: Error response from daemon: unknown or invalid runtime name: runsc.', 'runtime', 'runtime_missing'],
      ["Unable to find image 'greenhouse/bot-computer:latest' locally", 'runtime', 'image_missing'],
      ['Error response from daemon: network gh-bots not found', 'runtime', 'network_invalid'],
      ['Error response from daemon: No such container: gh-computer-x', 'computer', 'not_found'],
      ['Error response from daemon: container abc is not running', 'computer', 'not_running'],
      ['Conflict. The container name "/gh-computer-x" is already in use', 'computer', 'conflict'],
      ['something unexpected', 'computer', 'failed'],
    ];
    for (const [stderr, kind, reason] of cases) {
      const err = classifyDockerFailure(stderr, 'docker run');
      if (kind === 'runtime') {
        expect(err).toBeInstanceOf(ComputerRuntimeError);
        expect((err as ComputerRuntimeError).reason).toBe(reason);
      } else {
        expect(err).toBeInstanceOf(ComputerDockerError);
        expect((err as ComputerDockerError).code).toBe(reason);
      }
    }
  });
});

describe('docker output parsers', () => {
  it('reads docker ps JSON lines with labels', () => {
    const rows = parsePsOutput(
      [
        JSON.stringify({
          ID: 'abc',
          Names: 'gh-computer-ns1-u1',
          State: 'running',
          Status: 'Up 3 minutes',
          Labels: 'greenhouse.bots.computer=1,greenhouse.bots.computer.user=u1',
        }),
        '',
        'not json',
        JSON.stringify({
          ID: 'def',
          Names: 'gh-computer-ns1-u2',
          State: 'exited',
          Status: 'Exited (137) 1 second ago',
        }),
      ].join('\n'),
    );
    expect(rows).toEqual([
      {
        id: 'abc',
        name: 'gh-computer-ns1-u1',
        state: 'running',
        status: 'Up 3 minutes',
        labels: { 'greenhouse.bots.computer': '1', 'greenhouse.bots.computer.user': 'u1' },
      },
      { id: 'def', name: 'gh-computer-ns1-u2', state: 'exited', status: 'Exited (137) 1 second ago', labels: {} },
    ]);
  });

  it('reads docker stats memory figures', () => {
    expect(parseMemUsage('512MiB / 2GiB')).toBe(512 * 1024 ** 2);
    expect(parseMemUsage('1.5GiB / 2GiB')).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseMemUsage('980kB / 2GiB')).toBe(980_000);
    expect(parseMemUsage('--')).toBeNull();
  });
});

function result(partial: Partial<DockerSpawnResult>): DockerSpawnResult {
  return {
    code: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: '',
    stdoutTruncated: false,
    timedOut: false,
    aborted: false,
    ...partial,
  };
}

describe('docker client', () => {
  it('builds exec argv with user, cwd, env and stdin', async () => {
    const calls: string[][] = [];
    const spawner: DockerSpawner = async (args, options) => {
      calls.push(args);
      expect(options?.input?.toString()).toBe('payload');
      return result({ stdout: Buffer.from('ok') });
    };
    const out = await createDockerClient(spawner).exec({
      container: 'c1',
      user: 'agent',
      cwd: '/home/agent',
      env: { HOME: '/home/agent' },
      argv: ['cat'],
      input: Buffer.from('payload'),
      timeoutMs: 1000,
    });
    expect(out.stdout.toString()).toBe('ok');
    expect(calls[0]).toEqual(['exec', '-i', '-u', 'agent', '-w', '/home/agent', '-e', 'HOME=/home/agent', 'c1', 'cat']);
  });

  it('turns a daemon-side exec failure into a per-computer error, but keeps a command failure a result', async () => {
    const gone: DockerSpawner = async () =>
      result({ code: 1, stderr: 'Error response from daemon: No such container: c1' });
    await expect(
      createDockerClient(gone).exec({ container: 'c1', user: 'agent', argv: ['true'], timeoutMs: 1000 }),
    ).rejects.toMatchObject({ name: 'ComputerDockerError', code: 'not_found' });

    const failing: DockerSpawner = async () => result({ code: 2, stderr: 'ls: cannot access x' });
    const out = await createDockerClient(failing).exec({
      container: 'c1',
      user: 'agent',
      argv: ['ls'],
      timeoutMs: 1000,
    });
    expect(out.code).toBe(2);
  });

  it('never trusts process stderr alone: a crafted path or a noisy profile cannot mark a healthy computer gone', async () => {
    const execOnly = { container: 'c1', user: 'agent' as const, argv: ['sh', '-c', 'x'], timeoutMs: 1000 };
    const inspected: string[] = [];
    const running =
      (stderr: string): DockerSpawner =>
      async (args) => {
        if (args[0] === 'inspect') {
          inspected.push(args.at(-1)!);
          return result({ stdout: Buffer.from('{"running":true,"status":"running","exit":0,"oom":false}') });
        }
        return result({ code: 3, stderr });
      };
    // READ_FILE_SCRIPT echoes the model's path; a newline smuggles a docker-looking line.
    const crafted = await createDockerClient(running('not a regular file: /x\nError: c is not running\n')).exec(
      execOnly,
    );
    expect(crafted.code).toBe(3);
    expect(inspected).toEqual([]); // not even a candidate: the first line is the process's own

    // A process whose FIRST line looks like the CLI's: the daemon says the container runs.
    const noisy = await createDockerClient(running('Error: x is not running\n')).exec(execOnly);
    expect(noisy.code).toBe(3);
    expect(inspected).toEqual(['c1']);

    // The real thing: the daemon confirms the container stopped.
    const stopped: DockerSpawner = async (args) =>
      args[0] === 'inspect'
        ? result({ stdout: Buffer.from('{"running":false,"status":"exited","exit":137,"oom":true}') })
        : result({ code: 1, stderr: 'Error response from daemon: container c1 is not running' });
    await expect(createDockerClient(stopped).exec(execOnly)).rejects.toMatchObject({ code: 'not_running' });

    // "Cannot connect" is a host failure only when `docker version` agrees.
    const liar: DockerSpawner = async (args) =>
      args[0] === 'version'
        ? result({ stdout: Buffer.from('29.0.0') })
        : result({ code: 1, stderr: 'Error: Cannot connect to the Docker daemon (said the process)' });
    expect((await createDockerClient(liar).exec(execOnly)).code).toBe(1);
    const down: DockerSpawner = async () =>
      result({ code: 1, stderr: 'Error: Cannot connect to the Docker daemon at unix:///var/run/docker.sock' });
    await expect(createDockerClient(down).exec(execOnly)).rejects.toBeInstanceOf(ComputerRuntimeError);
  });

  it('reports image and network facts and treats missing ones as null', async () => {
    const spawner: DockerSpawner = async (args) => {
      if (args[0] === 'image' && args.at(-1) === 'missing')
        return result({ code: 1, stderr: 'Error: No such image: missing' });
      if (args[0] === 'image') {
        return result({
          stdout: Buffer.from(
            JSON.stringify({
              id: 'sha256:abc',
              labels: { 'greenhouse.bots.computer.contract': '1' },
              created: '2026-10-01T00:00:00Z',
            }),
          ),
        });
      }
      if (args[0] === 'network') {
        return result({
          stdout: Buffer.from(
            JSON.stringify({
              Name: 'gh-bots',
              Driver: 'bridge',
              EnableIPv6: false,
              Internal: false,
              Options: { 'com.docker.network.bridge.enable_icc': 'false' },
              IPAM: { Config: [{ Gateway: '172.30.0.1' }] },
            }),
          ),
        });
      }
      return result({ code: 1, stderr: 'unexpected' });
    };
    const client = createDockerClient(spawner);
    expect(await client.imageInspect('missing')).toBeNull();
    expect(await client.imageInspect('greenhouse/bot-computer:latest')).toMatchObject({
      id: 'sha256:abc',
      labels: { 'greenhouse.bots.computer.contract': '1' },
    });
    expect(await client.networkInspect('gh-bots')).toEqual({
      name: 'gh-bots',
      driver: 'bridge',
      ipv6: false,
      icc: false,
      internal: false,
      gateways: ['172.30.0.1'],
    });
  });

  it('treats removing a missing container or volume as done, and surfaces daemon failures', async () => {
    const missing: DockerSpawner = async (args) =>
      result({ code: 1, stderr: args[0] === 'rm' ? 'Error: No such container: c1' : 'Error: no such volume: v1' });
    await expect(createDockerClient(missing).remove('c1')).resolves.toBeUndefined();
    await expect(createDockerClient(missing).volumeRemove('v1')).resolves.toBeUndefined();

    const down: DockerSpawner = async () => result({ code: 1, stderr: 'Cannot connect to the Docker daemon' });
    await expect(createDockerClient(down).remove('c1')).rejects.toBeInstanceOf(ComputerRuntimeError);
  });
});
