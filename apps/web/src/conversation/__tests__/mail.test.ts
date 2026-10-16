import { describe, expect, it } from 'vitest';
import { imageSource, linkAllowed } from '../MailDrawer';

/** The rules the mail purifier applies; the purifier itself runs in a real browser (e2e/mail.e2e.ts). */
describe('what a mail may link to and show', () => {
  const inline = new Map([['logo@acme', '/api/files/fil_1/content?sig=x']]);

  it('opens the web and mail, and drops everything else', () => {
    expect(linkAllowed('https://acme.test/x')).toBe(true);
    expect(linkAllowed(' HTTP://acme.test')).toBe(true);
    expect(linkAllowed('mailto:a@b.c')).toBe(true);
    expect(linkAllowed('javascript:alert(1)')).toBe(false);
    expect(linkAllowed('#/settings')).toBe(false);
    expect(linkAllowed('data:text/html,<script>1</script>')).toBe(false);
  });

  it('holds back remote images until asked, and shows the mail’s own through their file links', () => {
    expect(imageSource('https://track.test/p.gif', { remote: false, inline })).toEqual({ src: null, blocked: true });
    expect(imageSource('https://track.test/p.gif', { remote: true, inline })).toEqual({
      src: 'https://track.test/p.gif',
      blocked: false,
    });
    expect(imageSource('cid:logo@acme', { remote: false, inline })).toEqual({
      src: '/api/files/fil_1/content?sig=x',
      blocked: false,
    });
    expect(imageSource('cid:<logo@acme>', { remote: false, inline }).src).toBe('/api/files/fil_1/content?sig=x');
    expect(imageSource('cid:missing', { remote: true, inline })).toEqual({ src: null, blocked: false });
    expect(imageSource('data:image/png;base64,AAAA', { remote: false, inline }).src).toBe('data:image/png;base64,AAAA');
    expect(imageSource('data:image/svg+xml;base64,AAAA', { remote: true, inline }).src).toBeNull();
    expect(imageSource('//track.test/p.gif', { remote: true, inline }).src).toBeNull();
  });
});
