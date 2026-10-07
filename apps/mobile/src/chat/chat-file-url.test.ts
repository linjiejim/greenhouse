/**
 * The chat-file guard (./chat-file-url.ts), pinned: every inline image and
 * file-card tap in a reply sends the member's bearer token to whatever URL
 * this lets through, and a file artifact's `download_url` is a tool output.
 */
import { describe, expect, it } from 'vitest';
import { chatFilePath, chatFileUrl } from './chat-file-url';

const BASE = 'https://green.example.com';

describe('chatFilePath', () => {
  it('accepts the exact chat-file route, trimmed', () => {
    expect(chatFilePath('/api/chat-files/cf_9-a/content')).toBe('/api/chat-files/cf_9-a/content');
    expect(chatFilePath('  /api/chat-files/cf_1/content\n')).toBe('/api/chat-files/cf_1/content');
  });

  it.each([
    ['an absolute third-party URL', 'https://evil.example/p.png'],
    ['an absolute URL on the station', 'https://green.example.com/api/chat-files/cf_1/content'],
    ['a protocol-relative URL', '//evil.example/api/chat-files/cf_1/content'],
    ['an @host path', '@evil.example/p.png'],
    ['a host-suffix path', '.evil.example/p'],
    ['a traversal', '/api/chat-files/../auth/me/content'],
    ['an encoded traversal', '/api/chat-files/%2e%2e/content'],
    ['a query', '/api/chat-files/cf_1/content?x=1'],
    ['a fragment', '/api/chat-files/cf_1/content#x'],
    ['another API route', '/api/upload/img_1'],
    ['a sub-path', '/api/chat-files/cf_1/content/more'],
    ['a backslash', '/api/chat-files/cf_1\\content'],
    ['the empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(chatFilePath(value)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(chatFilePath(undefined)).toBeNull();
    expect(chatFilePath(null)).toBeNull();
    expect(chatFilePath(42)).toBeNull();
    expect(chatFilePath({ toString: () => '/api/chat-files/cf_1/content' })).toBeNull();
  });
});

describe('chatFileUrl', () => {
  it('resolves the route against the station', () => {
    expect(chatFileUrl('/api/chat-files/cf_1/content', BASE)).toBe('https://green.example.com/api/chat-files/cf_1/content');
    expect(chatFileUrl('/api/chat-files/cf_1/content', 'http://192.168.1.5:3000/')).toBe(
      'http://192.168.1.5:3000/api/chat-files/cf_1/content',
    );
  });

  it('never leaves the station origin', () => {
    for (const value of [
      'https://evil.example/p.png',
      '@evil.example/p.png',
      '.evil.example/p',
      '//evil.example/api/chat-files/cf_1/content',
      'https://green.example.com@evil.example/api/chat-files/cf_1/content',
    ]) {
      expect(chatFileUrl(value, BASE)).toBeNull();
    }
  });

  it('refuses a base that is not an http(s) URL', () => {
    expect(chatFileUrl('/api/chat-files/cf_1/content', '')).toBeNull();
    expect(chatFileUrl('/api/chat-files/cf_1/content', 'not a url')).toBeNull();
    expect(chatFileUrl('/api/chat-files/cf_1/content', 'file:///etc')).toBeNull();
    expect(chatFileUrl('/api/chat-files/cf_1/content', 'https://green.example.com#')).toBeNull();
  });
});
