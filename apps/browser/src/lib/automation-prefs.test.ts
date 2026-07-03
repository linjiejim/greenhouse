/**
 * Permission-policy tests for the pure decision function — the security-critical
 * core of the Ask/Auto/YOLO gate. No chrome APIs touched.
 */

import { describe, expect, it } from 'vitest';
import { decideAction, isSensitiveHost, hostOf, type ActionSignals } from './automation-prefs';

const NONE: ActionSignals = {};
const empty = new Set<string>();

describe('decideAction', () => {
  it('ask mode always asks', () => {
    expect(decideAction('ask', 'example.com', NONE, empty, empty)).toBe('ask');
    expect(decideAction('ask', 'example.com', { willSubmit: true }, empty, empty)).toBe('ask');
  });

  it('auto mode allows ordinary actions but asks on danger signals', () => {
    expect(decideAction('auto', 'example.com', NONE, empty, empty)).toBe('allow');
    expect(decideAction('auto', 'example.com', { isPassword: true }, empty, empty)).toBe('ask');
    expect(decideAction('auto', 'example.com', { isPayment: true }, empty, empty)).toBe('ask');
    expect(decideAction('auto', 'example.com', { willSubmit: true }, empty, empty)).toBe('ask');
    expect(decideAction('auto', 'example.com', { isSensitiveDomain: true }, empty, empty)).toBe('ask');
  });

  it('per-site YOLO overrides everything, including danger signals', () => {
    const yolo = new Set(['example.com']);
    expect(decideAction('ask', 'example.com', { isPassword: true }, yolo, empty)).toBe('allow');
    expect(decideAction('auto', 'example.com', { willSubmit: true }, yolo, empty)).toBe('allow');
  });

  it('YOLO is host-scoped — a different host is not allowed', () => {
    const yolo = new Set(['example.com']);
    expect(decideAction('ask', 'evil.com', NONE, yolo, empty)).toBe('ask');
  });

  it('session grant allows without persisting mode change', () => {
    const session = new Set(['example.com']);
    expect(decideAction('ask', 'example.com', { willSubmit: true }, empty, session)).toBe('allow');
    expect(decideAction('ask', 'other.com', NONE, empty, session)).toBe('ask');
  });

  it('unknown host is never auto-allowed by YOLO/session grants', () => {
    const yolo = new Set(['example.com']);
    const session = new Set(['example.com']);
    // host undefined ⇒ falls through to mode policy (ask here).
    expect(decideAction('ask', undefined, NONE, yolo, session)).toBe('ask');
  });
});

describe('isSensitiveHost', () => {
  it('flags known sensitive host substrings', () => {
    expect(isSensitiveHost('secure.mybank.com')).toBe(true);
    expect(isSensitiveHost('www.paypal.com')).toBe(true);
    expect(isSensitiveHost('mail.google.com')).toBe(true);
    expect(isSensitiveHost('checkout.shop.com')).toBe(true);
  });
  it('does not flag ordinary hosts', () => {
    expect(isSensitiveHost('news.ycombinator.com')).toBe(false);
    expect(isSensitiveHost('github.com')).toBe(false);
    expect(isSensitiveHost(undefined)).toBe(false);
  });
});

describe('hostOf', () => {
  it('extracts host from a URL', () => {
    expect(hostOf('https://example.com/path?q=1')).toBe('example.com');
    expect(hostOf('https://sub.example.com:8443/')).toBe('sub.example.com:8443');
  });
  it('returns undefined for junk', () => {
    expect(hostOf(undefined)).toBeUndefined();
    expect(hostOf('not a url')).toBeUndefined();
  });
});
