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
  uid: string; // user UUID
  role: UserRole;
  authVersion: number; // credential generation; must match users.auth_version
  exp: number; // expiry timestamp (seconds)
}

export interface AuthUser {
  id: string; // user UUID
  role: UserRole;
  nickname?: string;
}

// ─── TTL Configuration ──────────────────────────────────

const ACCESS_TOKEN_TTL = 4 * 60 * 60; // 4 hours
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days

export { ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL };

// ─── Signing Key ─────────────────────────────────────────

/**
 * Get the token signing key.
 *
 * TOKEN_SIGNING_KEY is mandatory — there is deliberately NO fallback.
 * Keep it independent from the interactive login password so rotating either
 * secret does not silently change the other security boundary.
 */
export function isValidTokenSigningKey(value: string | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

function getSigningKey(): string {
  const dedicated = process.env.TOKEN_SIGNING_KEY;
  if (!isValidTokenSigningKey(dedicated)) {
    throw new Error(
      'TOKEN_SIGNING_KEY must be exactly 64 hexadecimal characters (32 bytes). ' +
        'Generate one with: openssl rand -hex 32.',
    );
  }
  return dedicated;
}

/**
 * Fail fast when required authentication secrets are absent. Called once from
 * main() before the server binds. There is no middleware bypass when the key is
 * absent; this guard provides an earlier, clearer startup failure. A dedicated
 * TOKEN_SIGNING_KEY is mandatory everywhere (local, dev, prod), with no fallback.
 *
 * The guard deliberately does NOT depend on NODE_ENV: a deploy that forgets
 * NODE_ENV=production still cannot boot wide-open.
 */
export function assertAuthEnv(): void {
  getSigningKey();
}

function hmac(data: string, purpose: string): string {
  return createHmac('sha256', `${getSigningKey()}:${purpose}`).update(data).digest('hex');
}

/**
 * Purpose-scoped HMAC over the shared signing key, for sibling token modules
 * (e.g. auth/task-token.ts). Distinct purposes make token families mutually
 * unverifiable — a cloud-agent task token can never pass as an access token.
 */
export function hmacSign(data: string, purpose: string): string {
  return hmac(data, purpose);
}

// ─── Access Token ────────────────────────────────────────

/**
 * Create a signed access token carrying user identity.
 */
export function createAccessToken(uid: string, role: UserRole, authVersion: number): string {
  if (!Number.isInteger(authVersion) || authVersion < 0) {
    throw new Error('authVersion must be a non-negative integer');
  }
  const payload: TokenPayload = {
    uid,
    role,
    authVersion,
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
  if (!/^[0-9a-f]{64}$/i.test(sig)) return null;
  const expectedSig = hmac(payloadStr, 'access');

  if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString()) as Partial<TokenPayload>;
    if (typeof payload.uid !== 'string' || payload.uid.length === 0) return null;
    if (payload.role !== 'super' && payload.role !== 'team' && payload.role !== 'external') return null;
    if (typeof payload.authVersion !== 'number' || !Number.isInteger(payload.authVersion) || payload.authVersion < 0)
      return null;
    if (typeof payload.exp !== 'number' || !Number.isInteger(payload.exp)) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload as TokenPayload;
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
