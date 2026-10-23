/**
 * A Files upload (./drive.ts) across a station or account switch: every step — init, the bytes,
 * the COS `complete`, the next item of a batch — belongs to the identity it started on. Runs in
 * the ROOT vitest unit project with the client and the station registry mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = { base: 'https://a.example', identity: 'a' };
const calls: string[] = [];
let initAnswer: () => unknown;

vi.mock('../store/stations', () => ({ getApiBase: () => state.base }));
vi.mock('./token-storage', () => ({
  clearTokens: () => {},
  setTokens: () => {},
  getTokenStationId: () => state.identity,
  getAccessToken: () => `token-${state.identity}`,
  getRefreshToken: () => null,
}));
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  return {
    ...actual,
    post: async (path: string) => {
      calls.push(`POST ${state.base}${path}`);
      return { ok: true, data: initAnswer() };
    },
    api: async (path: string) => {
      calls.push(`POST ${state.base}${path}`);
      return new Response(JSON.stringify({ file: { id: 7 } }), { status: 200 });
    },
  };
});

const { IDENTITY_CHANGED, uploadBatch, uploadFile } = await import('./drive');

const target = { shelf: 'team' as const, folderId: null };
const source = (name: string) => ({ uri: `file:///${name}`, name, size: 3, type: 'image/png' });
const capture = () => {
  const started = state.identity;
  return () => state.identity === started;
};
const auth = () => `Bearer token-${state.identity}`;
const switchTo = (id: string) => {
  state.identity = id;
  state.base = `https://${id}.example`;
};

beforeEach(() => {
  state.base = 'https://a.example';
  state.identity = 'a';
  calls.length = 0;
  initAnswer = () => ({ file_id: 7, mode: 'cos', upload_url: 'https://cos.example/put' });
});

describe('a Files upload', () => {
  it('runs init → bytes → complete on one station', async () => {
    const put = vi.fn(async () => 200);
    const result = await uploadFile(target, source('a.png'), put, auth, capture());
    expect(result).toMatchObject({ ok: true });
    expect(calls).toEqual(['POST https://a.example/api/drive/files/init', 'POST https://a.example/api/drive/files/7/complete']);
  });

  it('does not complete on the station that became active while the bytes were sent', async () => {
    const put = vi.fn(async () => {
      switchTo('b');
      return 200;
    });
    const result = await uploadFile(target, source('a.png'), put, auth, capture());
    expect(result).toMatchObject({ ok: false, code: IDENTITY_CHANGED });
    expect(calls).toEqual(['POST https://a.example/api/drive/files/init']);
  });

  it('sends no bytes, and no token, after a switch during init', async () => {
    initAnswer = () => {
      switchTo('b');
      return { file_id: 7, mode: 'proxy', upload_url: '/api/drive/files/7/content' };
    };
    const put = vi.fn(async () => 200);
    const result = await uploadFile(target, source('a.png'), put, auth, capture());
    expect(result).toMatchObject({ ok: false, code: IDENTITY_CHANGED });
    expect(put).not.toHaveBeenCalled();
  });

  it('sends proxied bytes to the station it started on', async () => {
    initAnswer = () => ({ file_id: 7, mode: 'proxy', upload_url: '/api/drive/files/7/content' });
    const put = vi.fn(async () => 200);
    await uploadFile(target, source('a.png'), put, auth, capture());
    expect(put).toHaveBeenCalledWith('https://a.example/api/drive/files/7/content', 'file:///a.png', {
      'Content-Type': 'image/png',
      Authorization: 'Bearer token-a',
    });
  });

  it('stops a batch at a switch and skips the rest', async () => {
    let sent = 0;
    const put = vi.fn(async () => {
      sent += 1;
      if (sent === 2) switchTo('b');
      return 200;
    });
    const outcome = await uploadBatch(target, [source('1.png'), source('2.png'), source('3.png')], put, auth, capture());
    expect(outcome).toEqual({ done: 1, failed: 0, skipped: 2, stopped: true, error: '' });
    expect(put).toHaveBeenCalledTimes(2);
    expect(calls.filter((call) => call.startsWith('POST https://b.example'))).toEqual([]);
  });

  it('counts a refused item and goes on with the next', async () => {
    let sent = 0;
    const put = vi.fn(async () => (++sent === 1 ? 500 : 200));
    const outcome = await uploadBatch(target, [source('1.png'), source('2.png')], put, auth, capture());
    expect(outcome).toEqual({ done: 1, failed: 1, skipped: 0, stopped: false, error: '' });
  });
});
