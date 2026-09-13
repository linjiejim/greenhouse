/**
 * E2E Security Tests — Authentication & Authorization
 *
 * These tests run against a live server instance and validate
 * real security boundaries. Use `pnpm test:e2e:ci`; manual debugging requires
 * a seeded E2E_SUPER_USER_ID as documented in tests/e2e/README.md.
 *
 * Prerequisites:
 *   - Server running on the configured port
 *   - TOKEN_SIGNING_KEY matches tests/e2e/helpers.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createSuperToken, createTestToken, BASE_URL } from './helpers.js';

async function getValidToken(): Promise<string> {
  return createSuperToken();
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

describe('E2E: Authentication Security', () => {
  let validToken: string;

  beforeAll(async () => {
    // Verify server is running
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (!res.ok) throw new Error('Server not healthy');
    } catch {
      throw new Error(`Server not running at ${BASE_URL}. Run pnpm test:e2e:ci or follow tests/e2e/README.md.`);
    }
    validToken = await getValidToken();
  });

  // ─── Token Validation ───────────────────────────────────

  it('rejects requests without token', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.needsAuth).toBe(true);
  });

  it('rejects requests with invalid token', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      headers: { Authorization: 'Bearer invalid-token-value' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with expired token', async () => {
    // Craft a token with an expired timestamp (year 2020)
    const expiredHex = Math.floor(new Date('2020-01-01').getTime() / 1000).toString(16);
    const fakeToken = `${expiredHex}.0000000000000000000000000000000000000000000000000000000000000000`;
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      headers: { Authorization: `Bearer ${fakeToken}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with tampered token signature', async () => {
    // Take a valid token and completely replace the signature
    const parts = validToken.split('.');
    const tamperedSig = '0'.repeat(parts[1].length);
    const tamperedToken = `${parts[0]}.${tamperedSig}`;
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      headers: { Authorization: `Bearer ${tamperedToken}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with malformed bearer header', async () => {
    const variants = [
      'Bearer', // no token
      'Bearer ', // empty token
      `Basic ${validToken}`, // wrong scheme
      validToken, // no scheme prefix
    ];

    for (const auth of variants) {
      const res = await fetch(`${BASE_URL}/api/sessions`, {
        headers: { Authorization: auth },
      });
      expect(res.status).toBe(401);
    }
  });

  it('accepts valid token for protected endpoint', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      headers: authHeaders(validToken),
    });
    expect(res.status).toBe(200);
  });

  it('rejects historical external access tokens', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      headers: authHeaders(createTestToken('external', 'external')),
    });
    expect(res.status).toBe(403);
  });

  // ─── Public Paths ──────────────────────────────────────

  it('allows unauthenticated access to health endpoint', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
  });

  it('does not expose the removed auth-status route', async () => {
    const unauthenticated = await fetch(`${BASE_URL}/api/auth/status`);
    expect(unauthenticated.status).toBe(401);
    const authenticated = await fetch(`${BASE_URL}/api/auth/status`, { headers: authHeaders(validToken) });
    expect(authenticated.status).toBe(404);
  });

  it('allows unauthenticated access to frontend root', async () => {
    const res = await fetch(`${BASE_URL}/`);
    // May be 200 (frontend built) or 404 (not built)
    expect([200, 404]).toContain(res.status);
  });

  it('does not expose the removed external-login route', async () => {
    // The rate-limit suite intentionally exhausts the default login-IP bucket.
    // Use a dedicated documentation-range address so this route-removal check
    // remains deterministic without weakening its expected auth responses.
    const requestIp = '192.0.2.250';
    const unauthenticated = await fetch(`${BASE_URL}/api/auth/login/external`, {
      method: 'POST',
      headers: { 'x-forwarded-for': requestIp },
    });
    expect(unauthenticated.status).toBe(401);

    const authenticated = await fetch(`${BASE_URL}/api/auth/login/external`, {
      method: 'POST',
      headers: { ...authHeaders(validToken), 'x-forwarded-for': requestIp },
    });
    expect(authenticated.status).toBe(404);
  });

  it('does not mount the removed /api/v1 surface', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(validToken),
    });
    expect(res.status).toBe(404);
  });
});

describe('E2E: Authorization — Profile Access Control', () => {
  let validToken: string;

  beforeAll(async () => {
    validToken = await getValidToken();
  });

  it('defaults new internal sessions to the default preset', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(validToken),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    // No profile_id in the body → the default preset.
    expect(data.profile_id).toBe('sprouty');
    // Cleanup
    await fetch(`${BASE_URL}/api/sessions/${data.id}`, {
      method: 'DELETE',
      headers: authHeaders(validToken),
    });
  });

  it('rejects non-existent profile in stateless chat', async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: authHeaders(validToken),
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test' }],
        profile_id: 'nonexistent-profile',
      }),
    });
    // 400 (invalid profile), 403 (access denied), or 429 (rate limited in test suite)
    expect([400, 403, 429]).toContain(res.status);
  });

  it('session detail does not expose system prompts to unauthenticated users', async () => {
    // Create a session first
    const createRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(validToken),
    });
    const session = await createRes.json();

    // Try to access without auth
    const detailRes = await fetch(`${BASE_URL}/api/sessions/${session.id}`);
    expect(detailRes.status).toBe(401);
  });
});
