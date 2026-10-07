/**
 * /api/bots/computer routes over mocked computer modules: the error shape
 * (`{ error, code }`, `reason: 'host_disk'` when `over_quota` is the Docker
 * host's disk rather than the member's home — the page must not tell the
 * member to clear their Downloads for that), and the wiring, validation and
 * error mapping of the settings, ticket, window, files and processes routes.
 */

import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ComputerDockerError } from '../docker.js';
import { ComputerUnavailableError } from '../errors.js';

const mocks = vi.hoisted(() => ({
  ensureRunning: vi.fn(),
  computerNamespace: vi.fn((): string | null => 'ns1'),
  setTimezone: vi.fn(async () => ({})),
  restoreBrowserWindow: vi.fn(async () => {}),
  takeoverComputer: vi.fn(async () => {}),
  listComputerFiles: vi.fn(),
  openComputerDownload: vi.fn(),
  uploadComputerFile: vi.fn(),
  listJobs: vi.fn(),
  jobLog: vi.fn(),
  stopJob: vi.fn(),
}));

vi.mock('@greenhouse/db', () => ({
  getDb: () => ({
    botComputers: { setTimezone: mocks.setTimezone, get: async () => undefined },
    users: { getById: async (id: string) => ({ id, auth_version: 4 }) },
  }),
}));
vi.mock('../runtime.js', () => ({
  requireComputerRuntime: () => ({ controller: { ensureRunning: mocks.ensureRunning }, config: { namespace: 'ns1' } }),
  computerStatusFor: vi.fn(async () => ({ state: 'running', timezone: null, lang: 'zh-CN' })),
  computerNamespace: mocks.computerNamespace,
  adminComputersView: vi.fn(),
  purgeUserComputer: vi.fn(),
  stopUserComputer: vi.fn(),
}));
vi.mock('../access.js', () => ({
  captureDesktop: vi.fn(),
  restoreBrowserWindow: mocks.restoreBrowserWindow,
  redactFilledSecrets: (_userId: string, text: string) => text.replaceAll('hunter2', '••••••'),
  containerFailed: vi.fn(),
  touchComputer: vi.fn(),
}));
vi.mock('../lease.js', () => ({
  LeaseRequiredError: class LeaseRequiredError extends Error {},
  takeoverComputer: mocks.takeoverComputer,
  handbackComputer: vi.fn(),
  typeIntoFocusedField: vi.fn(),
}));
vi.mock('../jobs.js', () => ({ listJobs: mocks.listJobs, jobLog: mocks.jobLog, stopJob: mocks.stopJob }));
vi.mock('../files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../files.js')>()),
  listComputerFiles: mocks.listComputerFiles,
  openComputerDownload: mocks.openComputerDownload,
  uploadComputerFile: mocks.uploadComputerFile,
}));

const { createBotsComputerRoutes } = await import('../routes.js');
const { ComputerFileError } = await import('../files.js');
const { TERMINAL_TOKEN_PURPOSE, verifyViewToken } = await import('../view-token.js');

beforeAll(() => {
  process.env.TOKEN_SIGNING_KEY ??= randomBytes(32).toString('hex');
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
});

function app() {
  return new Hono()
    .use('*', async (c, next) => {
      c.set('user' as never, { id: 'u1', role: 'team' } as never);
      await next();
    })
    .route('/', createBotsComputerRoutes());
}

const json = (body: unknown) => ({
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});

describe('computer route errors', () => {
  it('marks a full Docker disk as reason host_disk, and leaves the member’s own over-quota alone', async () => {
    mocks.ensureRunning.mockRejectedValueOnce(
      new ComputerUnavailableError('over_quota', 'The server is almost out of disk space.', 'host_disk'),
    );
    const host = await app().request('/start', { method: 'POST' });
    expect(host.status).toBe(409);
    expect(await host.json()).toEqual({
      error: 'The server is almost out of disk space.',
      code: 'over_quota',
      reason: 'host_disk',
    });

    mocks.ensureRunning.mockRejectedValueOnce(
      new ComputerUnavailableError('over_quota', 'The computer is out of disk space.'),
    );
    const member = await app().request('/start', { method: 'POST' });
    expect(await member.json()).toEqual({ error: 'The computer is out of disk space.', code: 'over_quota' });
  });
});

