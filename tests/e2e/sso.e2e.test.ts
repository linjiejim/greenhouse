/**
 * E2E Security Tests — SSO surface (unconfigured instance)
 *
 * CI runs the API without any SSO_* env, so these assert the OFF posture:
 * the surface is present but inert (no providers, unknown connectors 404,
 * bogus tickets rejected) and the authed identity endpoints stay gated.
 *
 *   API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm vitest run tests/e2e/ --config vitest.e2e.config.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createTestToken, BASE_URL } from './helpers.js';

describe('E2E: SSO surface (no connectors configured)', () => {
  let internalToken: string;

  beforeAll(async () => {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (!res.ok) throw new Error('Server not healthy');
    } catch {
      throw new Error(
        `Server not running at ${BASE_URL}. Start it with: API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm api`,
      );
    }
    internalToken = await createTestToken('e2e-sso-test', 'super');
  });

  it('providers list is public and empty without SSO env', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sso/providers`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.providers).toEqual([]);
  });

  it('authorize for an unconfigured provider is 404, not a redirect', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sso/wecom/authorize`, { redirect: 'manual' });
    expect(res.status).toBe(404);
  });

  it('callback for an unconfigured provider is 404', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sso/wecom/callback?code=x&state=y`, { redirect: 'manual' });
    expect(res.status).toBe(404);
  });

  it('exchange rejects a bogus ticket', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sso/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: 'ff'.repeat(32) }),
    });
    expect(res.status).toBe(401);
  });

  it('exchange requires a ticket field', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sso/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('identities endpoint requires auth', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sso/identities`);
    expect(res.status).toBe(401);
  });

  it('identities endpoint works for an internal user (empty list)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sso/identities`, {
      headers: { Authorization: `Bearer ${internalToken}` },
    });
    // The token's user may not exist as a DB row in this suite — 404 is the
    // route's "user not found" answer for DELETE; GET returns 200 + [] since it
    // only lists rows. Either way it must NOT be an auth bypass (401/403).
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.identities)).toBe(true);
  });

  it('bind-url requires auth', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sso/wecom/bind-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});
