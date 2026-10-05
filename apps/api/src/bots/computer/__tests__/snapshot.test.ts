import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateTokens } from '@greenhouse/agent-core';
import { capSnapshot, maskSnapshot, takeSnapshot, SNAPSHOT_TOKEN_CAP } from '../snapshot.js';
import { chromiumAvailable, launchTestChromium, type TestChromium } from '../../__tests__/helpers/chromium.js';
import { startFixtureSite, type FixtureSite } from '../../__tests__/helpers/fixture-server.js';

const noScan = { values: [], mainFrameFailed: false, childFrameFailed: false };

describe('maskSnapshot', () => {
  const snapshot = [
    '- generic [ref=e1]:',
    '  - textbox "Email" [ref=e5]: jim@example.com',
    '  - textbox "Password" [ref=e7]: hunter2secret',
    '  - textbox "Code" [ref=e9]: "123456"',
    '  - textbox "Search" [active] [ref=e10]: shoes',
    '  - paragraph [ref=e11]: Your code is 123456 — keep hunter2secret safe',
    '  - iframe [ref=e13]:',
    '    - textbox [ref=f1e2]: framevalue',
  ].join('\n');

  it('masks scanned values on textbox lines with their length', () => {
    const { text, masked } = maskSnapshot(snapshot, { ...noScan, values: ['hunter2secret', '123456'] });
    expect(text).toContain('textbox "Password" [ref=e7]: ••• (13 chars)');
    expect(text).toContain('textbox "Code" [ref=e9]: ••• (6 chars)');
    expect(text).toContain('textbox "Email" [ref=e5]: jim@example.com');
    expect(text).toContain('textbox "Search" [active] [ref=e10]: shoes');
    expect(text).not.toContain('hunter2secret');
    expect(text).not.toContain('123456');
    expect(masked).toBeGreaterThanOrEqual(3);
  });

  it('masks by accessible name even when the scan missed the field', () => {
    const { text } = maskSnapshot(
      '- textbox "密码" [ref=e3]: abc\n- textbox "Card number" [ref=e4]: 4111111111111111',
      noScan,
    );
    expect(text).toBe('- textbox "密码" [ref=e3]: ••• (3 chars)\n- textbox "Card number" [ref=e4]: ••• (16 chars)');
  });

  it('masks every textbox of frames the scan could not reach', () => {
    const child = maskSnapshot(snapshot, { ...noScan, childFrameFailed: true }).text;
    expect(child).toContain('[ref=f1e2]: ••• (10 chars)');
    expect(child).toContain('[ref=e5]: jim@example.com');
    const main = maskSnapshot(snapshot, { ...noScan, mainFrameFailed: true }).text;
    expect(main).toContain('[ref=e5]: ••• (15 chars)');
  });

  it('never rewrites ref handles, even when a value collides with one', () => {
    const { text } = maskSnapshot('- textbox "PIN" [ref=e123]: e123\n- link "e123 docs" [ref=e124]', {
      ...noScan,
      values: ['e123'],
    });
    expect(text).toContain('[ref=e123]');
    expect(text).toContain('[ref=e124]');
    expect(text).toContain('- link "••• docs"');
  });

  it('handles YAML-escaped values', () => {
    const { text } = maskSnapshot('- textbox "Password" [ref=e2]: "a\\"b:c"', { ...noScan, values: ['a"b:c'] });
    expect(text).toBe('- textbox "Password" [ref=e2]: ••• (5 chars)');
  });
});

describe('capSnapshot', () => {
  it('leaves short snapshots alone', () => {
    expect(capSnapshot('- heading "Hi" [ref=e1]')).toEqual({ text: '- heading "Hi" [ref=e1]', truncated: false });
  });

  it('keeps head and tail of long CJK snapshots under the cap, with a marker', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `- paragraph [ref=e${i}]: 第${i}段，这是一个很长的中文段落。`);
    const { text, truncated } = capSnapshot(lines.join('\n'));
    expect(truncated).toBe(true);
    expect(estimateTokens(text)).toBeLessThanOrEqual(SNAPSHOT_TOKEN_CAP);
    expect(text).toContain('[ref=e0]');
    expect(text).toContain('[ref=e1999]');
    expect(text).toMatch(/lines of the page omitted/);
  });

  it('keeps 30 consecutive snapshots of a long page bounded (≈3k tokens each)', () => {
    const page = Array.from({ length: 800 }, (_, i) => `- text: 第${i}行内容，价格 ¥${i * 3}，评论很多很多。`).join(
      '\n',
    );
    const total = Array.from({ length: 30 }, () => estimateTokens(capSnapshot(page).text)).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(30 * SNAPSHOT_TOKEN_CAP);
  });

  it('truncates a single enormous line', () => {
    const { text } = capSnapshot(`- text: ${'x'.repeat(50_000)}`);
    expect(text.length).toBeLessThan(2_100);
    expect(text).toContain('[line truncated]');
  });
});

describe.skipIf(!chromiumAvailable())('takeSnapshot on a real page', { timeout: 60_000 }, () => {
  let chromium: TestChromium;
  let site: FixtureSite;
  let other: FixtureSite;

  beforeAll(async () => {
    other = await startFixtureSite();
    site = await startFixtureSite(() => other.origin);
    chromium = await launchTestChromium();
  });
  afterAll(async () => {
    await chromium?.close();
    await site?.close();
    await other?.close();
  });

  it('shows no password, OTP, PIN, shadow-DOM or cross-origin-iframe secret', async () => {
    const page = await chromium.browser.contexts()[0]!.newPage();
    await page.goto(`${site.origin}/prefilled`);
    await page.frameLocator('iframe').locator('input[type=password]').waitFor();
    // A value the member typed during take-over, then remembered by the computer.
    await page.fill('input[name=note]', 'typed-by-member-77');
    const remembered = ['typed-by-member-77'];
    const redact = (text: string) => remembered.reduce((out, v) => out.split(v).join('[REDACTED]'), text);

    const { snapshot, masked } = await takeSnapshot(page, redact);

    for (const secret of [
      'hunter2-Secret!',
      '482913',
      '7731',
      'shadow-pass-99',
      'frame-pass-42',
      '551177',
      'typed-by-member-77',
    ]) {
      expect(snapshot).not.toContain(secret);
    }
    expect(snapshot).toContain('member@example.com');
    expect(snapshot).toContain('1 Main St'); // "shipping" is not a secret
    expect(snapshot).toContain('••• (15 chars)');
    expect(snapshot).toContain('[REDACTED]');
    expect(masked).toBeGreaterThanOrEqual(6);
    await page.close();
  });

  it('caps a long page', async () => {
    const page = await chromium.browser.contexts()[0]!.newPage();
    await page.goto(`${site.origin}/long`);
    const { snapshot, truncated } = await takeSnapshot(page, (t) => t);
    expect(truncated).toBe(true);
    expect(estimateTokens(snapshot)).toBeLessThanOrEqual(SNAPSHOT_TOKEN_CAP);
    await page.close();
  });
});