describe('PUT /settings', () => {
  it('stores an IANA timezone on the member’s row (created on first use) and answers the status', async () => {
    const res = await app().request('/settings', { method: 'PUT', ...json({ timezone: 'Asia/Shanghai' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'running', lang: 'zh-CN' });
    expect(mocks.setTimezone).toHaveBeenCalledWith(
      {
        user_id: 'u1',
        namespace: 'ns1',
        container_name: 'gh-computer-ns1-u1',
        volume_name: 'gh-computer-ns1-u1-home',
      },
      'Asia/Shanghai',
    );
    await app().request('/settings', { method: 'PUT', ...json({ timezone: null }) });
    expect(mocks.setTimezone).toHaveBeenLastCalledWith(expect.anything(), null);
  });

  it('refuses what is not a zone, malformed bodies, and computers that are off', async () => {
    for (const body of [
      { timezone: 'Mars/Base' },
      { timezone: '+08:00' },
      { timezone: 8 },
      {},
      { timezone: 'UTC', x: 1 },
    ]) {
      const res = await app().request('/settings', { method: 'PUT', ...json(body) });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).code).toBe('invalid');
    }
    mocks.computerNamespace.mockReturnValueOnce(null);
    const off = await app().request('/settings', { method: 'PUT', ...json({ timezone: 'UTC' }) });
    expect(off.status).toBe(503);
    expect((await off.json()).code).toBe('disabled');
    expect(mocks.setTimezone).not.toHaveBeenCalled();
  });
});

describe('socket tickets', () => {
  it('issues terminal tickets that open only the terminal, and viewer tickets that open only the viewer', async () => {
    const terminal = (await (await app().request('/terminal-token', { method: 'POST' })).json()) as { token: string };
    const viewer = (await (await app().request('/view-token', { method: 'POST' })).json()) as { token: string };
    expect(verifyViewToken(terminal.token, { consume: false })).toBeNull();
    expect(verifyViewToken(viewer.token, { consume: false, purpose: TERMINAL_TOKEN_PURPOSE })).toBeNull();
    expect(verifyViewToken(terminal.token, { purpose: TERMINAL_TOKEN_PURPOSE })).toMatchObject({
      uid: 'u1',
      av: 4,
      c: 'gh-computer-ns1-u1',
    });
    expect(verifyViewToken(viewer.token)).toMatchObject({ uid: 'u1', c: 'gh-computer-ns1-u1' });
  });
});

describe('window and take-over', () => {
  it('restores the browser window, and says stopped when the computer is not running', async () => {
    const ok = await app().request('/restore-window', { method: 'POST' });
    expect(await ok.json()).toEqual({ ok: true });
    expect(mocks.restoreBrowserWindow).toHaveBeenCalledWith('u1');
    mocks.restoreBrowserWindow.mockRejectedValueOnce(
      new ComputerUnavailableError('stopped', 'The computer is not running'),
    );
    const stopped = await app().request('/restore-window', { method: 'POST' });
    expect(stopped.status).toBe(409);
    expect((await stopped.json()).code).toBe('stopped');
  });

  it('answers a failed take-over with the computer error', async () => {
    mocks.takeoverComputer.mockRejectedValueOnce(new ComputerUnavailableError('busy', 'All computers are busy'));
    const busy = await app().request('/takeover', { method: 'POST' });
    expect(busy.status).toBe(503);
  });
});

