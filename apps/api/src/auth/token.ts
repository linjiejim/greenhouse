/**
 * Token management — HMAC-signed access tokens + opaque refresh tokens.
 *
 * Access token format: "<base64url(payload)>.<hmac_sha256>"
 * Refresh token format: random hex string (hash stored in DB)
 *
 * No external dependencies (uses Node.js crypto).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ─── Types ───────────────────────────────────────────────

export type UserRole = 'super' | 'team' | 'external';

export interface TokenPayload {
  uid: string; // user UUID or 'external'
  role: UserRole;
  exp: number; // expiry timestamp (seconds)
}

export interface AuthUser {
  id: string; // user UUID or 'external'
  role: UserRole;
  nickname?: string;
}

// ─── TTL Configuration ──────────────────────────────────

const ACCESS_TOKEN_TTL = 4 * 60 * 60; // 4 hours
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days

export { ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL };

// ─── Signing Key ─────────────────────────────────────────

/**
 * Get the access password (used for external user login).
 */
function getAccessPassword(): string {
  const secret = process.env.ACCESS_PASSWORD;
  if (!secret) throw new Error('ACCESS_PASSWORD env var is required');
  return secret;
}

/**
 * Get the token signing key.
 *
 * TOKEN_SIGNING_KEY is mandatory — there is deliberately NO fallback.
 * ACCESS_PASSWORD is handed to external guests, so any key derived from it
 * would let a guest forge arbitrary tokens (including role=super) offline.
 */
function getSigningKey(): string {
  const dedicated = process.env.TOKEN_SIGNING_KEY;
  if (!dedicated) {
    throw new Error(
      'TOKEN_SIGNING_KEY env var is required. Generate one with: openssl rand -hex 32 ' +
        '(it must be an independent random value, never derived from ACCESS_PASSWORD).',
    );
  }
  return dedicated;
}

/**
 * Fail fast at startup when the server would otherwise come up with
 * authentication DISABLED. Called once from main() before the server binds.
 *
 * When ACCESS_PASSWORD is unset, authMiddleware treats EVERY request as a
 * super-user — on any shared or internet-exposed host that is a full auth
 * bypass. So the server FAILS CLOSED: ACCESS_PASSWORD is mandatory everywhere
 * (local, dev, prod) and the server refuses to start without it. When a password
 * is set, a dedicated TOKEN_SIGNING_KEY is also mandatory (no fallback).
 *
 * The guard deliberately does NOT depend on NODE_ENV: a deploy that forgets
 * NODE_ENV=production still cannot boot wide-open.
 */
export function assertAuthEnv(): void {
  if (!process.env.ACCESS_PASSWORD) {
    throw new Error(
      'Refusing to start: ACCESS_PASSWORD is not set, so authentication would be DISABLED ' +
        'and every request would be granted super-user access. Set ACCESS_PASSWORD and ' +
        'TOKEN_SIGNING_KEY (required in every environment — local, dev, and production).',
    );
  }
  getSigningKey(); // auth enabled ⇒ dedicated signing key is mandatory
}

function hmac(data: string, purpose: string): string {
  return createHmac('sha256', `${getSigningKey()}:${purpose}`).update(data).digest('hex');
}

// ─── Access Token ────────────────────────────────────────

/**
 * Create a signed access token carrying user identity.
 */
export function createAccessToken(uid: string, role: UserRole): string {
  const payload: TokenPayload = {
    uid,
    role,
    exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL,
  };
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = hmac(payloadStr, 'access');
  return `${payloadStr}.${sig}`;
}

/**
 * Validate and decode an access token.
 * Returns null if invalid or expired.
 */
export function validateAccessToken(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadStr, sig] = parts;
  const expectedSig = hmac(payloadStr, 'access');

  if (sig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString()) as TokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Refresh Token ───────────────────────────────────────

/**
 * Generate a new refresh token and its hash for DB storage.
 */
export function createRefreshToken(): { raw: string; hash: string; expiresAt: string } {
  const raw = randomBytes(32).toString('hex');
  const hash = hashRefreshToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString();
  return { raw, hash, expiresAt };
}

/**
 * Hash a refresh token for DB storage/lookup.
 */
export function hashRefreshToken(raw: string): string {
  return createHmac('sha256', `${getSigningKey()}:refresh`).update(raw).digest('hex');
}

// ─── Legacy Token (transition only) ─────────────────────

/**
 * Validate old-format tokens during transition period.
 * Format: "<expiry_hex>.<hmac>"
 * Returns true if the token is valid AND not expired.
 */
export function validateLegacyToken(token: string): boolean {
  try {
    const key = getSigningKey();
    const parts = token.split('.');
    if (parts.length !== 2) return false;

    const [expiryHex, sig] = parts;
    const expectedSig = createHmac('sha256', key).update(expiryHex).digest('hex');

    if (sig.length !== expectedSig.length) return false;
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return false;

    const expiresAt = parseInt(expiryHex, 16);
    if (isNaN(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}

// ─── External User Password ─────────────────────────────

/**
 * Check if a password matches the ACCESS_PASSWORD (for external user login).
 * Uses timing-safe comparison to prevent timing side-channel attacks.
 */
export function verifyExternalPassword(password: string): boolean {
  try {
    const secret = getAccessPassword();
    const a = Buffer.from(password);
    const b = Buffer.from(secret);
    if (a.length !== b.length) {
      // Perform a dummy comparison to avoid leaking length info via timing
      timingSafeEqual(b, b);
      return false;
    }
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Check if auth is enabled (ACCESS_PASSWORD is set).
 */
/**
 * Check if auth is enabled (ACCESS_PASSWORD is set).
 * In production (NODE_ENV=production), ACCESS_PASSWORD is mandatory.
 */
export function isAuthEnabled(): boolean {
  const hasPassword = !!process.env.ACCESS_PASSWORD;
  if (!hasPassword && process.env.NODE_ENV === 'production') {
    throw new Error(
      'ACCESS_PASSWORD must be set in production. ' + 'Set ACCESS_PASSWORD env var or run in development mode.',
    );
  }
  return hasPassword;
}

/**
 * Create a short-lived internal access token for CLI / server self-calls.
 * Uses 'super' role since these are trusted internal callers.
 */
export function createInternalToken(): string {
  return createAccessToken('internal', 'super');
}
