/**
 * Access tokens are `<base64url(payload)>.<hmac>`; refresh tokens and one-time links are
 * random and stored only as keyed hashes. Each token family signs with its own purpose,
 * so one can never pass as another.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MemberRole } from '@greenhouse/db';

export const ACCESS_TOKEN_TTL_SECONDS = 4 * 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface AccessClaims {
  sub: string;
  role: MemberRole;
  /** Must equal members.auth_version, so a password change revokes every token. */
  ver: number;
  exp: number;
}

export interface Tokens {
  createAccessToken(memberId: string, role: MemberRole, authVersion: number, now?: number): string;
  verifyAccessToken(token: string, now?: number): AccessClaims | null;
  newSecret(): string;
  hashSecret(secret: string, purpose: 'refresh' | 'link'): string;
}

export function createTokens(signingKey: string): Tokens {
  const mac = (data: string, purpose: string) =>
    createHmac('sha256', `${signingKey}:${purpose}`).update(data).digest('base64url');

  return {
    createAccessToken(memberId, role, authVersion, now = Date.now()) {
      const claims: AccessClaims = {
        sub: memberId,
        role,
        ver: authVersion,
        exp: Math.floor(now / 1000) + ACCESS_TOKEN_TTL_SECONDS,
      };
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return `${payload}.${mac(payload, 'access')}`;
    },

    verifyAccessToken(token, now = Date.now()) {
      const [payload, signature, extra] = token.split('.');
      if (!payload || !signature || extra !== undefined) return null;
      const expected = Buffer.from(mac(payload, 'access'));
      const actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<AccessClaims>;
        if (typeof claims.sub !== 'string' || !claims.sub) return null;
        if (claims.role !== 'admin' && claims.role !== 'member') return null;
        if (!Number.isInteger(claims.ver) || (claims.ver as number) < 0) return null;
        if (!Number.isInteger(claims.exp) || (claims.exp as number) <= Math.floor(now / 1000)) return null;
        return claims as AccessClaims;
      } catch {
        return null;
      }
    },

    newSecret: () => randomBytes(32).toString('base64url'),

    hashSecret: (secret, purpose) => mac(secret, purpose),
  };
}
