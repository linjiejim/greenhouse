import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from './auth';
import { useAuthStore } from '../stores/auth-store';
import { _resetObjectRefCache, _readObjectRef, requestObjectRef } from './object-refs';

const fetchMock = vi.fn();
const URL_A = '#/knowledge/doc/12-plan';

const signIn = (id: string) => useAuthStore.getState().login({ id } as unknown as AuthenticatedUser);
const answer = (title: string) =>
  new Response(JSON.stringify({ items: [{ url: URL_A, type: 'doc', id: '12', title }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

beforeEach(() => {
  _resetObjectRefCache();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  useAuthStore.getState().logout();
  vi.unstubAllGlobals();
});

describe('object ref cache', () => {
  it("never shows one member's resolved titles to the next member in the same tab", async () => {
    signIn('usr_a');
    fetchMock.mockResolvedValueOnce(answer('A private plan'));
    requestObjectRef(URL_A);
    await tick();
    expect(_readObjectRef(URL_A)).toEqual({
      status: 'done',
      item: expect.objectContaining({ title: 'A private plan' }),
    });

    useAuthStore.getState().logout();
    signIn('usr_b');
    expect(_readObjectRef(URL_A)).toBeUndefined();

    fetchMock.mockResolvedValueOnce(answer('B view'));
    requestObjectRef(URL_A);
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(_readObjectRef(URL_A)).toEqual({ status: 'done', item: expect.objectContaining({ title: 'B view' }) });
  });

  it('drops an answer that was asked for by the previous member', async () => {
    signIn('usr_a');
    let release: (res: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)));
    requestObjectRef(URL_A);
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    useAuthStore.getState().logout();
    signIn('usr_b');
    release(answer('A private plan'));
    await tick();
    expect(_readObjectRef(URL_A)).toBeUndefined();
  });
});
