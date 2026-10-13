import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { authLinks, getDb, members, newId, refreshTokens, type Db, type Member } from '@greenhouse/db';
import type { CompleteLinkInput, IssuedLink, LinkInfo, TokenPair } from '@greenhouse/contract';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  LINK_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  type Tokens,
} from '../../auth/tokens.js';
import { ApiError, unauthorized } from '../../http/errors.js';

type Client = 'web' | 'ios' | 'android' | 'extension' | 'desktop' | 'cli';

// Verified against when the email is unknown, so a miss costs the same time as a hit.
const DUMMY_HASH = hashPassword('greenhouse-timing-equaliser');

const invalidLink = () =>
  new ApiError(400, 'link_invalid', 'This link is invalid or has expired. Ask an admin for a new one.');

export function createAuthService(deps: { tokens: Tokens; publicUrl: string }) {
  const { tokens } = deps;

  async function issueSession(db: Db, member: Pick<Member, 'id' | 'role' | 'authVersion'>, client: Client) {
    const refresh = tokens.newSecret();
    await db.insert(refreshTokens).values({
      id: newId('refreshToken'),
      memberId: member.id,
      tokenHash: tokens.hashSecret(refresh, 'refresh'),
      authVersion: member.authVersion,
      client,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
    });
    return {
      access_token: tokens.createAccessToken(member.id, member.role, member.authVersion),
      refresh_token: refresh,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    } satisfies TokenPair;
  }

  async function findLiveLink(db: Db, token: string, lock: boolean) {
    const query = db
      .select({ link: authLinks, member: members })
      .from(authLinks)
      .innerJoin(members, eq(members.id, authLinks.memberId))
      .where(
        and(
          eq(authLinks.tokenHash, tokens.hashSecret(token, 'link')),
          isNull(authLinks.consumedAt),
          isNull(authLinks.revokedAt),
          gt(authLinks.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    const [row] = lock ? await query.for('update') : await query;
    if (!row || row.member.authVersion !== row.link.issuedAuthVersion || row.member.status === 'disabled') {
      throw invalidLink();
    }
    return row;
  }

  return {
    async login(input: { email: string; password: string; client: Client }): Promise<TokenPair> {
      const db = getDb();
      const [member] = await db.select().from(members).where(eq(members.email, input.email)).limit(1);
      const ok = await verifyPassword(input.password, member?.passwordHash ?? (await DUMMY_HASH));
      if (!member || !ok) throw new ApiError(401, 'invalid_credentials', 'The email or password is incorrect.');
      if (member.status === 'disabled') throw new ApiError(403, 'member_disabled', 'This account is disabled.');
      if (member.status !== 'active') {
        throw new ApiError(403, 'member_not_active', 'Finish setting up your account from the link you were sent.');
      }
      await db
        .update(members)
        .set({ lastLoginAt: sql`now()` })
        .where(eq(members.id, member.id));
      return issueSession(db, member, input.client);
    },

    /** Refresh tokens are single use; presenting a used one revokes all of that member's sessions. */
    async refresh(raw: string): Promise<TokenPair> {
      const result = await getDb().transaction(async (tx): Promise<TokenPair | 'replayed' | 'invalid'> => {
        const db = tx as unknown as Db;
        const [row] = await db
          .select({ token: refreshTokens, member: members })
          .from(refreshTokens)
          .innerJoin(members, eq(members.id, refreshTokens.memberId))
          .where(eq(refreshTokens.tokenHash, tokens.hashSecret(raw, 'refresh')))
          .for('update')
          .limit(1);
        if (!row) return 'invalid';
        if (row.token.consumedAt) {
          // Committed before answering: a stolen token's replay must end the fresh session too.
          await db
            .update(refreshTokens)
            .set({ consumedAt: sql`now()` })
            .where(and(eq(refreshTokens.memberId, row.member.id), isNull(refreshTokens.consumedAt)));
          return 'replayed';
        }
        const expired = new Date(row.token.expiresAt).getTime() <= Date.now();
        if (expired || row.member.status !== 'active' || row.member.authVersion !== row.token.authVersion) {
          return 'invalid';
        }
        await db
          .update(refreshTokens)
          .set({ consumedAt: sql`now()`, lastUsedAt: sql`now()` })
          .where(eq(refreshTokens.id, row.token.id));
        return issueSession(db, row.member, row.token.client);
      });
      if (typeof result === 'string') throw unauthorized();
      return result;
    },

    async logout(raw: string): Promise<void> {
      await getDb()
        .update(refreshTokens)
        .set({ consumedAt: sql`now()` })
        .where(and(eq(refreshTokens.tokenHash, tokens.hashSecret(raw, 'refresh')), isNull(refreshTokens.consumedAt)));
    },

    /** Replaces any live link of the member; the plain token exists only in the returned URL. */
    async issueLink(
      db: Db,
      member: Pick<Member, 'id' | 'authVersion'>,
      purpose: 'activate' | 'reset',
    ): Promise<IssuedLink> {
      await db
        .update(authLinks)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(authLinks.memberId, member.id), isNull(authLinks.consumedAt), isNull(authLinks.revokedAt)));
      const token = tokens.newSecret();
      const expiresAt = new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString();
      await db.insert(authLinks).values({
        id: newId('authLink'),
        memberId: member.id,
        purpose,
        tokenHash: tokens.hashSecret(token, 'link'),
        issuedAuthVersion: member.authVersion,
        expiresAt,
      });
      const base = deps.publicUrl.replace(/\/+$/, '');
      return {
        url: `${base}/#/${purpose === 'activate' ? 'activate' : 'reset'}?token=${token}`,
        expires_at: expiresAt,
      };
    },

    async inspectLink(token: string): Promise<LinkInfo> {
      const { link, member } = await findLiveLink(getDb(), token, false);
      return { purpose: link.purpose, email: member.email, name: member.name };
    },

    /** Sets the password, activates the member, revokes older sessions and signs in. */
    async completeLink(input: CompleteLinkInput, client: Client = 'web'): Promise<TokenPair> {
      return getDb().transaction(async (tx) => {
        const db = tx as unknown as Db;
        const { link, member } = await findLiveLink(db, input.token, true);
        const authVersion = member.authVersion + 1;
        await db
          .update(members)
          .set({
            passwordHash: await hashPassword(input.password),
            status: 'active',
            authVersion,
            name: input.name ?? member.name,
            updatedAt: sql`now()`,
          })
          .where(eq(members.id, member.id));
        await db
          .update(authLinks)
          .set({ consumedAt: sql`now()` })
          .where(eq(authLinks.id, link.id));
        await db
          .update(refreshTokens)
          .set({ consumedAt: sql`now()` })
          .where(and(eq(refreshTokens.memberId, member.id), isNull(refreshTokens.consumedAt)));
        return issueSession(db, { id: member.id, role: member.role, authVersion }, client);
      });
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
