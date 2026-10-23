import { afterEach, describe, expect, it } from 'vitest';
import { apiUrl, apiWebSocketUrl, getApiBaseUrl, publicAssetUrl, shouldUseApiBase } from './api-base.js';

/**
 * The web bundle is same-origin by default; a split-hosting deployment sets a
 * build-time API base (`__GREENHOUSE_API_BASE_URL__`, a Vite define). These tests
 * run in node, so the define, `window` and `location` are stubbed on globalThis
 * rather than mocked out of a real DOM.
 */
function asSplitHosted(base: string) {
  (globalThis as { __GREENHOUSE_API_BASE_URL__?: string }).__GREENHOUSE_API_BASE_URL__ = base;
}

function asBrowser() {
  (globalThis as { window?: unknown }).window = {};
  (globalThis as { location?: unknown }).location = {
    hostname: 'localhost',
    protocol: 'http:',
    host: 'localhost:3100',
  };
}

afterEach(() => {
  delete (globalThis as { __GREENHOUSE_API_BASE_URL__?: string }).__GREENHOUSE_API_BASE_URL__;
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

describe('split-hosting api base', () => {
  it('uses the build-time base', () => {
    asSplitHosted('https://greenhouse.example.com:18888');
    expect(getApiBaseUrl()).toBe('https://greenhouse.example.com:18888');
    expect(apiUrl('/api/chat')).toBe('https://greenhouse.example.com:18888/api/chat');
  });

  it('strips trailing slashes so paths never double up', () => {
    asSplitHosted('https://greenhouse.example.com:18888///');
    expect(apiUrl('/api/chat')).toBe('https://greenhouse.example.com:18888/api/chat');
  });

  it('rewrites /public so runtime assets hit the API, not the app bundle', () => {
    asSplitHosted('https://greenhouse.example.com:18888');
    expect(publicAssetUrl('logo.svg')).toBe('https://greenhouse.example.com:18888/public/logo.svg');
    expect(publicAssetUrl('/public/uploads/a.png')).toBe('https://greenhouse.example.com:18888/public/uploads/a.png');
  });

  it('leaves absolute and protocol-relative URLs alone even with a base', () => {
    asSplitHosted('https://greenhouse.example.com:18888');
    expect(apiUrl('https://example.com/api/x')).toBe('https://example.com/api/x');
    expect(apiUrl('//example.com/api/x')).toBe('//example.com/api/x');
  });

  it('derives the websocket URL from the base', () => {
    asSplitHosted('https://greenhouse.example.com:18888');
    expect(apiWebSocketUrl('/api/ws')).toBe('wss://greenhouse.example.com:18888/api/ws');
  });
});
