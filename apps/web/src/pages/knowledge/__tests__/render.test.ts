import { describe, expect, it } from 'vitest';
import { linkKind, pictureAllowed } from '../render';

/** The rules the sanitizer applies; the sanitizer itself runs in a real browser (e2e/knowledge.e2e.ts). */
describe('what a doc may link to and show', () => {
  it('keeps app routes in the app, opens the web and mail outside, and drops everything else', () => {
    expect(linkKind('#/knowledge/doc_1')).toBe('app');
    expect(linkKind('https://example.com')).toBe('web');
    expect(linkKind('HTTP://example.com')).toBe('web');
    expect(linkKind('mailto:a@b.c')).toBe('web');
    expect(linkKind('javascript:alert(1)')).toBeNull();
    expect(linkKind(' javascript:alert(1)')).toBeNull();
    expect(linkKind('data:text/html,<script>1</script>')).toBeNull();
    expect(linkKind('member:mbr_1')).toBeNull();
    expect(linkKind('//evil.example')).toBeNull();
    expect(linkKind('#anchor')).toBeNull();
    expect(linkKind(null)).toBeNull();
  });

  it('shows pictures of the file service and the web only', () => {
    expect(pictureAllowed('/api/files/fil_01ABC/content')).toBe(true);
    expect(pictureAllowed('/api/files/fil_01ABC/content?exp=1&m=mbr_1&sig=x')).toBe(true);
    expect(pictureAllowed('https://example.com/a.png')).toBe(true);
    expect(pictureAllowed('/api/files/fil_01ABC/contentx')).toBe(false);
    expect(pictureAllowed('/etc/passwd')).toBe(false);
    expect(pictureAllowed('javascript:alert(1)')).toBe(false);
    expect(pictureAllowed('data:image/png;base64,AAAA')).toBe(false);
  });
});
