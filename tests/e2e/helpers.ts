/**
 * Shared E2E test helpers.
 *
 * Centralizes token generation and common utilities used across all E2E test files.
 * If the token signing algorithm changes in the API, only this file needs updating.
 */

import { createHmac } from 'node:crypto';

const BASE_URL = `http://127.0.0.1:${process.env.API_PORT || 3999}`;
// Must match the TOKEN_SIGNING_KEY the server under test was started with
const TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY || '66'.repeat(32);

/**
 * Create a test JWT-like token with HMAC-SHA256 signature.
 * Mirrors the signing logic in `apps/api/src/auth/token.ts`.
 */
export function createTestToken(uid: string, role: string, authVersion = 0): string {
  const payload = {
    uid,
    role,
    authVersion,
    exp: Math.floor(Date.now() / 1000) + 4 * 60 * 60,
  };
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', `${TOKEN_SIGNING_KEY}:access`).update(payloadStr).digest('hex');
  return `${payloadStr}.${sig}`;
}

/** Create a token for the active super user seeded by scripts/e2e-ci.sh. */
export function createSuperToken(): string {
  const userId = process.env.E2E_SUPER_USER_ID;
  if (!userId) {
    throw new Error(
      'E2E_SUPER_USER_ID is required. Run through pnpm test:e2e:ci or seed a real test user as documented in tests/e2e/README.md.',
    );
  }
  return createTestToken(userId, 'super');
}

/** Build Authorization + Content-Type headers for a token. */
export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export { BASE_URL };
