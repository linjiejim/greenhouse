/**
 * @vitest-environment happy-dom
 */
/**
 * The auto-login latch is the one thing standing between an unbound colleague
 * and an inescapable redirect loop: inside the Feishu client we send them to
 * authorization, they come back `reason=not_bound`, and without the latch the
 * effect fires again — the password form is never reachable.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { feishuAutoLoginAttempted, isInsideFeishuClient, markFeishuAutoLoginAttempted } from './feishu';

describe('isInsideFeishuClient', () => {
  const original = navigator.userAgent;
  const setUA = (ua: string) => Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
  afterEach(() => setUA(original));

  it('recognises both the Chinese and international clients', () => {
    setUA('Mozilla/5.0 (Macintosh) Lark/7.20.5 Electron');
    expect(isInsideFeishuClient()).toBe(true);
    setUA('Mozilla/5.0 (iPhone) Feishu/7.20.5');
    expect(isInsideFeishuClient()).toBe(true);
  });

  it('leaves ordinary browsers alone — auto-login must never fire there', () => {
    setUA('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128 Safari/537.36');
    expect(isInsideFeishuClient()).toBe(false);
  });
});

describe('auto-login latch', () => {
  beforeEach(() => sessionStorage.clear());

  it('latches after one attempt', () => {
    expect(feishuAutoLoginAttempted()).toBe(false);
    markFeishuAutoLoginAttempted();
    expect(feishuAutoLoginAttempted()).toBe(true);
  });

  it('fails CLOSED when storage is unavailable', () => {
    // Private mode throws on sessionStorage access. Reporting "already tried"
    // costs the user a password login; reporting "not tried" would loop them
    // forever — so the unreadable case must answer true.
    const spy = vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(feishuAutoLoginAttempted()).toBe(true);
    spy.mockRestore();
  });
});
