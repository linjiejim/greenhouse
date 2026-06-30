/**
 * Refresh token service — refresh token persistence for seamless token renewal (PostgreSQL).
 */

import { randomUUID } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { refreshTokens } from '../schema/index.js';
import type { RefreshTokenRow } from '../schema/user.js';

export function createRefreshTokenService(db: Db) {
  const service = {
    /** Store a new refresh token. Returns the token ID. */
    async create(userId: string, tokenHash: string, expiresAt: string): Promise<string> {
      const id = randomUUID();
      await db.insert(refreshTokens).values({
        id,
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
        created_at: nowIso(),
      });
      return id;
    },

    /** Look up a non-expired token by its hash. Returns null if not found/expired. */
    async validate(tokenHash: string): Promise<RefreshTokenRow | null> {
      const now = nowIso();
      const rows = await db
        .select()
        .from(refreshTokens)
        .where(and(eq(refreshTokens.token_hash, tokenHash), sql`expires_at > ${now}`));
      return rows[0] ?? null;
    },

    /** Revoke a specific token. */
    async revoke(id: string): Promise<void> {
      await db.delete(refreshTokens).where(eq(refreshTokens.id, id));
    },

    /** Revoke all tokens for a user (e.g. on password change). */
    async revokeAllForUser(userId: string): Promise<void> {
      await db.delete(refreshTokens).where(eq(refreshTokens.user_id, userId));
    },

    /** Delete expired tokens (periodic cleanup). */
    async cleanup(): Promise<void> {
      const now = nowIso();
      await db.delete(refreshTokens).where(sql`expires_at <= ${now}`);
    },
  };
  return service;
}

export type RefreshTokenService = ReturnType<typeof createRefreshTokenService>;
