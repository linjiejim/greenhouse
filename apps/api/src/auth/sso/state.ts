/**
 * SSO state — stateless HMAC-signed round-trip token (CSRF guard).
 *
 * Carried through the IdP redirect as the OAuth `state` parameter. Signed with
 * TOKEN_SIGNING_KEY under a dedicated purpose so it can never validate as an
 * access/refresh token. Self-contained (no server-side store); replay within
 * the 10-minute window is bounded by the IdP's single-use `code`.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hmacWithPurpose } from '../token.js';

const STATE_TTL_SECONDS = 10 * 60;
const STATE_PURPOSE = 'sso-state';

export interface SsoStatePayload {
  /** Provider id the flow was started for — must match the callback route. */
  provider: string;
  /** Flow purpose: log in with a bound identity vs. bind to the current user. */
  purpose: 'login' | 'bind';
  /** Binding target user id (purpose=bind only), taken from the authed session. */
  uid?: string;
  /** In-app path (+hash) to land on afterwards. Validated relative-only. */
  redirect?: string;
  /** Random nonce so identical flows never produce identical states. */
  nonce: string;
  /** Expiry (unix seconds). */
  exp: number;
}

export function signSsoState(input: Omit<SsoStatePayload, 'nonce' | 'exp'>): string {
  const payload: SsoStatePayload = {
    ...input,
    nonce: randomBytes(8).toString('hex'),
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
  };
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadStr}.${hmacWithPurpose(payloadStr, STATE_PURPOSE)}`;
}

/** Validate and decode a state token. Returns null if tampered or expired. */
export function verifySsoState(raw: string): SsoStatePayload | null {
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [payloadStr, sig] = parts;
  const expected = hmacWithPurpose(payloadStr, STATE_PURPOSE);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString()) as SsoStatePayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.purpose !== 'login' && payload.purpose !== 'bind') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Only allow in-app relative redirects ("/..." but not "//host" or "/\host").
 * Anything else falls back to "/" — the callback must never become an open
 * redirector.
 */
export function sanitizeRedirect(redirect: string | undefined): string {
  if (!redirect) return '/';
  if (!redirect.startsWith('/')) return '/';
  if (redirect.startsWith('//') || redirect.startsWith('/\\')) return '/';
  return redirect;
}