describe('files', () => {
  it('lists a folder, mapping the member’s mistakes to 400 / 404 and a stopped computer to 409', async () => {
    const list = { path: '/home/agent/work', entries: [], truncated: false };
    mocks.listComputerFiles.mockResolvedValueOnce(list);
    const res = await app().request('/files?path=~/work');
    expect(await res.json()).toEqual(list);
    expect(mocks.listComputerFiles).toHaveBeenCalledWith('u1', '~/work');

    const cases: Array<[unknown, number, string]> = [
      [new ComputerFileError('not_found', 'No such file or folder'), 404, 'not_found'],
      [new ComputerFileError('invalid', 'Only files inside /home/agent are reachable'), 400, 'invalid'],
      [new ComputerUnavailableError('stopped', 'The computer stopped unexpectedly'), 409, 'stopped'],
      [new ComputerDockerError('failed', 'exec failed'), 503, 'unavailable'],
    ];
    for (const [err, status, code] of cases) {
      mocks.listComputerFiles.mockRejectedValueOnce(err);
      const failed = await app().request('/files?path=x');
      expect(failed.status).toBe(status);
      expect((await failed.json()).code).toBe(code);
    }
  });

  it('downloads as an attachment that is never cached nor sniffed', async () => {
    mocks.openComputerDownload.mockResolvedValueOnce({
      name: '季度报告.pdf',
      size: 5,
      stream: new Blob(['%PDF-']).stream(),
    });
    const res = await app().request('/files/download?path=~/Downloads/季度报告.pdf');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-');
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'application/pdf',
      'content-length': '5',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="____.pdf"; filename*=UTF-8''${encodeURIComponent('季度报告.pdf')}`,
    });
    expect(mocks.openComputerDownload).toHaveBeenCalledWith('u1', '~/Downloads/季度报告.pdf');

    // Active content never goes out under its own type.
    mocks.openComputerDownload.mockResolvedValueOnce({ name: 'page.html', size: 0, stream: new Blob([]).stream() });
    const html = await app().request('/files/download?path=page.html');
    expect(html.headers.get('content-type')).toBe('application/octet-stream');

    expect((await app().request('/files/download')).status).toBe(400); // a path is required
  });

  it('streams an upload into the computer with its declared size, and refuses an oversized one unread', async () => {
    mocks.uploadComputerFile.mockImplementationOnce(
      async (_userId: string, input: { body: Readable; size: number; name: string; dir?: string }) => {
        const chunks: Buffer[] = [];
        for await (const chunk of input.body) chunks.push(Buffer.from(chunk as Uint8Array));
        return {
          entry: { name: input.name, type: 'file', size: input.size, mtime: '2026-10-07T00:00:00.000Z' },
          path: `/home/agent/work/${input.name}`,
          received: Buffer.concat(chunks).toString(),
        };
      },
    );
    const res = await app().request('/files/upload?dir=~/work&name=notes.txt', {
      method: 'POST',
      body: 'hello',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '5' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: '/home/agent/work/notes.txt', received: 'hello' });
    expect(mocks.uploadComputerFile).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ dir: '~/work', name: 'notes.txt', size: 5 }),
    );

    const big = await app().request('/files/upload?name=big.bin', {
      method: 'POST',
      body: 'x',
      headers: { 'Content-Length': String(100 * 1024 ** 2 + 1) },
    });
    expect(big.status).toBe(413);
    expect((await big.json()).code).toBe('too_large');
    expect((await app().request('/files/upload', { method: 'POST', body: 'x' })).status).toBe(400); // no name
    expect(mocks.uploadComputerFile).toHaveBeenCalledTimes(1);
  });
});

describe('processes', () => {
  it('lists jobs, reads a redacted log tail, stops one, and 404s an unknown id', async () => {
    mocks.listJobs.mockResolvedValueOnce([{ id: 'j00000001', name: 'train', status: 'running' }]);
    expect(await (await app().request('/processes')).json()).toEqual({
      processes: [{ id: 'j00000001', name: 'train', status: 'running' }],
    });

    mocks.jobLog.mockResolvedValueOnce({ id: 'j00000001', text: 'login with hunter2\n', truncated: false });
    const log = await app().request('/processes/j00000001/log?lines=50');
    expect(await log.json()).toEqual({ id: 'j00000001', text: 'login with ••••••\n', truncated: false });
    expect(mocks.jobLog).toHaveBeenCalledWith('u1', 'j00000001', { lines: 50 });
    expect((await app().request('/processes/j00000001/log?lines=lots')).status).toBe(400);

    mocks.stopJob.mockResolvedValueOnce({ id: 'j00000001', stopped: true });
    expect(await (await app().request('/processes/j00000001/stop', { method: 'POST' })).json()).toEqual({
      id: 'j00000001',
      stopped: true,
    });

    mocks.stopJob.mockRejectedValueOnce(new ComputerDockerError('not_found', 'No such job'));
    const missing = await app().request('/processes/j00000002/stop', { method: 'POST' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'No such job', code: 'not_found' });

    mocks.jobLog.mockRejectedValueOnce(new ComputerUnavailableError('stopped', 'The computer is not running'));
    expect((await app().request('/processes/j00000001/log')).status).toBe(409);
  });
});
