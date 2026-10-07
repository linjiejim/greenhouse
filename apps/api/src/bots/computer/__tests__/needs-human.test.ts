import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyNeedsHuman,
  humanCheckHint,
  humanCheckRefusal,
  isCloudflareBlock,
  needsHumanHint,
  sniffNeedsHuman,
  type NeedsHumanSignals,
} from '../needs-human.js';
import { chromiumAvailable, launchTestChromium, type TestChromium } from '../../__tests__/helpers/chromium.js';
import { startFixtureSite, type FixtureSite } from '../../__tests__/helpers/fixture-server.js';

const quiet: NeedsHumanSignals = { title: 'Docs', text: 'Hello', captcha: 0, otp: 0, currentPassword: 0 };

describe('classifyNeedsHuman', () => {
  it('orders challenge > captcha > otp > login', () => {
    expect(classifyNeedsHuman(quiet)).toBeNull();
    expect(classifyNeedsHuman({ ...quiet, currentPassword: 1 })).toBe('login');
    expect(classifyNeedsHuman({ ...quiet, currentPassword: 1, otp: 1 })).toBe('otp');
    expect(classifyNeedsHuman({ ...quiet, otp: 1, captcha: 1 })).toBe('captcha');
    expect(classifyNeedsHuman({ ...quiet, title: 'Just a moment...', captcha: 1 })).toBe('challenge');
    expect(classifyNeedsHuman({ ...quiet, title: '请稍候…' })).toBe('challenge');
    expect(classifyNeedsHuman({ ...quiet, text: 'Verify you are human by completing the action below.' })).toBe(
      'challenge',
    );
  });
});

describe('needsHumanHint', () => {
  const entry = { id: 'vlt_1', label: 'GitHub', username_hint: 'ji***@x.com', has_password: true, has_totp: false };

  it('points at matching vault entries for a sign-in page', () => {
    const hint = needsHumanHint('login', 'https://github.com', [entry], true);
    expect(hint).toContain('vlt_1 (GitHub, ji***@x.com)');
    expect(hint).toContain('fill_login');
  });

  it('asks for a secure sign-in card when nothing matches', () => {
    expect(needsHumanHint('login', 'https://github.com', [], true)).toMatch(/request_takeover with kind "login"/);
    expect(needsHumanHint('otp', 'https://github.com', [entry], true)).toMatch(/kind "otp"/);
    expect(needsHumanHint('otp', 'https://github.com', [{ ...entry, has_totp: true }], true)).toMatch(/fill_totp/);
  });

  it('does not mention the vault when the turn has none', () => {
    expect(needsHumanHint('login', 'https://github.com', null, true)).not.toMatch(/vault has no entry/);
  });

  it('tells CAPTCHA pages to hand over, and background tasks to report instead', () => {
    // Without the browser's own card (it could not be raised): ask for one, never hop to another URL.
    for (const kind of ['captcha', 'challenge'] as const) {
      const hint = needsHumanHint(kind, 'https://x.com', null, true);
      expect(hint).toMatch(/kind "captcha"/);
      expect(hint).toMatch(/Do not try to solve it or another address on this site/);
    }
    expect(needsHumanHint('login', 'https://x.com', null, false)).toMatch(/background task cannot sign in/);
    expect(needsHumanHint('captcha', 'https://x.com', null, false)).not.toMatch(/request_takeover/);
  });

  it('after the card is up: end the turn, no other address, no shell, no search', () => {
    const hint = humanCheckHint('https://x.com');
    expect(hint).toMatch(/^https:\/\/x\.com asks for human verification\. The member now has a card/);
    expect(hint).toMatch(/End your turn NOW/);
    expect(hint).toMatch(/Never try to solve or bypass it/);
    expect(hint).toMatch(/another address on this site or reach it with the shell or a search/);
    expect(humanCheckRefusal('https://x.com', false)).toMatch(/waiting for the member.*end your turn/);
    expect(humanCheckRefusal('https://x.com', true)).toMatch(/background task cannot pass.*move on/);
  });
});

describe('isCloudflareBlock', () => {
  const cf = (status: number, headers: Record<string, string>) => ({ status, headers });

  it('needs a blocking status plus a Cloudflare challenge marker', () => {
    expect(isCloudflareBlock(cf(403, { 'cf-mitigated': 'challenge' }), 'Un instant…')).toBe(true);
    expect(isCloudflareBlock(cf(503, { server: 'cloudflare' }), 'Just a moment...')).toBe(true);
    expect(isCloudflareBlock(cf(429, { 'cf-mitigated': 'challenge' }), '')).toBe(true);
    // A plain Cloudflare-served 403 page is not a human check; neither is a 200.
    expect(isCloudflareBlock(cf(403, { server: 'cloudflare' }), 'Forbidden')).toBe(false);
    expect(isCloudflareBlock(cf(200, { 'cf-mitigated': 'challenge' }), 'Just a moment...')).toBe(false);
    expect(isCloudflareBlock(cf(403, { server: 'nginx' }), 'Just a moment...')).toBe(false);
    expect(isCloudflareBlock(null, 'Just a moment...')).toBe(false);
  });
});

describe.skipIf(!chromiumAvailable())('sniffNeedsHuman on real pages', { timeout: 60_000 }, () => {
  let chromium: TestChromium;
  let site: FixtureSite;

  beforeAll(async () => {
    site = await startFixtureSite();
    chromium = await launchTestChromium();
  });
  afterAll(async () => {
    await chromium?.close();
    await site?.close();
  });

  it.each([
    ['/login', 'login'],
    ['/otp', 'otp'],
    ['/captcha', 'captcha'],
    ['/challenge', 'challenge'],
    ['/home', null],
    ['/captcha-invisible', null],
    ['/captcha-solved', null],
  ])('%s → %s', async (path, kind) => {
    // A reCAPTCHA box stays on the page, ticked, once passed: its token says so.
    site.pages.set(
      '/captcha-solved',
      `<!doctype html><title>Security check</title><iframe title="reCAPTCHA" src="about:blank" width="304" height="78"></iframe>
       <textarea name="g-recaptcha-response" style="display:none">03AFcWeA-token</textarea>`,
    );
    const page = await chromium.browser.contexts()[0]!.newPage();
    await page.goto(`${site.origin}${path}`);
    expect(await sniffNeedsHuman(page)).toBe(kind);
    await page.close();
  });
});
