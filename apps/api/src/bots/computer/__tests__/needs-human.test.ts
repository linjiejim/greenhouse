import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyNeedsHuman, needsHumanHint, sniffNeedsHuman, type NeedsHumanSignals } from '../needs-human.js';
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
    expect(needsHumanHint('captcha', 'https://x.com', null, true)).toMatch(/kind "captcha"/);
    expect(needsHumanHint('challenge', 'https://x.com', null, true)).toMatch(/Wait a few seconds/);
    expect(needsHumanHint('login', 'https://x.com', null, false)).toMatch(/background task cannot sign in/);
    expect(needsHumanHint('captcha', 'https://x.com', null, false)).not.toMatch(/request_takeover/);
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
  ])('%s → %s', async (path, kind) => {
    const page = await chromium.browser.contexts()[0]!.newPage();
    await page.goto(`${site.origin}${path}`);
    expect(await sniffNeedsHuman(page)).toBe(kind);
    await page.close();
  });
});
