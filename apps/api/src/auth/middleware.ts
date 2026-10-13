import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb, members } from '@greenhouse/db';
import { forbidden, unauthorized } from '../http/errors.js';
import type { AppEnv } from '../http/env.js';
import type { Tokens } from './tokens.js';

/**
 * Bearer authentication. The token proves identity; role, status and auth_version are read
 * from the database on every request, so disabling a member or changing a password takes
 * effect at once.
 */
export function requireMember(tokens: Tokens): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const claims = match ? tokens.verifyAccessToken(match[1]!) : null;
    if (!claims) throw unauthorized();
    const [row] = await getDb()
      .select({
        id: members.id,
        role: members.role,
        status: members.status,
        authVersion: members.authVersion,
        name: members.name,
        email: members.email,
      })
      .from(members)
      .where(eq(members.id, claims.sub))
      .limit(1);
    if (!row || row.status !== 'active' || row.authVersion !== claims.ver) throw unauthorized();
    c.set('member', { id: row.id, role: row.role, name: row.name, email: row.email });
    await next();
  };
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('member').role !== 'admin') throw forbidden('Only admins can do this.');
  await next();
};
