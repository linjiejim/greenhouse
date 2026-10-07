/** @vitest-environment happy-dom */

/**
 * The computer's binary transfers in the Bots client: an upload whose access
 * token expired goes again through authFetch (refresh, or sign in), and a
 * failed download reads the server's code like every other Bots call.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadComputerFile, isBotsApiError, uploadComputerFile } from './bots';

const transport = vi.hoisted(() => ({ postWithProgress: vi.fn(), authFetch: vi.fn(), saveBlobAs: vi.fn() }));
vi.mock('../upload-progress', () => ({ postWithProgress: transport.postWithProgress }));
vi.mock('../auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth')>()),
  authFetch: transport.authFetch,
}));
vi.mock('../file-download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../file-download')>()),
  saveBlobAs: transport.saveBlobAs,
}));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const UPLOADED = {
  entry: { name: 'report (1).pdf', type: 'file', size: 3, mtime: '2026-10-07T00:00:00.000Z' },
  path: '/home/agent/work/report (1).pdf',
};

beforeEach(() => {
  for (const fn of Object.values(transport)) fn.mockReset();
});

describe('uploadComputerFile', () => {
  it('posts the raw file to the folder, with progress, and returns what was written', async () => {
    transport.postWithProgress.mockResolvedValue(json(200, UPLOADED));
    const file = new File(['pdf'], 'report.pdf');
    const onProgress = vi.fn();
    await expect(uploadComputerFile('/home/agent/work', file, { onProgress })).resolves.toEqual(UPLOADED);
    expect(transport.postWithProgress).toHaveBeenCalledWith(
      '/api/bots/computer/files/upload?dir=%2Fhome%2Fagent%2Fwork&name=report.pdf',
      file,
      expect.objectContaining({ headers: { 'Content-Type': 'application/octet-stream' }, onProgress }),
    );
    expect(transport.authFetch).not.toHaveBeenCalled();
  });

  it('sends it again through authFetch when the access token had expired', async () => {
    transport.postWithProgress.mockResolvedValue(json(401, { error: 'Unauthorized' }));
    transport.authFetch.mockResolvedValue(json(200, UPLOADED));
    const file = new File(['pdf'], 'report.pdf');
    await expect(uploadComputerFile('~/work', file)).resolves.toEqual(UPLOADED);
    expect(transport.authFetch).toHaveBeenCalledWith(
      '/api/bots/computer/files/upload?dir=~%2Fwork&name=report.pdf',
      expect.objectContaining({ method: 'POST', body: file }),
    );
  });

  it('fails with the server code', async () => {
    transport.postWithProgress.mockResolvedValue(json(413, { error: 'Too large', code: 'too_large' }));
    const err = await uploadComputerFile('~/work', new File(['x'], 'big.iso')).catch((error: unknown) => error);
    expect(isBotsApiError(err, 'too_large')).toBe(true);
    expect(isBotsApiError(err) && err.status).toBe(413);
  });
});

describe('downloadComputerFile', () => {
  it('fetches the file with auth and hands it to the browser under its name', async () => {
    transport.authFetch.mockResolvedValue(new Response('bytes', { status: 200 }));
    await downloadComputerFile('/home/agent/work/a b.txt', 'a b.txt');
    expect(transport.authFetch).toHaveBeenCalledWith(
      '/api/bots/computer/files/download?path=%2Fhome%2Fagent%2Fwork%2Fa%20b.txt',
    );
    expect(transport.saveBlobAs).toHaveBeenCalledWith(expect.any(Blob), 'a b.txt');
  });

  it('fails with the server code and saves nothing', async () => {
    transport.authFetch.mockResolvedValue(json(404, { error: 'No such file', code: 'not_found' }));
    const err = await downloadComputerFile('/home/agent/gone.txt', 'gone.txt').catch((error: unknown) => error);
    expect(isBotsApiError(err, 'not_found')).toBe(true);
    expect(transport.saveBlobAs).not.toHaveBeenCalled();
  });
});
