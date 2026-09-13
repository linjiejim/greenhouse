/**
 * Platform OAuth persistence.
 *
 * Protocol validation (redirect URI, PKCE, scopes and audience) lives in the
 * API layer. This service provides atomic one-time-code / refresh-token
 * consumption and durable grant revocation.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { safeJsonParse } from '@greenhouse/utils/json';

import type { Db } from '../client.js';
import {
  platformOAuthAuthorizationCodes,
  platformOAuthClients,
  platformOAuthGrants,
  platformOAuthTokens,
} from '../schema/index.js';
import type {
  PlatformOAuthAuthorizationCodeRow,
  PlatformOAuthClientRow,
  PlatformOAuthClientStatus,
  PlatformOAuthGrantRow,
  PlatformOAuthTokenRow,
} from '../schema/platform-oauth.js';

export interface PlatformOAuthClientInput {
  id: string;
  client_name: string;
  redirect_uris: string;
  created_by?: string;
}

export interface PlatformOAuthMachineClientInput {
  id: string;
  client_name: string;
  client_secret_hash: string;
  bound_user_id: string;
  allowed_scopes: string;
  created_by?: string;
}

export interface PlatformOAuthGrantInput {
  user_id: string;
  client_id: string;
  resource: string;
  scopes: string;
}

export interface PlatformOAuthAuthorizationCodeInput {
  code_hash: string;
  grant_id: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  scopes: string;
  code_challenge: string;
  expires_at: string;
}

export interface PlatformOAuthAuthorizationCodeConsumeInput {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  code_challenge: string;
}

export interface PlatformOAuthTokenInput {
  token_hash: string;
  token_type: PlatformOAuthTokenRow['token_type'];
  resource: string;
  scopes: string;
  expires_at: string;
}

export interface PlatformOAuthGrantWithClient {
  grant: PlatformOAuthGrantRow;
  client: PlatformOAuthClientRow;
}

export interface PlatformOAuthResolvedCode extends PlatformOAuthGrantWithClient {
  code: PlatformOAuthAuthorizationCodeRow;
}

export interface PlatformOAuthResolvedToken extends PlatformOAuthGrantWithClient {
  token: PlatformOAuthTokenRow;
}

function parseStoredStringSet(value: string): Set<string> | undefined {
  const parsed = safeJsonParse(value, null);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== 'string')) {
    return undefined;
  }
  return new Set(parsed);
}

function storedStringSetsEqual(left: string, right: string): boolean {
  const leftSet = parseStoredStringSet(left);
  const rightSet = parseStoredStringSet(right);
  if (!leftSet || !rightSet || leftSet.size !== rightSet.size) return false;
  return [...leftSet].every((item) => rightSet.has(item));
}

function storedStringSetIsSubset(requested: string, granted: string): boolean {
  const requestedSet = parseStoredStringSet(requested);
  const grantedSet = parseStoredStringSet(granted);
  if (!requestedSet || !grantedSet) return false;
  return [...requestedSet].every((item) => grantedSet.has(item));
}

export function createPlatformOAuthService(db: Db) {
  return {
    async registerClient(input: PlatformOAuthClientInput): Promise<PlatformOAuthClientRow> {
      const now = nowIso();
      const rows = await db
        .insert(platformOAuthClients)
        .values({
          id: input.id,
          client_name: input.client_name,
          redirect_uris: input.redirect_uris,
          token_endpoint_auth_method: 'none',
          created_by: input.created_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return rows[0]!;
    },

    async registerMachineClient(input: PlatformOAuthMachineClientInput): Promise<PlatformOAuthClientRow> {
      const now = nowIso();
      const rows = await db
        .insert(platformOAuthClients)
        .values({
          id: input.id,
          client_name: input.client_name,
          redirect_uris: '[]',
          token_endpoint_auth_method: 'client_secret_post',
          client_secret_hash: input.client_secret_hash,
          bound_user_id: input.bound_user_id,
          allowed_scopes: input.allowed_scopes,
          created_by: input.created_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return rows[0]!;
    },

    async rotateClientSecret(id: string, clientSecretHash: string): Promise<PlatformOAuthClientRow | undefined> {
      const rows = await db
        .update(platformOAuthClients)
        .set({ client_secret_hash: clientSecretHash, updated_at: nowIso() })
        .where(
          and(
            eq(platformOAuthClients.id, id),
            eq(platformOAuthClients.token_endpoint_auth_method, 'client_secret_post'),
          ),
        )
        .returning();
      return rows[0];
    },

    async deleteClient(id: string): Promise<boolean> {
      const rows = await db
        .delete(platformOAuthClients)
        .where(eq(platformOAuthClients.id, id))
        .returning({ id: platformOAuthClients.id });
      return rows.length > 0;
    },

    async listMachineClients(): Promise<PlatformOAuthClientRow[]> {
      return db
        .select()
        .from(platformOAuthClients)
        .where(eq(platformOAuthClients.token_endpoint_auth_method, 'client_secret_post'))
        .orderBy(desc(platformOAuthClients.created_at));
    },

    async getGrantByPrincipal(
      userId: string,
      clientId: string,
      resource: string,
    ): Promise<PlatformOAuthGrantRow | undefined> {
      const rows = await db
        .select()
        .from(platformOAuthGrants)
        .where(
          and(
            eq(platformOAuthGrants.user_id, userId),
            eq(platformOAuthGrants.client_id, clientId),
            eq(platformOAuthGrants.resource, resource),
          ),
        )
        .limit(1);
      return rows[0];
    },

    async getClient(id: string): Promise<PlatformOAuthClientRow | undefined> {
      const rows = await db.select().from(platformOAuthClients).where(eq(platformOAuthClients.id, id)).limit(1);
      return rows[0];
    },

    async listClients(): Promise<PlatformOAuthClientRow[]> {
      return db.select().from(platformOAuthClients).orderBy(desc(platformOAuthClients.created_at));
    },

    /** Active grant principals across all clients — who has authorized which client. */
    async listActiveGrantPrincipals(): Promise<Array<{ client_id: string; user_id: string }>> {
      return db
        .select({ client_id: platformOAuthGrants.client_id, user_id: platformOAuthGrants.user_id })
        .from(platformOAuthGrants)
        .where(eq(platformOAuthGrants.status, 'active'));
    },

    async setClientStatus(id: string, status: PlatformOAuthClientStatus): Promise<PlatformOAuthClientRow | undefined> {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(platformOAuthClients)
          .set({ status, updated_at: nowIso() })
          .where(eq(platformOAuthClients.id, id))
          .returning();
        if (rows[0] && status === 'disabled') {
          const grantRows = await tx
            .update(platformOAuthGrants)
            .set({ status: 'revoked', revoked_at: nowIso(), updated_at: nowIso() })
            .where(and(eq(platformOAuthGrants.client_id, id), eq(platformOAuthGrants.status, 'active')))
            .returning({ id: platformOAuthGrants.id });
          if (grantRows.length > 0) {
            await tx
              .update(platformOAuthTokens)
              .set({ revoked_at: nowIso() })
              .where(
                and(
                  isNull(platformOAuthTokens.revoked_at),
                  inArray(
                    platformOAuthTokens.grant_id,
                    grantRows.map((grant) => grant.id),
                  ),
                ),
              );
          }
        }
        return rows[0];
      });
    },

    async upsertGrant(input: PlatformOAuthGrantInput): Promise<PlatformOAuthGrantRow> {
      return db.transaction(async (tx) => {
        const now = nowIso();
        const principal = and(
          eq(platformOAuthGrants.user_id, input.user_id),
          eq(platformOAuthGrants.client_id, input.client_id),
          eq(platformOAuthGrants.resource, input.resource),
        );
        const existingRows = await tx.select().from(platformOAuthGrants).where(principal).limit(1).for('update');
        const existing = existingRows[0];

        const rows = await tx
          .insert(platformOAuthGrants)
          .values({
            id: randomUUID(),
            user_id: input.user_id,
            client_id: input.client_id,
            resource: input.resource,
            scopes: input.scopes,
            created_at: now,
            updated_at: now,
          })
          .onConflictDoUpdate({
            target: [platformOAuthGrants.user_id, platformOAuthGrants.client_id, platformOAuthGrants.resource],
            set: {
              scopes: input.scopes,
              status: 'active',
              revoked_at: null,
              updated_at: now,
            },
          })
          .returning();
        const grant = rows[0]!;

        // A changed/re-activated grant replaces the previous credential set.
        // The no-existing branch also revokes defensively: an INSERT conflict
        // there means another transaction created this principal concurrently.
        const credentialsMustBeRevoked =
          !existing || existing.status !== 'active' || !storedStringSetsEqual(existing.scopes, input.scopes);
        if (credentialsMustBeRevoked) {
          await tx
            .update(platformOAuthTokens)
            .set({ revoked_at: now })
            .where(and(eq(platformOAuthTokens.grant_id, grant.id), isNull(platformOAuthTokens.revoked_at)));
          await tx
            .update(platformOAuthAuthorizationCodes)
            .set({ used_at: now })
            .where(
              and(
                eq(platformOAuthAuthorizationCodes.grant_id, grant.id),
                isNull(platformOAuthAuthorizationCodes.used_at),
              ),
            );
        }
        return grant;
      });
    },

    async listUserGrants(userId: string): Promise<PlatformOAuthGrantWithClient[]> {
      return db
        .select({ grant: platformOAuthGrants, client: platformOAuthClients })
        .from(platformOAuthGrants)
        .innerJoin(platformOAuthClients, eq(platformOAuthClients.id, platformOAuthGrants.client_id))
        .where(eq(platformOAuthGrants.user_id, userId))
        .orderBy(desc(platformOAuthGrants.updated_at));
    },

    async revokeGrant(id: string, userId?: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const now = nowIso();
        const rows = await tx
          .update(platformOAuthGrants)
          .set({ status: 'revoked', revoked_at: now, updated_at: now })
          .where(
            userId
              ? and(eq(platformOAuthGrants.id, id), eq(platformOAuthGrants.user_id, userId))
              : eq(platformOAuthGrants.id, id),
          )
          .returning({ id: platformOAuthGrants.id });
        if (!rows[0]) return false;
        await tx
          .update(platformOAuthTokens)
          .set({ revoked_at: now })
          .where(and(eq(platformOAuthTokens.grant_id, id), isNull(platformOAuthTokens.revoked_at)));
        return true;
      });
    },

    async createAuthorizationCode(
      input: PlatformOAuthAuthorizationCodeInput,
    ): Promise<PlatformOAuthAuthorizationCodeRow> {
      const rows = await db
        .insert(platformOAuthAuthorizationCodes)
        .values({
          ...input,
          code_challenge_method: 'S256',
          created_at: nowIso(),
        })
        .returning();
      return rows[0]!;
    },

    async consumeAuthorizationCode(
      input: PlatformOAuthAuthorizationCodeConsumeInput,
    ): Promise<PlatformOAuthResolvedCode | undefined> {
      const now = nowIso();
      const codes = await db
        .update(platformOAuthAuthorizationCodes)
        .set({ used_at: now })
        .where(
          and(
            eq(platformOAuthAuthorizationCodes.code_hash, input.code_hash),
            eq(platformOAuthAuthorizationCodes.client_id, input.client_id),
            eq(platformOAuthAuthorizationCodes.redirect_uri, input.redirect_uri),
            eq(platformOAuthAuthorizationCodes.resource, input.resource),
            eq(platformOAuthAuthorizationCodes.code_challenge, input.code_challenge),
            isNull(platformOAuthAuthorizationCodes.used_at),
            gt(platformOAuthAuthorizationCodes.expires_at, now),
          ),
        )
        .returning();
      const code = codes[0];
      if (!code) return undefined;
      const grants = await db
        .select({ grant: platformOAuthGrants, client: platformOAuthClients })
        .from(platformOAuthGrants)
        .innerJoin(platformOAuthClients, eq(platformOAuthClients.id, platformOAuthGrants.client_id))
        .where(eq(platformOAuthGrants.id, code.grant_id))
        .limit(1);
      return grants[0] ? { code, ...grants[0] } : undefined;
    },

    async createTokenPair(
      grantId: string,
      access: PlatformOAuthTokenInput,
      refresh: PlatformOAuthTokenInput,
    ): Promise<{ access: PlatformOAuthTokenRow; refresh: PlatformOAuthTokenRow } | undefined> {
      return db.transaction(async (tx) => {
        // Serialize token issuance with grant scope/revocation changes. This
        // closes the race where a code/refresh was validated just before the
        // grant was narrowed but its new token pair was inserted afterwards.
        const grantRows = await tx
          .select()
          .from(platformOAuthGrants)
          .where(eq(platformOAuthGrants.id, grantId))
          .limit(1)
          .for('update');
        const grant = grantRows[0];
        if (
          !grant ||
          grant.status !== 'active' ||
          grant.revoked_at !== null ||
          access.token_type !== 'access' ||
          refresh.token_type !== 'refresh' ||
          access.resource !== grant.resource ||
          refresh.resource !== grant.resource ||
          !storedStringSetIsSubset(access.scopes, grant.scopes) ||
          !storedStringSetIsSubset(refresh.scopes, grant.scopes) ||
          !storedStringSetsEqual(access.scopes, refresh.scopes)
        ) {
          return undefined;
        }

        const now = nowIso();
        const rows = await tx
          .insert(platformOAuthTokens)
          .values([
            { id: randomUUID(), grant_id: grantId, ...access, created_at: now },
            { id: randomUUID(), grant_id: grantId, ...refresh, created_at: now },
          ])
          .returning();
        return {
          access: rows.find((row) => row.token_type === 'access')!,
          refresh: rows.find((row) => row.token_type === 'refresh')!,
        };
      });
    },

    /**
     * Issue a single access token (client_credentials — no refresh token).
     * Same grant-serialization guard as createTokenPair.
     */
    async createAccessToken(
      grantId: string,
      access: PlatformOAuthTokenInput,
    ): Promise<PlatformOAuthTokenRow | undefined> {
      return db.transaction(async (tx) => {
        const grantRows = await tx
          .select()
          .from(platformOAuthGrants)
          .where(eq(platformOAuthGrants.id, grantId))
          .limit(1)
          .for('update');
        const grant = grantRows[0];
        if (
          !grant ||
          grant.status !== 'active' ||
          grant.revoked_at !== null ||
          access.token_type !== 'access' ||
          access.resource !== grant.resource ||
          !storedStringSetIsSubset(access.scopes, grant.scopes)
        ) {
          return undefined;
        }
        const rows = await tx
          .insert(platformOAuthTokens)
          .values({ id: randomUUID(), grant_id: grantId, ...access, created_at: nowIso() })
          .returning();
        return rows[0];
      });
    },

    async getTokenByHash(tokenHash: string): Promise<PlatformOAuthResolvedToken | undefined> {
      const rows = await db
        .select({
          token: platformOAuthTokens,
          grant: platformOAuthGrants,
          client: platformOAuthClients,
        })
        .from(platformOAuthTokens)
        .innerJoin(platformOAuthGrants, eq(platformOAuthGrants.id, platformOAuthTokens.grant_id))
        .innerJoin(platformOAuthClients, eq(platformOAuthClients.id, platformOAuthGrants.client_id))
        .where(eq(platformOAuthTokens.token_hash, tokenHash))
        .limit(1);
      return rows[0];
    },

    async consumeRefreshToken(tokenHash: string): Promise<PlatformOAuthResolvedToken | undefined> {
      const now = nowIso();
      const tokens = await db
        .update(platformOAuthTokens)
        .set({ revoked_at: now, last_used_at: now })
        .where(
          and(
            eq(platformOAuthTokens.token_hash, tokenHash),
            eq(platformOAuthTokens.token_type, 'refresh'),
            isNull(platformOAuthTokens.revoked_at),
            gt(platformOAuthTokens.expires_at, now),
          ),
        )
        .returning();
      const token = tokens[0];
      if (!token) return undefined;
      const grants = await db
        .select({ grant: platformOAuthGrants, client: platformOAuthClients })
        .from(platformOAuthGrants)
        .innerJoin(platformOAuthClients, eq(platformOAuthClients.id, platformOAuthGrants.client_id))
        .where(eq(platformOAuthGrants.id, token.grant_id))
        .limit(1);
      return grants[0] ? { token, ...grants[0] } : undefined;
    },

    async revokeToken(tokenHash: string): Promise<boolean> {
      const rows = await db
        .update(platformOAuthTokens)
        .set({ revoked_at: nowIso() })
        .where(and(eq(platformOAuthTokens.token_hash, tokenHash), isNull(platformOAuthTokens.revoked_at)))
        .returning({ id: platformOAuthTokens.id });
      return rows.length > 0;
    },

    async touchAccessToken(id: string): Promise<void> {
      await db.update(platformOAuthTokens).set({ last_used_at: nowIso() }).where(eq(platformOAuthTokens.id, id));
    },
  };
}
