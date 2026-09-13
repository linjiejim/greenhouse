import type { DatabaseProvider, UserRow } from '@greenhouse/db';

type InternalRole = 'team' | 'super';

interface InternalTestUserInput {
  email: string;
  nickname?: string;
  passwordHash?: string;
  role?: InternalRole;
}

const roleIdsByProvider = new WeakMap<DatabaseProvider, Map<InternalRole, Promise<string>>>();

function getBaselineRoleId(db: DatabaseProvider, role: InternalRole): Promise<string> {
  let roleIds = roleIdsByProvider.get(db);
  if (!roleIds) {
    roleIds = new Map();
    roleIdsByProvider.set(db, roleIds);
  }

  const cached = roleIds.get(role);
  if (cached) return cached;

  const pending = db.platform.getRoleByCode('default', role).then((row) => {
    if (!row) throw new Error(`Platform baseline role "${role}" is missing`);
    return row.id;
  });
  roleIds.set(role, pending);
  return pending;
}

/**
 * Create a fresh internal test user and bind it directly to the immutable
 * Platform baseline role. New users have no legacy binding to reconcile, so
 * the production role-migration path would only add a lookup, delete and
 * nested transaction to every fixture.
 */
export async function createInternalTestUser(db: DatabaseProvider, input: InternalTestUserInput): Promise<UserRow> {
  const role = input.role ?? 'team';
  const [user, roleId] = await Promise.all([
    db.users.create({
      email: input.email,
      password_hash: input.passwordHash ?? 'hash',
      nickname: input.nickname ?? input.email.split('@')[0]!,
      role,
    }),
    getBaselineRoleId(db, role),
  ]);
  await db.platform.bindRole(roleId, user.id);
  return user;
}
