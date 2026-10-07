/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postWithProgress } from './upload-progress';

const auth = vi.hoisted(() => ({ token: 'access-1' as string | null }));
vi.mock('./auth', () => ({ getStoredToken: () => auth.token }));

class FakeXhr {
  static last: FakeXhr | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  responseType = '';
  status = 0;
  statusText = '';
  response: unknown = null;
  aborted = false;
  responseHeaders = '';
  upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getAllResponseHeaders() {
    return this.responseHeaders;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  /** The server answered. */
  respond(status: number, json: unknown, headers = 'content-type: application/json\r\n') {
    this.status = status;
    this.response = new Blob([JSON.stringify(json)], { type: 'application/json' });
    this.responseHeaders = headers;
    this.onload?.();
  }
}

beforeEach(() => {
  auth.token = 'access-1';
  FakeXhr.last = null;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postWithProgress', () => {
  it('posts the body with the stored token and reports bytes sent', async () => {
    const onProgress = vi.fn();
    const body = new Blob(['hello world']);
    const pending = postWithProgress('/api/bots/computer/files/upload?dir=%7E&name=a.txt', body, {
      headers: { 'Content-Type': 'application/octet-stream' },
      onProgress,
    });
    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/bots/computer/files/upload?dir=%7E&name=a.txt');
    expect(xhr.headers).toEqual({ Authorization: 'Bearer access-1', 'Content-Type': 'application/octet-stream' });
    expect(xhr.body).toBe(body);

    xhr.upload.onprogress?.({ loaded: 5, total: 11, lengthComputable: true });
    expect(onProgress).toHaveBeenCalledWith(5, 11);
    // A length the browser cannot compute falls back to the body's size.
    xhr.upload.onprogress?.({ loaded: 7, total: 0, lengthComputable: false });
    expect(onProgress).toHaveBeenLastCalledWith(7, 11);

    xhr.respond(200, { path: '/home/agent/a.txt' });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ path: '/home/agent/a.txt' });
  });

  it('hands back an error status as a response, for the caller to read', async () => {
    const pending = postWithProgress('/api/x', new Blob(['x']));
    FakeXhr.last!.respond(413, { error: 'Files up to 100 MiB can be uploaded', code: 'too_large' });
    const res = await pending;
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'too_large' });
  });

  it('sends no Authorization header without a token', () => {
    auth.token = null;
    void postWithProgress('/api/x', new Blob(['x']));
    expect(FakeXhr.last!.headers.Authorization).toBeUndefined();
  });

  it('rejects on a network failure and on abort', async () => {
    const failed = postWithProgress('/api/x', new Blob(['x']));
    FakeXhr.last!.onerror?.();
    await expect(failed).rejects.toThrow('Network request failed');

    const controller = new AbortController();
    const aborted = postWithProgress('/api/x', new Blob(['x']), { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXhr.last!.aborted).toBe(true);

    await expect(postWithProgress('/api/x', new Blob(['x']), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
