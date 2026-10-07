import { describe, expect, it } from 'vitest';

import type { DockerClient, DockerSpawnResult, ExecSpec } from './docker.js';
import { KILL_SCRIPT, runShell, shellArgv, shellEnv, splitSidLine } from './shell.js';

function spawnResult(partial: Partial<DockerSpawnResult>): DockerSpawnResult {
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

/** A docker client whose exec answers from `respond`; records every exec spec. */
function fakeDocker(respond: (spec: ExecSpec) => Promise<DockerSpawnResult>) {
  const calls: ExecSpec[] = [];
  const client = {
    exec: async (spec: ExecSpec) => {
      calls.push(spec);
      return await respond(spec);
    },
  } as unknown as DockerClient;
  return { client, calls };
}

const isKill = (spec: ExecSpec) => spec.argv[0] === 'sh' && spec.argv[2] === KILL_SCRIPT;

describe('computer shell wrapper', () => {
  it('wraps the command with an in-container deadline, its own session and a file-size cap', () => {
    const argv = shellArgv('echo "$HOME" | wc -c', 30);
    expect(argv.slice(0, 7)).toEqual(['timeout', '-k', '5', '30', 'setsid', 'bash', '-lc']);
    expect(argv).toHaveLength(8);
    expect(argv[7]).toMatch(/^printf '__GH_SID__=%s\\n' "\$\$"; ulimit -f \d+; echo "\$HOME" \| wc -c$/);
  });

  it('sets the uid identity, the kill tag and explicit proxies', () => {
    const env = shellEnv('agent', 'abc', null);
    expect(env).toMatchObject({ HOME: '/home/agent', USER: 'agent', GH_EXEC_ID: 'abc', HTTPS_PROXY: '', no_proxy: '' });
    const proxied = shellEnv('agent', 'abc', 'http://proxy:3128');
    expect(proxied).toMatchObject({ HTTPS_PROXY: 'http://proxy:3128', http_proxy: 'http://proxy:3128' });
    expect(proxied.NO_PROXY).toContain('localhost');
  });

  it('strips the session line wherever a login shell put it', () => {
    expect(splitSidLine('__GH_SID__=42\nhello\n')).toEqual({ sid: '42', rest: 'hello\n' });
    expect(splitSidLine('motd line\n__GH_SID__=7\nout')).toEqual({ sid: '7', rest: 'motd line\nout' });
    expect(splitSidLine('no marker')).toEqual({ sid: null, rest: 'no marker' });
  });

  it('returns output without the marker and does not clean up after a normal exit', async () => {
    const { client, calls } = fakeDocker(async () =>
      spawnResult({ stdout: Buffer.from('__GH_SID__=12\nagent\n'), stderr: 'warn\n' }),
    );
    const result = await runShell(client, 'c1', 'id -un', { user: 'agent', timeoutSec: 10, proxy: null });
    expect(result).toEqual({ exitCode: 0, stdout: 'agent\n', stderr: 'warn\n', truncated: false, timedOut: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ container: 'c1', user: 'agent', cwd: '/home/agent', timeoutMs: 25_000 });
  });

  it('kills the whole session after an in-container timeout', async () => {
    const { client, calls } = fakeDocker(async (spec) =>
      isKill(spec) ? spawnResult({}) : spawnResult({ code: 124, stdout: Buffer.from('__GH_SID__=99\npartial') }),
    );
    const result = await runShell(client, 'c1', 'sleep 100', { user: 'agent', timeoutSec: 1, proxy: null });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe('partial');
    const kill = calls.find(isKill)!;
    expect(kill.user).toBe('agent');
    expect(kill.argv.slice(3)).toEqual(['gh-kill', calls[0]!.env!.GH_EXEC_ID, '99']);
  });

  it('kills the session on abort, even before the sid was reported', async () => {
    const controller = new AbortController();
    const { client, calls } = fakeDocker(async (spec) => {
      if (isKill(spec)) return spawnResult({});
      controller.abort();
      return spawnResult({ code: null, signal: 'SIGKILL', aborted: true });
    });
    const result = await runShell(client, 'c1', 'sleep 100', {
      user: 'agent',
      timeoutSec: 60,
      signal: controller.signal,
      proxy: null,
    });
    expect(result.exitCode).toBeNull();
    const kill = calls.find(isKill)!;
    expect(kill.argv.slice(3)).toEqual(['gh-kill', calls[0]!.env!.GH_EXEC_ID, '']);
  });

  it('caps combined output and says so', async () => {
    const { client } = fakeDocker(async () =>
      spawnResult({ stdout: Buffer.from(`__GH_SID__=1\n${'a'.repeat(5000)}`), stderr: 'b'.repeat(5000) }),
    );
    const result = await runShell(client, 'c1', 'noisy', {
      user: 'agent',
      timeoutSec: 5,
      maxOutputBytes: 1000,
      proxy: null,
    });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1000);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
