/**
 * The connectors API layer (./connectors.ts): how a refusal reaches the app — the server's
 * sentence, plus what went wrong (`code`) and the provider's raw answer (`detail`) where the
 * server tells them apart, so src/connectors/use-connectors.ts can word it and keep the raw
 * text behind 详情. Root vitest unit project; `api()` is faked, so no React Native loads.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
vi.mock('./client', () => ({ api: (path: string, init?: RequestInit) => apiMock(path, init) }));

import { saveConnectorKey, testConnector } from './connectors';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => apiMock.mockReset());

describe('a refused key', () => {
  it('carries the code and the provider answer apart from the sentence', async () => {
    apiMock.mockResolvedValueOnce(
      json(400, {
        error: 'Maps did not accept this key: {"status":"0"}',
        code: 'key_rejected',
        detail: '{"status":"0"}',
      }),
    );
    expect(await saveConnectorKey(7, 'k')).toEqual({
      ok: false,
      message: 'Maps did not accept this key: {"status":"0"}',
      code: 'key_rejected',
      detail: '{"status":"0"}',
    });
    expect(apiMock).toHaveBeenCalledWith('/api/connectors/7/key', expect.objectContaining({ method: 'PUT' }));
  });

  it('an older server (a sentence only) still reads as a plain failure', async () => {
    apiMock.mockResolvedValueOnce(json(400, { error: 'Maps did not accept this key: nope' }));
    expect(await saveConnectorKey(7, 'k')).toEqual({ ok: false, message: 'Maps did not accept this key: nope' });
    apiMock.mockResolvedValueOnce(json(502, {}));
    expect(await saveConnectorKey(7, 'k')).toEqual({ ok: false, message: 'HTTP 502' });
  });
});

describe('a test of the connection', () => {
  it('the tool count, or the status as the code and the reason as the detail', async () => {
    apiMock.mockResolvedValueOnce(json(200, { ok: true, tool_count: 3, error: null }));
    expect(await testConnector(1)).toEqual({ ok: true, value: 3 });

    apiMock.mockResolvedValueOnce(json(200, { ok: false, status: 'expired', error: 'sign-in no longer valid' }));
    expect(await testConnector(1)).toEqual({
      ok: false,
      message: 'sign-in no longer valid',
      code: 'expired',
      detail: 'sign-in no longer valid',
    });
  });
});
