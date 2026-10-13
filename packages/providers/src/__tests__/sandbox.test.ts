import { describe, expect, it } from 'vitest';
import { devtoolsArgs, dockerConfigSchema, runArgs, screenArgs, streamArgs, volumeOf } from '../sandbox/docker.js';

describe('the docker computer', () => {
  it('always runs hardened, with its home on a named volume and no published port', () => {
    const args = runArgs(dockerConfigSchema.parse({ image: 'greenhouse/computer:1' }), {
      name: 'gh-cmp-agt_1',
      labels: { 'greenhouse.agent': 'agt_1' },
      timezone: 'Asia/Shanghai',
    });
    const joined = args.join(' ');
    for (const flag of [
      '--read-only',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--pids-limit 512',
      '--memory 2g',
      '--memory-swap 2g',
      '--runtime runsc',
      `-v ${volumeOf('gh-cmp-agt_1')}:/home`,
      '-e TZ=Asia/Shanghai',
      '-e HTTPS_PROXY=',
    ]) {
      expect(joined).toContain(flag);
    }
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--publish');
    expect(args.at(-1)).toBe('greenhouse/computer:1');
  });

  it('streams through docker exec: the terminal as the agent, the screen and DevTools as the display user only', () => {
    expect(streamArgs('gh-cmp-agt_1', { argv: ['gh-term'], user: 'agent' })).toEqual([
      'exec',
      '-i',
      '-u',
      'agent',
      '-w',
      '/home/agent',
      'gh-cmp-agt_1',
      'gh-term',
    ]);
    expect(screenArgs('gh-cmp-agt_1')).toEqual([
      'exec',
      '-i',
      '-u',
      'browser',
      '-w',
      '/',
      'gh-cmp-agt_1',
      'socat',
      'STDIO',
      'UNIX-CONNECT:/tmp/browser/vnc.sock',
    ]);
    expect(devtoolsArgs('gh-cmp-agt_1')).toEqual([
      'exec',
      '-i',
      '-u',
      'browser',
      '-w',
      '/',
      'gh-cmp-agt_1',
      'socat',
      'STDIO',
      'UNIX-CONNECT:/tmp/browser/cdp.sock',
    ]);
  });

  it('defaults to gVisor and checks its settings', () => {
    expect(dockerConfigSchema.parse({}).runtime).toBe('runsc');
    expect(dockerConfigSchema.safeParse({ memory: 'lots' }).success).toBe(false);
    expect(dockerConfigSchema.safeParse({ runtime: 'kata' }).success).toBe(false);
  });
});
