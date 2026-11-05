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

export const EXT_UI_TOKEN_TTL = 10 * 60;
export interface ExtUiTokenPayload extends TokenPayload {
  plugin: string;
}

/** Purpose-separated credentials can never be accepted as interactive sessions. */
export function createExtUiToken(uid: string, role: UserRole, authVersion: number, plugin: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(plugin) || !Number.isInteger(authVersion) || authVersion < 0)
    throw new Error('Invalid embed token claims');
  const exp = Math.floor(Date.now() / 1000) + EXT_UI_TOKEN_TTL;
  const data = Buffer.from(JSON.stringify({ uid, role, authVersion, plugin, exp })).toString('base64url');
  return { token: `${data}.${hmac(data, 'ext-ui')}`, expires_at: new Date(exp * 1000).toISOString() };
}

export function validateExtUiToken(token: string): ExtUiTokenPayload | null {
  const [data, sig, extra] = token.split('.');
  if (!data || !sig || extra !== undefined || !/^[a-f0-9]{64}$/i.test(sig)) return null;
  if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(hmac(data, 'ext-ui'), 'hex'))) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString());
    return typeof p.uid === 'string' &&
      p.uid.length &&
      (p.role === 'team' || p.role === 'super') &&
      Number.isInteger(p.authVersion) &&
      p.authVersion >= 0 &&
      Number.isInteger(p.exp) &&
      p.exp > Math.floor(Date.now() / 1000) &&
      typeof p.plugin === 'string' &&
      /^[a-z][a-z0-9-]*$/.test(p.plugin)
      ? p
      : null;
  } catch {
    return null;
  }
}

/**
 * A plugin object ticket: the capability behind `/api/ext-objects/<ticket>` when the object
 * backend cannot presign (local disk, S3 without STORAGE_S3_PRESIGN). Like a presigned URL it
 * names one object, one operation and an expiry, and carries no member credential.
 */
export interface ObjectTicket {
  /** Owning plugin id. */
  p: string;
  /** Key inside the plugin's namespace. */
  k: string;
  /** `r` read, `u` upload. */
  o: 'r' | 'u';
  /** Expiry, unix seconds. */
  e: number;
  /** Upload: byte ceiling. */
  m?: number;
  /** Upload: required Content-Type. Read: served Content-Type. */
  t?: string;
  /** Read: `i` inline, `a` attachment. */
  d?: 'i' | 'a';
  /** Read, attachment: download file name. */
  f?: string;
}

export function createObjectTicket(claims: ObjectTicket): string {
  const data = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${data}.${hmac(data, 'ext-objects')}`;
}

export function validateObjectTicket(ticket: string): ObjectTicket | null {
  const [data, sig, extra] = ticket.split('.');
  if (!data || !sig || extra !== undefined || !/^[a-f0-9]{64}$/i.test(sig)) return null;
  if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(hmac(data, 'ext-objects'), 'hex'))) return null;
  try {
    const t = JSON.parse(Buffer.from(data, 'base64url').toString()) as ObjectTicket;
    const ok =
      typeof t.p === 'string' &&
      /^[a-z][a-z0-9-]*$/.test(t.p) &&
      typeof t.k === 'string' &&
      (t.o === 'r' || t.o === 'u') &&
      Number.isInteger(t.e) &&
      t.e > Math.floor(Date.now() / 1000) &&
      (t.o === 'r' || (Number.isSafeInteger(t.m) && typeof t.t === 'string'));
    return ok ? t : null;
  } catch {
    return null;
  }
}

/**
 * What a plugin embed token may call: its own `/api/ext/<id>/…`, the member's basic profile, the
 * member directory for owner pickers, and the drive folder/file routes, where drive access then
 * admits only the scopes this plugin declared (routes/drive.ts `accessFor`). Drive search and the
 * cabinet selector stay out of reach.
 */
export function extUiPathAllowed(plugin: string, method: string, path: string): boolean {
  // Refuse encoded separators/traversal rather than relying on a router's decoding order.
  if (/[%\\\\]/.test(path) || path.split('/').some((s) => s === '.' || s === '..')) return false;
  if (path === '/api/me' || path === '/api/people') return method === 'GET';
  if (path === '/api/people/resolve') return method === 'POST';
  if (/^\/api\/drive\/(folders|files|breadcrumb)(\/|$)/.test(path)) return true;
  // Object tickets authorize themselves; a frame that attaches its token anyway is not refused.
  if (path.startsWith('/api/ext-objects/')) return method === 'GET' || method === 'HEAD' || method === 'PUT';
  return path.startsWith(`/api/ext/${plugin}/`);
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
