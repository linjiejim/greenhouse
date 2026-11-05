import { describe, expect, it } from 'vitest';
import { defineExtension, validateUiMedia } from '../define.js';

describe('uiMedia', () => {
  it('accepts https origins and subdomain wildcards', () => {
    expect(validateUiMedia(undefined)).toBeNull();
    expect(
      validateUiMedia(['https://cdn.example.com', 'https://*.example.org', 'https://a.b.example:8443']),
    ).toBeNull();
  });

  it.each([
    [['http://cdn.example.com']],
    [['https://cdn.example.com/']],
    [['https://cdn.example.com/media']],
    [['https://example']],
    [["https://cdn.example.com 'unsafe-inline'"]],
    [['https://*']],
    [['data:']],
    ['https://cdn.example.com'],
    [Array.from({ length: 9 }, (_, i) => `https://c${i}.example.com`)],
  ])('refuses %j at definition time', (uiMedia) => {
    expect(validateUiMedia(uiMedia)).not.toBeNull();
    expect(() => defineExtension({ id: 'fixture', name: 'Fixture', uiMedia: uiMedia as string[] })).toThrow(/uiMedia/);
  });
});
