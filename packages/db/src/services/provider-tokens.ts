/**
 * Provider token service (PostgreSQL).
 *
 * Generic token storage for connected providers (Feishu, WeCom, …).
 * Tokens are stored encrypted — encryption/decryption happens in the caller's
 * service layer.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { userProviderTokens } from '../schema/index.js';
import type { ProviderTokenRow } from '../schema/provider-token.js';

export interface ProviderTokenInput {
  user_id: string;
  provider: string;
  workspace_id?: string | null;
  /** Omitted for identity-only bindings (see schema note on the column). */
  access_token?: string | null;
  refresh_token?: string | null;
  provider_credential?: string | null;
  token_type?: string;
  scope?: string;
  expires_at?: string | null;
  provider_user_id?: string;
  provider_email?: string;
  provider_name?: string;
  metadata?: Record<string, unknown>;
}

/** Generic provider token storage (Feishu, WeCom, …). */
export function createProviderTokenService(db: Db) {
  const service = {
    /** Upsert a token binding (insert or replace on user+provider+workspace). */
    async upsert(input: ProviderTokenInput): Promise<ProviderTokenRow> {
      const now = nowIso();
      const values = {
        user_id: input.user_id,
        provider: input.provider,
        workspace_id: input.workspace_id ?? null,
        access_token: input.access_token ?? null,
        refresh_token: input.refresh_token ?? null,
        provider_credential: input.provider_credential ?? null,
        token_type: input.token_type ?? 'Bearer',
        scope: input.scope ?? null,
        expires_at: input.expires_at ?? null,
        provider_user_id: input.provider_user_id ?? null,
        provider_email: input.provider_email ?? null,
        provider_name: input.provider_name ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : '{}',
        created_at: now,
        updated_at: now,
      };

      const rows = await db
        .insert(userProviderTokens)
        .values(values)
        .onConflictDoUpdate({
          target: [userProviderTokens.user_id, userProviderTokens.provider, userProviderTokens.workspace_id],
          set: {
            access_token: values.access_token,
            refresh_token: values.refresh_token,
            provider_credential: values.provider_credential,
            token_type: values.token_type,
            scope: values.scope,
            expires_at: values.expires_at,
            provider_user_id: values.provider_user_id,
            provider_email: values.provider_email,
            provider_name: values.provider_name,
            metadata: values.metadata,
            updated_at: now,
          },
        })
        .returning();

      return rows[0]!;
    },

    /** Get a binding by user + provider + workspace. */
    async get(userId: string, provider: string, workspaceId?: string | null): Promise<ProviderTokenRow | undefined> {
      const ws = workspaceId ?? null;
      const conditions = ws
        ? and(
            eq(userProviderTokens.user_id, userId),
            eq(userProviderTokens.provider, provider),
            eq(userProviderTokens.workspace_id, ws),
          )
        : and(
            eq(userProviderTokens.user_id, userId),
            eq(userProviderTokens.provider, provider),
            isNull(userProviderTokens.workspace_id),
          );

      const rows = await db.select().from(userProviderTokens).where(conditions);
      return rows[0] ?? undefined;
    },

    /**
     * Find whoever has bound a given provider-side identity.
     *
     * Used to keep one external identity attached to at most one account:
     * without the check, two people could bind the same colleague's WeCom id
     * and both would receive their notifications.
     */
    async findByProviderUserId(provider: string, providerUserId: string): Promise<ProviderTokenRow | undefined> {
      const rows = await db
        .select()
        .from(userProviderTokens)
        .where(and(eq(userProviderTokens.provider, provider), eq(userProviderTokens.provider_user_id, providerUserId)));
      return rows[0] ?? undefined;
    },

    /** List all bindings for a user (optionally filtered by provider). */
    async listByUser(userId: string, provider?: string): Promise<ProviderTokenRow[]> {
      const conditions = provider
        ? and(eq(userProviderTokens.user_id, userId), eq(userProviderTokens.provider, provider))
        : eq(userProviderTokens.user_id, userId);

      const rows = await db.select().from(userProviderTokens).where(conditions);
      return rows;
    },

    /** Update tokens after refresh (access_token, refresh_token, expires_at). */
    async updateTokens(
      userId: string,
      provider: string,
      workspaceId: string | null,
      updates: { access_token: string; refresh_token?: string; expires_at?: string | null },
    ): Promise<void> {
      const conditions = workspaceId
        ? and(
            eq(userProviderTokens.user_id, userId),
            eq(userProviderTokens.provider, provider),
            eq(userProviderTokens.workspace_id, workspaceId),
          )
        : and(
            eq(userProviderTokens.user_id, userId),
            eq(userProviderTokens.provider, provider),
            isNull(userProviderTokens.workspace_id),
          );

      const updateData: Record<string, unknown> = {
        access_token: updates.access_token,
        updated_at: nowIso(),
      };
      if (updates.refresh_token !== undefined) {
        updateData.refresh_token = updates.refresh_token;
      }
      if (updates.expires_at !== undefined) {
        updateData.expires_at = updates.expires_at;
      }

      await db.update(userProviderTokens).set(updateData).where(conditions);
    },

    /** Delete a binding (unbind). */
    async delete(userId: string, provider: string, workspaceId?: string | null): Promise<boolean> {
      const ws = workspaceId ?? null;
      const conditions = ws
        ? and(
            eq(userProviderTokens.user_id, userId),
            eq(userProviderTokens.provider, provider),
            eq(userProviderTokens.workspace_id, ws),
          )
        : and(
            eq(userProviderTokens.user_id, userId),
            eq(userProviderTokens.provider, provider),
            isNull(userProviderTokens.workspace_id),
          );

      const result = await db.delete(userProviderTokens).where(conditions).returning();
      return result.length > 0;
    },
  };
  return service;
}

export type ProviderTokenService = ReturnType<typeof createProviderTokenService>;
