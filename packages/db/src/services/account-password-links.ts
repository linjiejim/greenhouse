/**
 * One-time account setup and password reset links.
 *
 * Every mutating path locks the user row before touching link rows. That lock
 * order serializes issue/resend/revoke/consume/disable without deadlocks, and
 * the partial unique index is a second line of defence against two current
 * links for one user.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { accountPasswordLinks, refreshTokens, users } from '../schema/index.js';
import type { AccountPasswordLinkPurpose, AccountPasswordLinkRow, UserRow } from '../schema/user.js';

export const UNSET_ACCOUNT_PASSWORD_HASH = '!account-password-not-set!';
export const INVITE_LINK_TTL_MS = 72 * 60 * 60 * 1000;
export const RESET_LINK_TTL_MS = 30 * 60 * 1000;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface IssuedAccountPasswordLink {
  link: AccountPasswordLinkRow;
  token: string;
  user: UserRow;
}

export interface InspectedAccountPasswordLink {
  link: AccountPasswordLinkRow;
  user: UserRow;
}

export interface CompletedAccountPasswordLink extends InspectedAccountPasswordLink {
  user: UserRow;
}

export function generateAccountPasswordToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashAccountPasswordToken(token: string): string | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function expiresAtFor(purpose: AccountPasswordLinkPurpose): string {
  const ttl = purpose === 'invite' ? INVITE_LINK_TTL_MS : RESET_LINK_TTL_MS;
  return new Date(Date.now() + ttl).toISOString();
}

function stateMatchesPurpose(user: UserRow, purpose: AccountPasswordLinkPurpose): boolean {
  return (
    user.role !== 'external' &&
    ((purpose === 'invite' && user.status === 'invited') || (purpose === 'reset' && user.status === 'reset_required'))
  );
}

function isUsable(link: AccountPasswordLinkRow, user: UserRow, now: string): boolean {
  return (
    link.user_id === user.id &&
    link.consumed_at === null &&
    link.revoked_at === null &&
    // postgres.js returns timestamptz strings with a space/+00 form, while
    // nowIso() uses T/Z. Lexicographic comparison rejects same-day reset links
    // because " " sorts before "T"; compare instants instead.
    new Date(link.expires_at).getTime() > new Date(now).getTime() &&
    link.issued_auth_version === user.auth_version &&
    stateMatchesPurpose(user, link.purpose)
  );
}

export function createAccountPasswordLinkService(db: Db) {
  async function issueLocked(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    user: UserRow,
    purpose: AccountPasswordLinkPurpose,
    createdBy: string,
    expiresAt?: string,
  ): Promise<IssuedAccountPasswordLink> {
    const now = nowIso();
    await tx
      .update(accountPasswordLinks)
      .set({ revoked_at: now })
      .where(
        and(
          eq(accountPasswordLinks.user_id, user.id),
          isNull(accountPasswordLinks.consumed_at),
          isNull(accountPasswordLinks.revoked_at),
        ),
      );

    const token = generateAccountPasswordToken();
    const rows = await tx
      .insert(accountPasswordLinks)
      .values({
        id: randomUUID(),
        user_id: user.id,
        purpose,
        token_hash: hashAccountPasswordToken(token)!,
        issued_auth_version: user.auth_version,
        expires_at: expiresAt ?? expiresAtFor(purpose),
        created_by: createdBy,
        created_at: now,
      })
      .returning();
    return { link: rows[0]!, token, user };
  }

  async function lockUser(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    userId: string,
  ): Promise<UserRow | undefined> {
    const rows = await tx.select().from(users).where(eq(users.id, userId)).limit(1).for('update');
    return rows[0];
  }

  const service = {
    async issueInvite(
      userId: string,
      createdBy: string,
      expiresAt?: string,
    ): Promise<IssuedAccountPasswordLink | null> {
      return db.transaction(async (tx) => {
        const user = await lockUser(tx, userId);
        if (!user || user.status !== 'invited' || user.role === 'external') return null;
        return issueLocked(tx, user, 'invite', createdBy, expiresAt);
      });
    },

    /**
     * Enter reset-required state and issue a link in the same transaction.
     * Reissuing while already reset-required preserves the current generation;
     * the first transition is the one that invalidates every old credential.
     */
    async issueReset(userId: string, createdBy: string, expiresAt?: string): Promise<IssuedAccountPasswordLink | null> {
      return db.transaction(async (tx) => {
        let user = await lockUser(tx, userId);
        if (!user || user.role === 'external' || (user.status !== 'active' && user.status !== 'reset_required')) {
          return null;
        }

        if (user.status === 'active') {
          const rows = await tx
            .update(users)
            .set({
              password_hash: UNSET_ACCOUNT_PASSWORD_HASH,
              status: 'reset_required',
              auth_version: sql`${users.auth_version} + 1`,
              updated_at: nowIso(),
            })
            .where(eq(users.id, userId))
            .returning();
          user = rows[0]!;
          await tx.delete(refreshTokens).where(eq(refreshTokens.user_id, userId));
        }

        return issueLocked(tx, user, 'reset', createdBy, expiresAt);
      });
    },

    async resend(userId: string, createdBy: string): Promise<IssuedAccountPasswordLink | null> {
      return db.transaction(async (tx) => {
        const user = await lockUser(tx, userId);
        if (!user || user.role === 'external') return null;
        if (user.status === 'invited') return issueLocked(tx, user, 'invite', createdBy);
        if (user.status === 'reset_required') return issueLocked(tx, user, 'reset', createdBy);
        return null;
      });
    },

    async inspect(token: string): Promise<InspectedAccountPasswordLink | null> {
      const tokenHash = hashAccountPasswordToken(token);
      if (!tokenHash) return null;
      const rows = await db
        .select({ link: accountPasswordLinks, user: users })
        .from(accountPasswordLinks)
        .innerJoin(users, eq(users.id, accountPasswordLinks.user_id))
        .where(eq(accountPasswordLinks.token_hash, tokenHash))
        .limit(1);
      const candidate = rows[0];
      if (!candidate || !isUsable(candidate.link, candidate.user, nowIso())) return null;
      return candidate;
    },

    async complete(token: string, passwordHash: string): Promise<CompletedAccountPasswordLink | null> {
      const tokenHash = hashAccountPasswordToken(token);
      if (!tokenHash) return null;

      // Read only enough to establish the global user → link lock order. Every
      // property is re-read and validated under locks inside the transaction.
      const candidateRows = await db
        .select({ user_id: accountPasswordLinks.user_id })
        .from(accountPasswordLinks)
        .where(eq(accountPasswordLinks.token_hash, tokenHash))
        .limit(1);
      const candidate = candidateRows[0];
      if (!candidate) return null;

      return db.transaction(async (tx) => {
        const user = await lockUser(tx, candidate.user_id);
        if (!user) return null;
        const linkRows = await tx
          .select()
          .from(accountPasswordLinks)
          .where(eq(accountPasswordLinks.token_hash, tokenHash))
          .limit(1)
          .for('update');
        const link = linkRows[0];
        const now = nowIso();
        if (!link || !isUsable(link, user, now)) return null;

        const userRows = await tx
          .update(users)
          .set({
            password_hash: passwordHash,
            status: 'active',
            auth_version: sql`${users.auth_version} + 1`,
            updated_at: now,
          })
          .where(eq(users.id, user.id))
          .returning();
        const activated = userRows[0]!;
        await tx.delete(refreshTokens).where(eq(refreshTokens.user_id, user.id));
        await tx.update(accountPasswordLinks).set({ consumed_at: now }).where(eq(accountPasswordLinks.id, link.id));
        await tx
          .update(accountPasswordLinks)
          .set({ revoked_at: now })
          .where(
            and(
              eq(accountPasswordLinks.user_id, user.id),
              isNull(accountPasswordLinks.consumed_at),
              isNull(accountPasswordLinks.revoked_at),
            ),
          );
        return { link: { ...link, consumed_at: now }, user: activated };
      });
    },

    async revokeCurrent(userId: string): Promise<AccountPasswordLinkRow | null> {
      return db.transaction(async (tx) => {
        const user = await lockUser(tx, userId);
        if (!user) return null;
        const now = nowIso();
        const rows = await tx
          .update(accountPasswordLinks)
          .set({ revoked_at: now })
          .where(
            and(
              eq(accountPasswordLinks.user_id, userId),
              isNull(accountPasswordLinks.consumed_at),
              isNull(accountPasswordLinks.revoked_at),
            ),
          )
          .returning();
        return rows[0] ?? null;
      });
    },

    async listCurrent(): Promise<AccountPasswordLinkRow[]> {
      return db
        .select()
        .from(accountPasswordLinks)
        .where(and(isNull(accountPasswordLinks.consumed_at), isNull(accountPasswordLinks.revoked_at)))
        .orderBy(desc(accountPasswordLinks.created_at));
    },

    async markDelivery(
      linkId: string,
      status: 'sent' | 'failed',
      error?: string,
    ): Promise<AccountPasswordLinkRow | undefined> {
      const rows = await db
        .update(accountPasswordLinks)
        .set({
          delivery_status: status,
          sent_at: status === 'sent' ? nowIso() : null,
          delivery_error: status === 'failed' ? (error ?? 'Unknown delivery error').slice(0, 2000) : null,
        })
        .where(eq(accountPasswordLinks.id, linkId))
        .returning();
      return rows[0];
    },

    async cleanupExpired(): Promise<number> {
      const rows = await db
        .update(accountPasswordLinks)
        .set({ revoked_at: nowIso() })
        .where(
          and(
            isNull(accountPasswordLinks.consumed_at),
            isNull(accountPasswordLinks.revoked_at),
            sql`${accountPasswordLinks.expires_at} <= ${nowIso()}`,
          ),
        )
        .returning({ id: accountPasswordLinks.id });
      return rows.length;
    },
  };

  return service;
}

export type AccountPasswordLinkService = ReturnType<typeof createAccountPasswordLinkService>;
