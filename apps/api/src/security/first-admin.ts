/**
 * The first administrator of a fresh deployment, without `exec` into the container.
 *
 * One-click hosts (a Railway template, the install script) cannot run
 * `pnpm admin:create`. Instead the operator names the first admin's email in
 * BOOTSTRAP_ADMIN_EMAIL; while nobody owns the instance yet, every boot makes
 * sure that account exists as an invited super admin and logs a fresh one-time
 * activation link — the same `#/activate` link member invites use (single use,
 * 72 h, only its hash is stored). Opening it sets the password and signs in.
 *
 * Deliberately narrow:
 * - an instance with an established super admin is never touched: the variable
 *   is inert there, and nothing is logged;
 * - an email that belongs to any other account (a team member, a disabled
 *   admin) is never promoted or revived — access to the environment must not
 *   become a way to escalate an existing account;
 * - the link goes to the log, not to email: a fresh instance has no mailbox.
 *   Each boot issues a new link and revokes the previous one, so the newest
 *   line in the log is the one that works.
 *
 * Design: docs/specs/20261009-one-click-deploy.md D2.
 */

import { getDb, UNSET_ACCOUNT_PASSWORD_HASH, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { isUniqueViolation, toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';

import { passwordLinkForLog, recordAccountSecurityAudit } from './account.js';

/** Same rule as `admin:create` and POST /api/admin/users. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type FirstAdminOutcome =
  /** Someone already owns the instance — nothing to do. */
  | { status: 'established' }
  /** No owner and no BOOTSTRAP_ADMIN_EMAIL: told the operator how to proceed. */
  | { status: 'unconfigured' }
  | { status: 'invalid_email' }
  /** The email belongs to an account that is not a pending administrator. */
  | { status: 'conflict' }
  | { status: 'issued'; userId: string; link: string; expiresAt: string };

/**
 * Whether first-run setup is still pending (no established super admin) —
 * what GET /api/bootstrap reports as `setup_pending`. Fails closed: an
 * unreachable database hides the hint rather than claiming the instance is open.
 */
export async function isFirstRunSetupPending(db: DatabaseProvider = getDb()): Promise<boolean> {
  try {
    return !(await db.users.hasEstablishedSuper());
  } catch (err) {
    logger.warn(`[setup] could not check for an administrator: ${toErrorMessage(err)}`);
    return false;
  }
}

function nicknameFor(email: string, env: NodeJS.ProcessEnv): string {
  return env.BOOTSTRAP_ADMIN_NAME?.trim() || email.slice(0, email.indexOf('@')) || 'Admin';
}

/** The pending administrator for `email`, created when absent; null when the email is taken by anyone else. */
async function pendingAdmin(db: DatabaseProvider, email: string, env: NodeJS.ProcessEnv): Promise<UserRow | null> {
  let user = await db.users.getByEmail(email);
  if (!user) {
    try {
      user = await db.users.create({
        email,
        password_hash: UNSET_ACCOUNT_PASSWORD_HASH,
        nickname: nicknameFor(email, env),
        role: 'super',
        status: 'invited',
      });
    } catch (err) {
      // Another replica booting at the same moment created it first.
      if (!isUniqueViolation(err)) throw err;
      user = await db.users.getByEmail(email);
    }
  }
  if (!user || user.role !== 'super' || user.status !== 'invited') return null;
  // Idempotent; repeated every boot so a crash between create and bind heals.
  await db.platform.syncLegacyRoleBinding(user.id, user.role);
  return user;
}

export async function bootstrapFirstAdmin(
  db: DatabaseProvider = getDb(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<FirstAdminOutcome> {
  if (await db.users.hasEstablishedSuper()) return { status: 'established' };

  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim() ?? '';
  if (!email) {
    logger.warn(
      '[setup] This instance has no administrator yet. Set BOOTSTRAP_ADMIN_EMAIL and restart to get a ' +
        'one-time activation link in this log, or run `pnpm admin:create` inside the container.',
    );
    return { status: 'unconfigured' };
  }
  if (!EMAIL_PATTERN.test(email)) {
    logger.error('[setup] BOOTSTRAP_ADMIN_EMAIL is not a valid email address; no administrator was created.');
    return { status: 'invalid_email' };
  }

  const user = await pendingAdmin(db, email, env);
  if (!user) {
    logger.error(
      `[setup] BOOTSTRAP_ADMIN_EMAIL (${email}) belongs to an existing account that is not a pending ` +
        'administrator; it was left untouched. Use another email, or `pnpm admin:create`.',
    );
    return { status: 'conflict' };
  }

  const issued = await db.accountPasswordLinks.issueInvite(user.id, user.id);
  // Activated (or changed) between the read above and the lock inside issueInvite.
  if (!issued) return { status: 'established' };

  await recordAccountSecurityAudit(db, {
    actorId: user.id,
    actorType: 'system',
    targetUserId: user.id,
    linkId: issued.link.id,
    actionId: 'bootstrapFirstAdmin',
    result: 'success',
    summary: { source: 'BOOTSTRAP_ADMIN_EMAIL', expires_at: issued.link.expires_at },
  });

  const link = passwordLinkForLog(issued.token, env.PUBLIC_BASE_URL);
  const expiresAt = new Date(issued.link.expires_at).toISOString();
  logger.warn(`[setup] Activate the first administrator (${email}) — one-time link, valid until ${expiresAt}: ${link}`);
  return { status: 'issued', userId: user.id, link, expiresAt };
}
