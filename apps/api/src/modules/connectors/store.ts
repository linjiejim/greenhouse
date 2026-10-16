/**
 * Writes to a member's connector connection, shared by the key and sign-in flows. A sealed
 * value is bound to its row id, so a new row gets its id before anything is sealed.
 */

import { and, eq, sql } from 'drizzle-orm';
import { connections, connectors, getDb, newId, transaction, type ConnectionRow } from '@greenhouse/db';
import { conflict } from '../../http/errors.js';
import { isUniqueViolation } from '@greenhouse/utils/error';
import { placeOf, seal } from './secrets.js';

/** A per_member key. */
export type KeySecrets = { key: string };
/** A member's OAuth sign-in. */
export type TokenSecrets = { access_token: string; refresh_token?: string; token_type: string };

export async function findConnection(memberId: string, connectorId: string): Promise<ConnectionRow | null> {
  const [row] = await getDb()
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.memberId, memberId),
        eq(connections.connectorId, connectorId),
        eq(connections.kind, 'connector'),
      ),
    );
  return row ?? null;
}

/** Creates or replaces the member's connection to a connector: a reconnect starts fresh and active. */
export async function saveConnection(
  key: Buffer,
  memberId: string,
  connectorId: string,
  secrets: KeySecrets | TokenSecrets,
  extra: { scopes?: string[]; expiresAt?: string | null } = {},
): Promise<ConnectionRow> {
  try {
    return await transaction(async (db) => {
      const [existing] = await db
        .select({ id: connections.id })
        .from(connections)
        .where(
          and(
            eq(connections.memberId, memberId),
            eq(connections.connectorId, connectorId),
            eq(connections.kind, 'connector'),
          ),
        )
        .for('update');
      const id = existing?.id ?? newId('connection');
      const values = {
        secretsEnc: seal(key, placeOf.connection(id), secrets),
        scopes: extra.scopes ?? [],
        expiresAt: extra.expiresAt ?? null,
        status: 'active' as const,
        lastError: null,
        lastVerifiedAt: new Date().toISOString(),
      };
      if (existing) {
        const [row] = await db
          .update(connections)
          .set({ ...values, updatedAt: sql`now()` })
          .where(eq(connections.id, id))
          .returning();
        return row!;
      }
      const [row] = await db
        .insert(connections)
        .values({ id, memberId, kind: 'connector', connectorId, ...values })
        .returning();
      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict('connection_busy', 'This connection changed at the same time; try again.');
    throw error;
  }
}

/**
 * A refreshed sign-in, written only over the secrets this request read: when another request
 * refreshed first, its rotated refresh token wins. True when this write landed.
 */
export async function replaceTokens(
  key: Buffer,
  row: ConnectionRow,
  readSecrets: string,
  secrets: TokenSecrets,
  expiresAt: string | null,
): Promise<string | null> {
  const sealed = seal(key, placeOf.connection(row.id), secrets);
  const [updated] = await getDb()
    .update(connections)
    .set({
      secretsEnc: sealed,
      expiresAt,
      status: 'active',
      lastError: null,
      lastVerifiedAt: new Date().toISOString(),
      updatedAt: sql`now()`,
    })
    .where(and(eq(connections.id, row.id), eq(connections.secretsEnc, readSecrets)))
    .returning({ id: connections.id });
  return updated ? sealed : null;
}

/** Records how a connection did, unless it changed since `readSecrets` was read (a newer sign-in stays). */
export async function markConnection(
  id: string,
  outcome: { status: 'active' | 'needs_reauth' | 'error'; error?: string | null; clearSecrets?: boolean },
  readSecrets?: string | null,
): Promise<void> {
  await getDb()
    .update(connections)
    .set({
      status: outcome.status,
      lastError: outcome.error ?? null,
      ...(outcome.status === 'active' ? { lastVerifiedAt: new Date().toISOString() } : {}),
      ...(outcome.clearSecrets ? { secretsEnc: null } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(connections.id, id), readSecrets ? eq(connections.secretsEnc, readSecrets) : undefined));
}

/** Stores the client this workspace uses at a connector's sign-in (null drops it). */
export async function saveOAuthClient(connectorId: string, sealed: string | null): Promise<void> {
  await getDb()
    .update(connectors)
    .set({ oauthClientEnc: sealed, updatedAt: sql`now()` })
    .where(eq(connectors.id, connectorId));
}

/** Caches a connector's sign-in discovery (public metadata), or drops it. */
export async function saveDiscovery(connectorId: string, discovery: Record<string, unknown> | null): Promise<void> {
  await getDb().update(connectors).set({ oauthDiscovery: discovery }).where(eq(connectors.id, connectorId));
}
