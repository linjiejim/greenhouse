/**
 * The member's Files tab (files.ts) against a fake Docker: path confinement
 * to /home/agent (on the string here; the scripts re-check the real path in
 * the container), upload naming, the listing parser, and the transfers —
 * argv only (never a script built from a path), exact-size streaming
 * downloads, and failures mapped to what the member can act on.
 */

import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { ComputerDockerError, type DockerSpawnResult, type ExecSpec } from '../docker.js';
import type { ComputerExec, ComputerProcess } from '../host.js';
import {
  ComputerFileError,
  DOWNLOAD_SCRIPT,
  LIST_SCRIPT,
  listComputerFiles,
  openComputerDownload,
  parseListing,
  resolveMemberPath,
  splitFileName,
  UPLOAD_MAX_BYTES,
  UPLOAD_SCRIPT,
  uploadComputerFile,
  uploadFileName,
  type FilesDeps,
} from '../files.js';

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

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit('close', null));
    return true;
  });
  return child;
}

/** Ends the fake process the way a real one ends: stdio first, then `close`. */
function exitChild(child: FakeChild, code: number): void {
  child.stdout.end();
  child.stderr.end();
  child.stdout.once('end', () => child.emit('close', code));
  child.stdout.resume();
}

function deps(exec: (spec: ExecSpec) => Partial<DockerSpawnResult>, stream?: () => FakeChild) {
  const calls: ExecSpec[] = [];
  const streams: Array<{ argv: string[]; opts: unknown }> = [];
  const failed = vi.fn(async (_userId: string, err: unknown): Promise<never> => {
    throw err;
  });
  const touch = vi.fn(async () => {});
  const container = vi.fn(async () => 'gh-computer-x');
  const host = {
    exec: vi.fn(async (spec: ExecSpec) => {
      calls.push(spec);
      return result(exec(spec));
    }),
    execStream: vi.fn((_c: string, _u: string, argv: string[], opts: unknown) => {
      streams.push({ argv, opts });
      return stream!() as unknown as ComputerProcess;
    }),
  } as unknown as Pick<ComputerExec, 'exec' | 'execStream'>;
  const value: FilesDeps = { host: () => host, container, touch, failed };
  return { deps: value, calls, streams, failed, touch, container };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

describe('member paths', () => {
  it('resolves like the computer tool and stays inside /home/agent', () => {
    expect(resolveMemberPath(undefined)).toBe('/home/agent/work');
    expect(resolveMemberPath('  ')).toBe('/home/agent/work');
    expect(resolveMemberPath('~')).toBe('/home/agent');
    expect(resolveMemberPath('~/Downloads')).toBe('/home/agent/Downloads');
    expect(resolveMemberPath('report/q3.pdf')).toBe('/home/agent/work/report/q3.pdf');
    expect(resolveMemberPath('/home/agent/work/../Downloads')).toBe('/home/agent/Downloads');
    for (const outside of ['/etc/passwd', '~/../browser/chromium', '../../browser', '/home/agentx', '/home', '/']) {
      expect(() => resolveMemberPath(outside), outside).toThrow(ComputerFileError);
    }
    for (const bad of ['a\nb', 'tab\there', 'nul\0', 'x'.repeat(4097)]) {
      expect(() => resolveMemberPath(bad)).toThrow(expect.objectContaining({ code: 'invalid' }));
    }
    expect(() => resolveMemberPath('', '')).toThrow(ComputerFileError); // a download needs a path
  });

  it('names uploads with the shared hygiene, keeping the extension and CJK', () => {
    expect(splitFileName('report.final.pdf')).toEqual({ base: 'report.final', ext: '.pdf' });
    expect(splitFileName('.env')).toEqual({ base: '.env', ext: '' });
    expect(splitFileName('Makefile')).toEqual({ base: 'Makefile', ext: '' });
    expect(splitFileName('trailing.')).toEqual({ base: 'trailing.', ext: '' });
    expect(uploadFileName('../../etc/passwd')).toEqual({ base: 'passwd', ext: '' });
    expect(uploadFileName('C:\\Users\\jim\\季度报告.xlsx')).toEqual({ base: '季度报告', ext: '.xlsx' });
    expect(uploadFileName('a$b;rm -rf.txt')).toEqual({ base: 'a_b_rm -rf', ext: '.txt' });
    expect(uploadFileName('..')).toBeNull();
    expect(uploadFileName('')).toBeNull();
    // 110 CJK characters = 330 bytes: shortened to fit the file system, extension kept.
    const long = uploadFileName(`${'报'.repeat(110)}.pdf`)!;
    expect(long.ext).toBe('.pdf');
    expect(Buffer.byteLength(long.base + long.ext)).toBeLessThanOrEqual(200);
  });
});

describe('listing', () => {
  it('parses NUL-terminated records (tabs and newlines in names), hides in-flight uploads, caps the count', () => {
    const out = Buffer.from(
      [
        '/home/agent/work',
        'd\t4096\t1791313909.88\tsub',
        'f\t5\t1791313909.5\ta.txt',
        'l\t11\t1791313909\tpasswd-link',
        'f\t1\t1791313909\ttab\tand\nnewline',
        'p\t0\t1791313909\tfifo',
        'f\t0\t1791313909\t.gh-upload.Ab12Cd34',
        '',
      ].join('\0'),
    );
    const list = parseListing(out);
    expect(list.path).toBe('/home/agent/work');
    expect(list.truncated).toBe(false);
    expect(list.entries).toEqual([
      { name: 'sub', type: 'dir', size: 0, mtime: new Date(1791313909880).toISOString() },
      { name: 'a.txt', type: 'file', size: 5, mtime: new Date(1791313909500).toISOString() },
      { name: 'passwd-link', type: 'link', size: 11, mtime: new Date(1791313909000).toISOString() },
      { name: 'tab\tand\nnewline', type: 'file', size: 1, mtime: new Date(1791313909000).toISOString() },
      { name: 'fifo', type: 'other', size: 0, mtime: new Date(1791313909000).toISOString() },
    ]);
    const capped = parseListing(out, 2);
    expect(capped.entries.map((e) => e.name)).toEqual(['sub', 'a.txt']);
    expect(capped.truncated).toBe(true);
    expect(parseListing(Buffer.from('/home/agent\0garbage\0')).entries).toEqual([]);
  });

  it('lists as uid agent with the path as an argument, never inside the script', async () => {
    const { deps: d, calls, container, touch } = deps(() => ({ stdout: Buffer.from('/home/agent/work\0') }));
    expect(await listComputerFiles('u1', '"; rm -rf ~; "', d)).toEqual({
      path: '/home/agent/work',
      entries: [],
      truncated: false,
    });
    expect(container).toHaveBeenCalledWith('u1');
    expect(calls[0]).toMatchObject({
      container: 'gh-computer-x',
      user: 'agent',
      argv: ['sh', '-c', LIST_SCRIPT, 'gh-ls', '/home/agent/work/"; rm -rf ~; "', '500'],
    });
    expect(LIST_SCRIPT).not.toContain('rm -rf');
    expect(touch).toHaveBeenCalledWith('u1');
  });

  it('maps the script’s exits to what the member can act on, and docker failures to the container path', async () => {
    const run = (code: number, stderr: string) => listComputerFiles('u1', '~/x', deps(() => ({ code, stderr })).deps);
    await expect(run(3, 'No such file or folder')).rejects.toMatchObject({
      name: 'ComputerFileError',
      code: 'not_found',
    });
    await expect(run(5, 'That leads outside /home/agent')).rejects.toMatchObject({ code: 'invalid' });
    await expect(run(4, 'Not a folder')).rejects.toMatchObject({ code: 'invalid' });
    const broken = deps(() => ({ code: 125, stderr: 'OCI runtime exec failed' }));
    await expect(listComputerFiles('u1', undefined, broken.deps)).rejects.toBeInstanceOf(ComputerDockerError);
    expect(broken.failed).toHaveBeenCalledTimes(1); // a vanished container is marked through here
    // Refused on the string: the computer is never started for it.
    const outside = deps(() => ({}));
    await expect(listComputerFiles('u1', '/etc', outside.deps)).rejects.toMatchObject({ code: 'invalid' });
    expect(outside.container).not.toHaveBeenCalled();
  });
});

describe('download', () => {
  it('streams exactly the announced size, as uid agent, and lets the process go', async () => {
    const child = fakeChild();
    const { deps: d, streams } = deps(
      () => ({}),
      () => child,
    );
    const opening = openComputerDownload('u1', '~/Downloads/季度报告.pdf', d);
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    child.stdout.write('11\nhello');
    child.stdout.write(' world and more'); // never more than announced
    const download = await opening;
    expect(download).toMatchObject({ name: '季度报告.pdf', size: 11 });
    expect(streams[0]).toEqual({
      argv: ['sh', '-c', DOWNLOAD_SCRIPT, 'gh-download', '/home/agent/Downloads/季度报告.pdf', String(1024 ** 3)],
      opts: { cwd: '/home/agent', env: { HOME: '/home/agent', USER: 'agent', LOGNAME: 'agent' } },
    });
    expect((await readAll(download.stream)).toString()).toBe('hello world');
    expect(child.kill).toHaveBeenCalled();
  });

  it('fails a file that ends early instead of handing out a truncated copy', async () => {
    const child = fakeChild();
    const { deps: d } = deps(
      () => ({}),
      () => child,
    );
    const opening = openComputerDownload('u1', 'big.bin', d);
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0));
    child.stdout.write('10\nabc');
    const download = await opening;
    const reading = readAll(download.stream);
    exitChild(child, 0);
    await expect(reading).rejects.toThrow(/ended after 3 of 10 bytes/);
  });

  it('turns a refusal into the member’s error and kills nothing it did not start', async () => {
    const child = fakeChild();
    const { deps: d } = deps(
      () => ({}),
      () => child,
    );
    const opening = openComputerDownload('u1', 'missing.txt', d);
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0));
    child.stderr.write('No such file or folder\n');
    exitChild(child, 3);
    await expect(opening).rejects.toMatchObject({ name: 'ComputerFileError', code: 'not_found' });

    await expect(openComputerDownload('u1', '/home/browser/Cookies', d)).rejects.toMatchObject({ code: 'invalid' });
    await expect(openComputerDownload('u1', '~', d)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('stops the transfer when the client goes away', async () => {
    const child = fakeChild();
    const { deps: d } = deps(
      () => ({}),
      () => child,
    );
    const opening = openComputerDownload('u1', 'video.mp4', d);
    await vi.waitFor(() => expect(child.listenerCount('close')).toBeGreaterThan(0));
    child.stdout.write('1000000\nfirst chunk');
    const download = await opening;
    await download.stream.cancel();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('upload', () => {
  it('streams the body into the container with the folder, the split name and the size as arguments', async () => {
    const body = Readable.from([Buffer.from('hello')]);
    const { deps: d, calls } = deps(() => ({ stdout: Buffer.from('5\t1791313909\tnotes (1).txt\n') }));
    const stored = await uploadComputerFile('u1', { dir: '~/work/in', name: 'notes.txt', body, size: 5 }, d);
    expect(stored).toEqual({
      entry: { name: 'notes (1).txt', type: 'file', size: 5, mtime: new Date(1791313909000).toISOString() },
      path: '/home/agent/work/in/notes (1).txt',
    });
    expect(calls[0]).toMatchObject({
      user: 'agent',
      argv: ['sh', '-c', UPLOAD_SCRIPT, 'gh-upload', '/home/agent/work/in', 'notes', '.txt', '5'],
      input: body,
    });
    // The upload script never overwrites and never keeps a partial file.
    expect(UPLOAD_SCRIPT).toContain('set -C');
    expect(UPLOAD_SCRIPT).toContain('mktemp -p "$r" .gh-upload.');
  });

  it('defaults to ~/work, and refuses before starting the computer when name, size or folder are wrong', async () => {
    const ok = deps(() => ({ stdout: Buffer.from('0\t1\tempty\n') }));
    await uploadComputerFile('u1', { name: 'empty', body: Buffer.alloc(0), size: 0 }, ok.deps);
    expect(ok.calls[0]!.argv.slice(4)).toEqual(['/home/agent/work', 'empty', '', '0']);

    const none = deps(() => ({}));
    const upload = (input: Partial<Parameters<typeof uploadComputerFile>[1]>) =>
      uploadComputerFile('u1', { name: 'a.txt', body: Buffer.alloc(0), size: 0, ...input }, none.deps);
    await expect(upload({ name: '..' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(upload({ dir: '/tmp' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(upload({ size: UPLOAD_MAX_BYTES + 1 })).rejects.toMatchObject({ code: 'too_large' });
    await expect(upload({ size: -1 })).rejects.toMatchObject({ code: 'invalid' });
    expect(none.container).not.toHaveBeenCalled();
  });

  it('reports a cut-off upload (the client left, or the script saw too few bytes) as incomplete', async () => {
    for (const reply of [
      { code: 8, stderr: 'The upload stopped after 3 of 5 bytes' },
      { code: null, signal: 'SIGKILL' as const },
    ]) {
      const { deps: d } = deps(() => reply);
      await expect(
        uploadComputerFile('u1', { name: 'a.txt', body: Buffer.from('hel'), size: 5 }, d),
      ).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/did not arrive complete/) });
    }
    const { deps: d } = deps(() => ({ code: 3, stderr: 'No such file or folder' }));
    await expect(
      uploadComputerFile('u1', { dir: '~/gone', name: 'a.txt', body: Buffer.from('x'), size: 1 }, d),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
