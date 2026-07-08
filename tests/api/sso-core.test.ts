/**
 * SSO core unit tests — state signing, one-time tickets, redirect hygiene,
 * public-path precision, env-driven registry, and the fork connector seam
 * (guard: upstream ships zero private connectors).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Set env before importing (signing key is read lazily at call time)
process.env.ACCESS_PASSWORD = 'test-secret-password-123';
process.env.TOKEN_SIGNING_KEY = 'dedicated-signing-key-for-tests-xyz';

import { signSsoState, verifySsoState, sanitizeRedirect } from '../../apps/api/src/auth/sso/state.js';
import { issueLoginTicket, redeemLoginTicket } from '../../apps/api/src/auth/sso/tickets.js';
import {
  getSsoConnectors,
  getSsoConnector,
  autoProvisionRole,
  _resetSsoConnectorsForTests,
} from '../../apps/api/src/auth/sso/registry.js';
import { EXTENSION_SSO_CONNECTORS } from '../../apps/api/src/auth/sso/extensions.js';
import { isPublicPath } from '../../apps/api/src/auth/middleware.js';
import { appendQuery, synthesizeEmail, SSO_PASSWORD_SENTINEL } from '../../apps/api/src/routes/sso.js';

const SSO_ENV_KEYS = [
  'SSO_WECOM_CORP_ID',
  'SSO_WECOM_AGENT_ID',
  'SSO_WECOM_SECRET',
  'SSO_FEISHU_APP_ID',
  'SSO_FEISHU_APP_SECRET',
  'SSO_FEISHU_BASE_URL',
  'SSO_AUTO_PROVISION',
  'SSO_AUTO_PROVISION_ROLE',
];

describe('SSO state (HMAC round-trip token)', () => {
  it('signs and verifies a login state', () => {
    const raw = signSsoState({ provider: 'wecom', purpose: 'login', redirect: '/#chat' });
    const payload = verifySsoState(raw);
    expect(payload).not.toBeNull();
    expect(payload!.provider).toBe('wecom');
    expect(payload!.purpose).toBe('login');
    expect(payload!.redirect).toBe('/#chat');
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('carries the bind target uid', () => {
    const raw = signSsoState({ provider: 'feishu', purpose: 'bind', uid: 'user-1' });
    expect(verifySsoState(raw)!.uid).toBe('user-1');
  });

  it('rejects a tampered payload', () => {
    const raw = signSsoState({ provider: 'wecom', purpose: 'login' });
    const [payload, sig] = raw.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), purpose: 'bind', uid: 'victim' }),
    ).toString('base64url');
    expect(verifySsoState(`${forged}.${sig}`)).toBeNull();
  });

  it('rejects garbage and wrong-part-count input', () => {
    expect(verifySsoState('')).toBeNull();
    expect(verifySsoState('a.b.c')).toBeNull();
    expect(verifySsoState('not-a-state')).toBeNull();
  });

  it('two states for the same flow differ (nonce)', () => {
    const a = signSsoState({ provider: 'wecom', purpose: 'login' });
    const b = signSsoState({ provider: 'wecom', purpose: 'login' });
    expect(a).not.toBe(b);
  });
});

describe('sanitizeRedirect (open-redirect guard)', () => {
  it('keeps in-app relative paths', () => {
    expect(sanitizeRedirect('/#chat')).toBe('/#chat');
    expect(sanitizeRedirect('/?x=1#/settings/preferences')).toBe('/?x=1#/settings/preferences');
  });

  it('falls back to / for absolute, protocol-relative, and missing targets', () => {
    expect(sanitizeRedirect(undefined)).toBe('/');
    expect(sanitizeRedirect('https://evil.example')).toBe('/');
    expect(sanitizeRedirect('//evil.example')).toBe('/');
    expect(sanitizeRedirect('/\\evil.example')).toBe('/');
    expect(sanitizeRedirect('javascript:alert(1)')).toBe('/');
  });
});

describe('SSO one-time tickets', () => {
  it('redeems exactly once', () => {
    const raw = issueLoginTicket('user-42');
    expect(redeemLoginTicket(raw)).toEqual({ userId: 'user-42' });
    expect(redeemLoginTicket(raw)).toBeNull();
  });

  it('rejects unknown tickets', () => {
    expect(redeemLoginTicket('deadbeef'.repeat(8))).toBeNull();
  });
});

describe('appendQuery (SPA landing URL)', () => {
  it('inserts query before the hash route', () => {
    expect(appendQuery('/#/settings/preferences', { sso_bind: 'ok' })).toBe('/?sso_bind=ok#/settings/preferences');
  });

  it('appends with & when a query already exists', () => {
    expect(appendQuery('/?a=1#x', { t: 'v' })).toBe('/?a=1&t=v#x');
  });

  it('handles a bare path', () => {
    expect(appendQuery('/', { sso_ticket: 'abc' })).toBe('/?sso_ticket=abc');
  });
});

describe('synthesizeEmail (JIT placeholder)', () => {
  it('normalizes the subject into a stable local part', () => {
    expect(synthesizeEmail('wecom', 'Zhang.San_01')).toBe('wecom-zhang-san-01@sso.local');
  });

  it('never produces an empty local part', () => {
    expect(synthesizeEmail('feishu', '___')).toBe('feishu-user@sso.local');
  });

  it('sentinel is not a valid scrypt hash shape', () => {
    // verifyPassword splits on ':' — a sentinel without both parts can never match.
    expect(SSO_PASSWORD_SENTINEL.includes(':')).toBe(false);
  });
});

describe('SSO public paths (precision — no auth bypass beyond the four entries)', () => {
  it('exposes providers/exchange/authorize/callback', () => {
    expect(isPublicPath('/api/auth/sso/providers')).toBe(true);
    expect(isPublicPath('/api/auth/sso/exchange')).toBe(true);
    expect(isPublicPath('/api/auth/sso/wecom/authorize')).toBe(true);
    expect(isPublicPath('/api/auth/sso/feishu/callback')).toBe(true);
  });

  it('keeps identities and bind-url behind Bearer auth', () => {
    expect(isPublicPath('/api/auth/sso/identities')).toBe(false);
    expect(isPublicPath('/api/auth/sso/identities/wecom')).toBe(false);
    expect(isPublicPath('/api/auth/sso/wecom/bind-url')).toBe(false);
    // Deeper/odd shapes stay private too.
    expect(isPublicPath('/api/auth/sso/wecom/callback/extra')).toBe(false);
    expect(isPublicPath('/api/auth/sso')).toBe(false);
  });
});

describe('SSO connector registry (env-driven)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of SSO_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    _resetSsoConnectorsForTests();
  });

  afterEach(() => {
    for (const key of SSO_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    EXTENSION_SSO_CONNECTORS.length = 0;
    _resetSsoConnectorsForTests();
  });

  it('ships no fork connectors upstream (OSS invariant)', () => {
    expect(EXTENSION_SSO_CONNECTORS).toEqual([]);
  });

  it('no env → no providers (SSO simply off)', () => {
    expect(getSsoConnectors()).toEqual([]);
    expect(getSsoConnector('wecom')).toBeUndefined();
  });

  it('full WeCom group registers the connector', () => {
    process.env.SSO_WECOM_CORP_ID = 'ww1';
    process.env.SSO_WECOM_AGENT_ID = '1000001';
    process.env.SSO_WECOM_SECRET = 's3cret';
    const ids = getSsoConnectors().map((c) => c.id);
    expect(ids).toEqual(['wecom']);
  });

  it('partial WeCom group refuses to start', () => {
    process.env.SSO_WECOM_CORP_ID = 'ww1';
    expect(() => getSsoConnectors()).toThrow(/Partial WeCom SSO config/);
  });

  it('full Feishu pair registers the connector', () => {
    process.env.SSO_FEISHU_APP_ID = 'cli_x';
    process.env.SSO_FEISHU_APP_SECRET = 'sec';
    const ids = getSsoConnectors().map((c) => c.id);
    expect(ids).toEqual(['feishu']);
  });

  it('partial Feishu pair refuses to start', () => {
    process.env.SSO_FEISHU_APP_SECRET = 'sec';
    expect(() => getSsoConnectors()).toThrow(/Partial Feishu SSO config/);
  });

  it('fork connectors splice in after built-ins', () => {
    EXTENSION_SSO_CONNECTORS.push({
      id: 'dingtalk',
      label: '钉钉',
      buildAuthorizeUrl: () => 'https://example.com',
      exchangeCode: async () => ({ subject: 'x' }),
    });
    _resetSsoConnectorsForTests();
    expect(getSsoConnector('dingtalk')?.label).toBe('钉钉');
  });

  it('duplicate connector ids are rejected', () => {
    process.env.SSO_FEISHU_APP_ID = 'cli_x';
    process.env.SSO_FEISHU_APP_SECRET = 'sec';
    EXTENSION_SSO_CONNECTORS.push({
      id: 'feishu',
      label: 'dup',
      buildAuthorizeUrl: () => '',
      exchangeCode: async () => ({ subject: 'x' }),
    });
    expect(() => getSsoConnectors()).toThrow(/Duplicate SSO connector id/);
  });

  it('validates SSO_AUTO_PROVISION_ROLE at registry build', () => {
    process.env.SSO_AUTO_PROVISION_ROLE = 'super';
    expect(() => getSsoConnectors()).toThrow(/SSO_AUTO_PROVISION_ROLE/);
  });

  it('autoProvisionRole defaults to team and accepts external', () => {
    expect(autoProvisionRole()).toBe('team');
    process.env.SSO_AUTO_PROVISION_ROLE = 'external';
    expect(autoProvisionRole()).toBe('external');
  });
});
