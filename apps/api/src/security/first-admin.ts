import { eq } from 'drizzle-orm';
import { getDb, members, newId, type Db } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import type { AuthService } from '../modules/auth/service.js';

/**
 * Creates the first admin from BOOTSTRAP_ADMIN_EMAIL and logs a one-time activation link.
 * Does nothing once any admin exists, and never promotes or revives an existing account.
 */
export async function ensureFirstAdmin(email: string | undefined, auth: AuthService): Promise<string | null> {
  if (!email) return null;
  return getDb().transaction(async (tx) => {
    const db = tx as unknown as Db;
    const [admin] = await db.select({ id: members.id }).from(members).where(eq(members.role, 'admin')).limit(1);
    if (admin) return null;
    const normalized = email.trim().toLowerCase();
    const [taken] = await db.select({ id: members.id }).from(members).where(eq(members.email, normalized)).limit(1);
    if (taken) {
      logger.warn('[setup] BOOTSTRAP_ADMIN_EMAIL belongs to an existing member; not promoting it');
      return null;
    }
    const [row] = await db
      .insert(members)
      .values({ id: newId('member'), email: normalized, name: normalized.split('@')[0]!, role: 'admin' })
      .returning();
    const link = await auth.issueLink(db, row!, 'activate');
    logger.info(`[setup] Activate the first admin (${normalized}) within 7 days: ${link.url}`);
    return link.url;
  });
}
