import { describe, expect, it, vi } from 'vitest';
import type { ExecSpec } from '../docker.js';
import type { ComputerExec } from '../host.js';
import { ComputerDockerError } from '../docker.js';
import { ComputerUnavailableError } from '../errors.js';
import {
  jobLog,
  jobName,
  listJobs,
  parseJobId,
  parseJobList,
  runningJobCount,
  startJob,
  stopJob,
  type JobsDeps,
} from '../jobs.js';

function fakeDeps(reply: (spec: ExecSpec) => { code?: number; stdout?: string; stderr?: string }, running = true) {
  const calls: ExecSpec[] = [];
  const exec = vi.fn(async (spec: ExecSpec) => {
    calls.push(spec);
    const out = reply(spec);
    return {
      code: out.code ?? 0,
      stdout: Buffer.from(out.stdout ?? ''),
      stderr: out.stderr ?? '',
    };
  });
  const deps: JobsDeps = {
    host: () => ({ exec }) as unknown as Pick<ComputerExec, 'exec'>,
    runningContainer: async () => (running ? 'gh-computer-x' : null),
  };
  return { deps, calls };
}

describe('gh-jobs client', () => {
  it('validates ids and names', () => {
    expect(parseJobId('j0123abcd')).toBe('j0123abcd');
    expect(parseJobId('j0123abc')).toBeNull();
    expect(parseJobId('--help')).toBeNull();
    expect(jobName(undefined, '  python3 train.py --epochs 3')).toBe('python3');
    expect(jobName('build\nall', 'make')).toBe('build all');
    expect(jobName('x'.repeat(100), 'make')).toHaveLength(60);
  });

  it('parses a job list field by field and drops what it cannot read', () => {
    const list = parseJobList(
      JSON.stringify([
        {
          id: 'j00000001',
          name: 'train',
          command: 'python3 train.py',
          cwd: '/home/agent/work',
          status: 'running',
          exit_code: null,
          started_at: '2026-10-07T01:00:00Z',
          ended_at: null,
          log_bytes: 12,
        },
        { id: 'nope', status: 'running', started_at: 'x' },
        { id: 'j00000002', status: 'weird', started_at: 'x' },
      ]),
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'j00000001', status: 'running', exit_code: null, log_bytes: 12 });
    expect(parseJobList('not json')).toEqual([]);
  });

  it('starts a job with argv (never a script) as uid agent', async () => {
    const { deps, calls } = fakeDeps(() => ({
      stdout: JSON.stringify({ id: 'j0000beef', name: 'build', pid: 42, started_at: '2026-10-07T01:00:00Z' }),
    }));
    const job = await startJob('u1', { command: 'make all; echo $HOME', name: 'build' }, {}, deps);
    expect(job).toEqual({ id: 'j0000beef', name: 'build', pid: 42, started_at: '2026-10-07T01:00:00Z' });
    expect(calls[0]).toMatchObject({
      container: 'gh-computer-x',
      user: 'agent',
      argv: ['gh-jobs', 'start', '--name', 'build', '--cwd', '/home/agent/work', '--', 'make all; echo $HOME'],
    });
    expect(calls[0]!.env?.HOME).toBe('/home/agent');
  });

  it('gives a job the proxy a Bot shell call gets', async () => {
    const { deps, calls } = fakeDeps(() => ({
      stdout: JSON.stringify({ id: 'j0000beef', name: 'curl', pid: 1, started_at: '2026-10-07T01:00:00Z' }),
    }));
    await startJob(
      'u1',
      { command: 'curl -sO https://example.com/big.zip' },
      {},
      { ...deps, proxy: () => 'http://p:3128' },
    );
    expect(calls[0]!.env).toMatchObject({ HTTPS_PROXY: 'http://p:3128', http_proxy: 'http://p:3128' });
    expect(calls[0]!.env).not.toHaveProperty('GH_EXEC_ID');
  });

  it('refuses a cwd outside the agent home and an empty command', async () => {
    const { deps } = fakeDeps(() => ({}));
    await expect(startJob('u1', { command: 'ls', cwd: '/home/browser' }, {}, deps)).rejects.toBeInstanceOf(
      ComputerDockerError,
    );
    await expect(startJob('u1', { command: '   ' }, {}, deps)).rejects.toBeInstanceOf(ComputerDockerError);
  });

  it('lists nothing (and starts nothing) when the computer is not running', async () => {
    const { deps, calls } = fakeDeps(() => ({ stdout: '[]' }), false);
    expect(await listJobs('u1', deps)).toEqual([]);
    expect(calls).toHaveLength(0);
    await expect(stopJob('u1', 'j00000001', deps)).rejects.toBeInstanceOf(ComputerUnavailableError);
  });

  it('reads a log tail and maps an unknown id to not_found', async () => {
    const { deps, calls } = fakeDeps((spec) =>
      spec.argv[2] === 'j00000001' ? { stdout: 'a\nb\n' } : { code: 3, stderr: 'no such job' },
    );
    expect(await jobLog('u1', 'j00000001', { lines: 2 }, deps)).toEqual({
      id: 'j00000001',
      text: 'a\nb\n',
      truncated: true,
    });
    expect(calls[0]!.argv).toEqual(['gh-jobs', 'log', 'j00000001', '--lines', '2']);
    await expect(jobLog('u1', 'j00000002', {}, deps)).rejects.toMatchObject({ code: 'not_found' });
    await expect(jobLog('u1', '../x', {}, deps)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('counts running jobs and never throws for the idle tick', async () => {
    expect(await runningJobCount('c', fakeDeps(() => ({ stdout: '2\n' })).deps)).toBe(2);
    expect(await runningJobCount('c', fakeDeps(() => ({ stdout: 'garbage' })).deps)).toBe(0);
    expect(await runningJobCount('c', fakeDeps(() => ({ code: 127, stderr: 'gh-jobs: not found' })).deps)).toBe(0);
    const throwing: Pick<JobsDeps, 'host'> = {
      host: () => ({
        exec: async () => {
          throw new Error('daemon gone');
        },
      }),
    };
    expect(await runningJobCount('c', throwing)).toBe(0);
  });
});
