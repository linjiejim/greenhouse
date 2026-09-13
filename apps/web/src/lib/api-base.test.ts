import { afterEach, describe, expect, it } from 'vitest';
import { apiUrl, apiWebSocketUrl, getApiBaseUrl, publicAssetUrl, shouldUseApiBase } from './api-base.js';

/**
 * The web bundle is same-origin by default; a split-hosting deployment sets a
 * build-time API base. These tests run in node, so `location` is stubbed.
 */
function asBrowser() {
  (globalThis as { window?: unknown }).window = {};
  (globalThis as { location?: unknown }).location = {
    hostname: 'localhost',
    protocol: 'http:',
    host: 'localhost:3100',
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { location?: unknown }).location;
});

describe('api base resolution', () => {
  it('is same-origin in a browser', () => {
    asBrowser();
    expect(getApiBaseUrl()).toBe('');
    expect(apiUrl('/api/chat')).toBe('/api/chat');
    expect(publicAssetUrl('logo.svg')).toBe('/public/logo.svg');
  });

  it('claims only API-owned paths', () => {
    expect(shouldUseApiBase('/api/chat')).toBe(true);
    expect(shouldUseApiBase('/api')).toBe(true);
    expect(shouldUseApiBase('/public/uploads/a.png')).toBe(true);
    expect(shouldUseApiBase('/health')).toBe(true);
    expect(shouldUseApiBase('/assets/index.js')).toBe(false);
    expect(shouldUseApiBase('/apix')).toBe(false);
    expect(shouldUseApiBase('#/chat')).toBe(false);
  });

  it('leaves absolute and protocol-relative URLs alone', () => {
    expect(apiUrl('https://example.com/api/x')).toBe('https://example.com/api/x');
    expect(apiUrl('//cdn.example.com/a.png')).toBe('//cdn.example.com/a.png');
    expect(apiUrl('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
  });

  it('derives the websocket URL from the page origin when same-origin', () => {
    asBrowser();
    expect(apiWebSocketUrl('/api/ws')).toBe('ws://localhost:3100/api/ws');
  });
});
