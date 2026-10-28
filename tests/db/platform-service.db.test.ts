/**
 * Platform Kernel v2 control-plane integration tests (real PostgreSQL).
 *
 * Single organization, role grants only: per-user overrides and stored app
 * releases were retired in 3.0.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider } from '@greenhouse/db';
import {
  canAccessRecord,
  resolveCapability,
  resolveEntityPolicy,
  type ActorContext,
} from '@greenhouse/platform-kernel';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;

async function createUser(email = 'platform-user@test.com') {
  return db.users.create({
    email,
    password_hash: 'hash',
    nickname: 'Platform User',
    role: 'team',
  });
}

async function createRole(userId: string) {
  const role = await db.platform.createRole({
    org_id: 'default',
    code: 'projectMember',
    name: 'Project Member',
    created_by: userId,
  });
  await db.platform.bindRole(role.id, userId, userId);
  return role;
}

describe('Platform control-plane service', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('resolves capabilities from role grants alone', async () => {
    const user = await createUser();
    const role = await createRole(user.id);
    await db.platform.replaceRoleCapabilities(role.id, ['projects.project.*'], user.id);

    const snapshot = await db.platform.getAuthorizationSnapshot(user.id, 'default');
    expect(snapshot).toEqual({ roleGrants: [expect.objectContaining({ roleId: role.id })] });
    expect(resolveCapability({ capability: 'projects.project.read', ...snapshot })).toMatchObject({
      allowed: true,
      reason: 'role-allow',
    });
    expect(resolveCapability({ capability: 'knowledge.document.read', ...snapshot })).toMatchObject({
      allowed: false,
    });
  });

  it('falls back to the system role users.role names when a member has no role at all', async () => {
    const superRole = (await db.platform.getRoleByCode('default', 'super'))!;
    const teamRole = (await db.platform.getRoleByCode('default', 'team'))!;
    await db.platform.replaceRoleCapabilities(superRole.id, ['*']);
    await db.platform.replaceRoleCapabilities(teamRole.id, ['knowledge.document.read']);
    await db.platform.upsertRoleEntityPolicy(superRole.id, {
      app_id: 'projects',
      module_id: 'project',
      entity_id: 'project',
      scopes: [{ kind: 'all' }],
      field_policies: {},
    });
    const can = async (userId: string, capability: string) =>
      resolveCapability({ capability, ...(await db.platform.getAuthorizationSnapshot(userId, 'default')) }).allowed;
    const policies = async (userId: string) =>
      (await db.platform.getEntityPolicySnapshot({ userId, appId: 'projects', entityId: 'project' })).rolePolicies;

    // a super copied in by hand: no role_members row at all
    const copied = await db.users.create({
      email: 'copied-super@test.com',
      password_hash: 'hash',
      nickname: 'Copied',
      role: 'super',
    });
    expect((await db.platform.listRoleBindings()).some((row) => row.user_id === copied.id)).toBe(false);
    expect(await can(copied.id, 'platform.role.manage')).toBe(true);
    expect(await policies(copied.id)).toContainEqual(expect.objectContaining({ scopes: [{ kind: 'all' }] }));

    // a team member reads as team without a binding, and nothing more
    const member = await createUser('unbound-team@test.com');
    expect(await can(member.id, 'knowledge.document.read')).toBe(true);
    expect(await can(member.id, 'platform.role.manage')).toBe(false);

    // a disabled account holds no fallback role
    await db.users.update(copied.id, { status: 'disabled' });
    expect(await can(copied.id, 'platform.role.manage')).toBe(false);
    expect(await policies(copied.id)).toHaveLength(0);
  });

  it('never widens a member moved to a narrower role', async () => {
    const user = await createUser('narrowed@test.com');
    const role = await createRole(user.id);
    await db.platform.replaceRoleCapabilities(role.id, ['projects.project.read'], user.id);
    const teamRole = (await db.platform.getRoleByCode('default', 'team'))!;
    await db.platform.replaceRoleCapabilities(teamRole.id, ['knowledge.document.read']);

    const snapshot = await db.platform.getAuthorizationSnapshot(user.id, 'default');
    expect(new Set(snapshot.roleGrants.map((grant) => grant.roleId))).toEqual(new Set([role.id]));
  });

  it('round-trips role entity policies', async () => {
    const user = await createUser();
    const role = await createRole(user.id);
    await db.platform.upsertRoleEntityPolicy(role.id, {
      app_id: 'projects',
      module_id: 'project',
      entity_id: 'project',
      scopes: [{ kind: 'own' }],
      field_policies: {
        title: { read: 'full', write: true, export: false },
      },
    });

    const roleSnapshot = await db.platform.getEntityPolicySnapshot({
      orgId: 'default',
      userId: user.id,
      appId: 'projects',
      entityId: 'project',
    });
    const rolePolicy = resolveEntityPolicy(roleSnapshot.rolePolicies);
    const actor: ActorContext = {
      actorId: user.id,
      actorType: 'human',
      orgId: 'default',
      requestId: 'request-1',
      authMethod: 'session',
    };
    expect(canAccessRecord(actor, { ownerId: user.id }, rolePolicy)).toBe(true);

    expect((await db.platform.listRoleEntityPolicies([role.id]))[0]).toMatchObject({
      scopes: [{ kind: 'own' }],
      field_policies: { title: { read: 'full', write: true, export: false } },
    });
  });

  it('retains action audits after the referenced user is deleted', async () => {
    const user = await createUser();
    await db.platform.recordAudit({
      orgId: 'default',
      actorId: user.id,
      actorType: 'human',
      requestId: 'request-audit',
      resource: { appId: 'platform', moduleId: 'project', entityId: 'project', recordId: '42' },
      actionId: 'listProjects',
      capability: 'projects.project.read',
      result: 'success',
    });

    await db.users.delete(user.id);
    const events = (await db.platform.listAuditEvents('default')).filter(
      (event) => event.request_id === 'request-audit',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_id: user.id, record_id: '42', result: 'success' });
  });

  it('prevents disabling or deleting a system-protected role', async () => {
    const role = await db.platform.getRoleByCode('default', 'super');
    expect(role).not.toBeNull();

    await expect(db.platform.updateRole(role!.id, { status: 'disabled' })).rejects.toThrow(/cannot be disabled/);
    expect(await db.platform.deleteRole(role!.id)).toBe(false);
  });
});
