/**
 * Shared E2E test helpers.
 *
 * Centralizes token generation and common utilities used across all E2E test files.
 * If the token signing algorithm changes in the API, only this file needs updating.
 */

import { createHmac } from 'node:crypto';

const BASE_URL = `http://localhost:${process.env.API_PORT || 3999}`;
const PASSWORD = process.env.ACCESS_PASSWORD || 'test-secret';
// Must match the TOKEN_SIGNING_KEY the server under test was started with
// (there is no ACCESS_PASSWORD-derived fallback — the server requires the env var).
const TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY || 'test-secret';

/**
 * Create a test JWT-like token with HMAC-SHA256 signature.
 * Mirrors the signing logic in `apps/api/src/auth/token.ts`.
 */
export function createTestToken(uid: string, role: string): string {
  const payload = {
    uid,
    role,
    exp: Math.floor(Date.now() / 1000) + 4 * 60 * 60,
  };
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', `${TOKEN_SIGNING_KEY}:access`).update(payloadStr).digest('hex');
  return `${payloadStr}.${sig}`;
}

/** Build Authorization + Content-Type headers for a token. */
export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export { BASE_URL, PASSWORD };
