/**
 * The local fallback fetches search results from the API host itself, so it
 * must refuse anything that is not a public address before any request is made
 * (the network policy itself is tested in security/network.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { LocalFallbackExtractor, stripHTMLTags } from './extractor.js';

describe('LocalFallbackExtractor', () => {
  it.each([
    'http://127.0.0.1:3111/api/admin/users',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost/',
    'http://192.168.1.1/',
    'file:///etc/passwd',
  ])('refuses %s before fetching', async (url) => {
    await expect(new LocalFallbackExtractor().extract(url)).rejects.toThrow(/not public|must use HTTP/);
  });

  it('strips markup to readable text', () => {
    expect(stripHTMLTags('<head><title>x</title></head><p>Hello&nbsp;<b>world</b></p><script>bad()</script>')).toBe(
      'Hello world',
    );
  });
});
