/** First-run ownership via the ordinary, single-use account invitation flow. */
import { getDb, UNSET_ACCOUNT_PASSWORD_HASH, type DatabaseProvider } from '@greenhouse/db';
import { isUniqueViolation, toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { CLIENT_ROUTES, clientRouteUrl } from '@greenhouse/types/client-routes';
import { emitExtensionEvent } from '../plugin-host/events.js';
import { recordAccountSecurityAudit } from './account.js';

export type FirstAdminOutcome =
  | { status: 'established' | 'unconfigured' | 'invalid_email' | 'conflict' | 'changed' }
  | { status: 'issued'; userId: string; link: string; expiresAt: string };

/** Public setup hint: a failed lookup must never advertise an unclaimed instance. */
export async function isFirstRunSetupPending(db?: DatabaseProvider): Promise<boolean> {
  try {
    return !(await (db ?? getDb()).users.hasEstablishedSuper());
  } catch (error) {
    logger.warn('[setup] Could not check for an administrator', { error: toErrorMessage(error) });
    return false;
  }
}

function activationLink(token: string, rawBase?: string): { link: string; relative: boolean } {
  if (rawBase?.trim()) {
    try {
      const base = new URL(rawBase.trim());
      if (
        ['http:', 'https:'].includes(base.protocol) &&
        !base.username &&
        !base.password &&
        !base.search &&
        !base.hash
      ) {
        return { link: clientRouteUrl(base.href, CLIENT_ROUTES.activate, { fragment: { token } }), relative: false };
      }
    } catch {
      /* Missing or invalid base: the relative route still works on this instance. */
    }
  }
  return { link: clientRouteUrl('', CLIENT_ROUTES.activate, { fragment: { token } }), relative: true };
}

export async function bootstrapFirstAdmin(
  db: DatabaseProvider = getDb(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<FirstAdminOutcome> {
  // No email lookup, writes or logging on an already-owned instance.
  if (await db.users.hasEstablishedSuper()) return { status: 'established' };
  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim() ?? '';
  if (!email) {
    logger.warn(
      '[setup] This instance has no administrator. Set BOOTSTRAP_ADMIN_EMAIL and restart for an activation link in the service log, or run `pnpm cli users create --role super`.',
    );
    return { status: 'unconfigured' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    logger.error('[setup] BOOTSTRAP_ADMIN_EMAIL is not a valid email address; no account was changed.');
    return { status: 'invalid_email' };
  }
  let user = await db.users.getByEmail(email);
  if (!user) {
    try {
      // Same account service and protected-role binding as CLI/admin account creation.
      user = await db.users.create({
        email,
        nickname: env.BOOTSTRAP_ADMIN_NAME?.trim() || email.split('@')[0],
        role: 'super',
        status: 'invited',
        password_hash: UNSET_ACCOUNT_PASSWORD_HASH,
      });
      emitExtensionEvent('user.created', { userId: user.id });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Another boot created the email first: re-read and apply the same narrow eligibility rule.
      user = await db.users.getByEmail(email);
    }
  }
  if (!user || user.role !== 'super' || user.status !== 'invited') {
    logger.error(
      '[setup] BOOTSTRAP_ADMIN_EMAIL belongs to an existing account that is not an invited super administrator; it was left untouched. Use another email or `pnpm cli users create --role super`.',
    );
    return { status: 'conflict' };
  }
  if (await db.users.hasEstablishedSuper()) return { status: 'established' };
  // Repeated boots also repair a crash between account creation and role binding.
  await db.platform.syncLegacyRoleBinding(user.id, user.role);
  const issued = await db.accountPasswordLinks.issueInvite(user.id, user.id, undefined, { requiredRole: 'super' });
  if (!issued) return { status: 'changed' }; // Activated/disabled/demoted while waiting on the user lock.
  await recordAccountSecurityAudit(db, {
    actorId: user.id,
    actorType: 'system',
    targetUserId: user.id,
    linkId: issued.link.id,
    actionId: 'bootstrapFirstAdmin',
    result: 'success',
    summary: { source: 'BOOTSTRAP_ADMIN_EMAIL', expires_at: issued.link.expires_at },
  });
  const { link, relative } = activationLink(issued.token, env.PUBLIC_BASE_URL);
  const expiresAt = new Date(issued.link.expires_at).toISOString();
  logger.warn(
    `[setup] Activate the first administrator (${email}) — one-time link, valid until ${expiresAt}: ${link}${relative ? ' (Open on this instance; set PUBLIC_BASE_URL to a valid http(s) URL for a full link.)' : ''}`,
  );
  return { status: 'issued', userId: user.id, link, expiresAt };
}
