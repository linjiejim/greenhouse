/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installApiUrls, resolveApiUrl } from '../urls';

const BASE = 'https://gh.example.com';

describe('resolveApiUrl', () => {
  it('makes API paths absolute against the server', () => {
    expect(resolveApiUrl('/api/files/f1/content?sig=x', BASE)).toBe(`${BASE}/api/files/f1/content?sig=x`);
    expect(resolveApiUrl('/api', BASE)).toBe(`${BASE}/api`);
    expect(resolveApiUrl('/public/logo.png', BASE)).toBe(`${BASE}/public/logo.png`);
    expect(resolveApiUrl('/health', BASE)).toBe(`${BASE}/health`);
  });

  it('leaves app routes, assets and other sites alone', () => {
    for (const url of [
      '#/c/main',
      '/assets/app.js',
      '/apiary',
      '/favicon.svg',
      'https://x.example/api/a',
      'blob:x',
      '',
    ])
      expect(resolveApiUrl(url, BASE)).toBe(url);
  });

  it('does nothing without a server, as in a browser', () => {
    expect(resolveApiUrl('/api/files/f1', '')).toBe('/api/files/f1');
  });

  it('moves URLs the page already resolved against its own origin', () => {
    expect(resolveApiUrl('greenhouse://localhost/api/me', BASE, 'greenhouse://localhost')).toBe(`${BASE}/api/me`);
    expect(resolveApiUrl('greenhouse://localhost/assets/a.js', BASE, 'greenhouse://localhost')).toBe(
      'greenhouse://localhost/assets/a.js',
    );
  });
});

describe('installApiUrls', () => {
  let undo = () => undefined as void;
  afterEach(() => {
    undo();
    document.body.innerHTML = '';
  });

  it('rewrites src, href and poster as elements arrive or change', async () => {
    document.body.innerHTML = '<img id="early" src="/api/files/a/content">';
    undo = installApiUrls(BASE);
    expect(document.getElementById('early')!.getAttribute('src')).toBe(`${BASE}/api/files/a/content`);

    const wrapper = document.createElement('div');
    wrapper.innerHTML =
      '<a href="/api/files/b/content">b</a><a href="#/knowledge">k</a><video poster="/api/files/c"></video>';
    document.body.append(wrapper);
    const img = document.createElement('img');
    document.body.append(img);
    img.setAttribute('src', '/api/files/d/content');
    await Promise.resolve();

    const [file, route] = wrapper.querySelectorAll('a');
    expect(file!.getAttribute('href')).toBe(`${BASE}/api/files/b/content`);
    expect(route!.getAttribute('href')).toBe('#/knowledge');
    expect(wrapper.querySelector('video')!.getAttribute('poster')).toBe(`${BASE}/api/files/c`);
    expect(img.getAttribute('src')).toBe(`${BASE}/api/files/d/content`);
  });

  it('sends relative API fetches to the server and restores fetch when undone', async () => {
    const original = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok'));
    window.fetch = original;
    undo = installApiUrls(BASE);
    await window.fetch('/api/files/a/content');
    await window.fetch('https://other.example/x');
    expect(original.mock.calls.map(([input]) => String(input))).toEqual([
      `${BASE}/api/files/a/content`,
      'https://other.example/x',
    ]);
    undo();
    expect(window.fetch).toBe(original);
  });
});
