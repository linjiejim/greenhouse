import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ api: vi.fn(), station: 'station-a' }));
vi.mock('../api/client', () => ({ api: state.api }));
vi.mock('../api/token-storage', () => ({ getTokenStationId: () => state.station }));
import { fileNameFrom } from './file-download';
import { downloadFile } from './share-file.web';
afterEach(() => {
  state.station = 'station-a';
  vi.restoreAllMocks();
});
it('decodes UTF-8 file names and falls back on a malformed disposition', () => {
  expect(fileNameFrom("attachment; filename*=UTF-8''%E6%94%BF%E7%AD%96.md", 'download')).toBe('政策.md');
  expect(fileNameFrom("attachment; filename*=UTF-8''%zz; filename=notes.txt", 'download')).toBe('notes.txt');
});
it('downloads authenticated bytes into a disposable browser preview', async () => {
  state.api.mockResolvedValue(
    new Response('policy text', {
      headers: { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename=policy.txt' },
    }),
  );
  const file = await downloadFile('/api/drive/files/7/content');
  expect(state.api).toHaveBeenCalledWith('/api/drive/files/7/content', { signal: undefined });
  expect(file.name).toBe('policy.txt');
  expect(file.previewText).toBe('policy text');
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  file.dispose();
  expect(revoke).toHaveBeenCalledWith(file.uri);
});
it('drops a late download after the active station changes', async () => {
  state.api.mockImplementation(async () => {
    state.station = 'station-b';
    return new Response('private bytes');
  });
  await expect(downloadFile('/api/drive/files/7/content')).rejects.toThrow('download_cancelled');
});
it('retains an HTTP access refusal for the existing file error state', async () => {
  state.api.mockResolvedValue(new Response('', { status: 403 }));
  await expect(downloadFile('/api/drive/files/7/content')).rejects.toMatchObject({ status: 403 });
});
