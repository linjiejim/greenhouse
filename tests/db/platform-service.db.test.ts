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

  it('resolves capabilities from role grants alone (no per-user overrides)', async () => {
    const user = await createUser();
    const role = await createRole(user.id);
    await db.platform.replaceRoleCapabilities(role.id, ['projects.project.*'], user.id);
    // the account's own system role (team) grants nothing here
    await db.platform.replaceRoleCapabilities((await db.platform.getRoleByCode('default', 'team'))!.id, []);

    const snapshot = await db.platform.getAuthorizationSnapshot(user.id, 'default');
    expect(snapshot.userOverrides).toEqual([]);
    expect(resolveCapability({ capability: 'projects.project.read', ...snapshot })).toMatchObject({
      allowed: true,
      reason: 'role-allow',
    });
    expect(resolveCapability({ capability: 'knowledge.document.read', ...snapshot })).toMatchObject({
      allowed: false,
    });
  });

  it('takes the system role from users.role, with or without its role_members row', async () => {
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
    expect((await db.platform.listRoleBindings([superRole.id])).some((row) => row.user_id === copied.id)).toBe(false);
    expect(await can(copied.id, 'platform.role.manage')).toBe(true);
    const superPolicies = await policies(copied.id);
    expect(superPolicies).toContainEqual(expect.objectContaining({ scopes: [{ kind: 'all' }] }));

    // a team member reads as team without a binding
    const member = await createUser('unbound-team@test.com');
    expect(await can(member.id, 'knowledge.document.read')).toBe(true);
    expect(await can(member.id, 'platform.role.manage')).toBe(false);

    // demoted in SQL while still bound to super: the stale binding grants nothing
    const demoted = await db.users.create({
      email: 'demoted@test.com',
      password_hash: 'hash',
      nickname: 'Demoted',
      role: 'super',
    });
    await db.platform.syncLegacyRoleBinding(demoted.id, 'super');
    await db.users.update(demoted.id, { role: 'team' });
    expect(await can(demoted.id, 'platform.role.manage')).toBe(false);
    expect(await can(demoted.id, 'knowledge.document.read')).toBe(true);
    expect(await policies(demoted.id)).toEqual(await policies(member.id));
    expect(await policies(demoted.id)).not.toEqual(superPolicies);

    // a disabled account holds no system role
    await db.users.update(copied.id, { status: 'disabled' });
    expect(await can(copied.id, 'platform.role.manage')).toBe(false);
    expect(await policies(copied.id)).toHaveLength(0);
  });

  it('keeps custom roles from role_members next to the system role', async () => {
    const user = await createUser('custom-and-team@test.com');
    const role = await createRole(user.id);
    await db.platform.replaceRoleCapabilities(role.id, ['projects.project.*'], user.id);
    const teamRole = (await db.platform.getRoleByCode('default', 'team'))!;
    await db.platform.replaceRoleCapabilities(teamRole.id, ['knowledge.document.read']);

    const snapshot = await db.platform.getAuthorizationSnapshot(user.id, 'default');
    expect(new Set(snapshot.roleGrants.map((grant) => grant.roleId))).toEqual(new Set([role.id, teamRole.id]));
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
    const rolePolicy = resolveEntityPolicy(roleSnapshot.rolePolicies, roleSnapshot.userOverride);
    const actor: ActorContext = {
      actorId: user.id,
      actorType: 'human',
      orgId: 'default',
      requestId: 'request-1',
      authMethod: 'session',
    };
    expect(canAccessRecord(actor, { ownerId: user.id }, rolePolicy)).toBe(true);

    expect(roleSnapshot.userOverride).toBeUndefined();
    expect((await db.platform.listRoleEntityPolicies([role.id]))[0]).toMatchObject({
      scopes: [{ kind: 'own' }],
      field_policies: { title: { read: 'full', write: true, export: false } },
    });
  });

  it('stores versioned workbench preferences in users.preferences and returns safe defaults', async () => {
    const user = await createUser();
    expect(await db.platform.getUserWorkbenchPreferences('default', user.id)).toEqual({
      version: 2,
      appOrder: [],
      pinnedAppIds: [],
      hiddenAppIds: [],
      defaultAppId: null,
      density: 'comfortable',
      tabs: [],
      widgets: [],
    });

    await db.platform.setUserWorkbenchPreferences('default', user.id, {
      version: 2,
      tabs: [],
      widgets: [],
      appOrder: ['knowledge', 'projects'],
      pinnedAppIds: ['knowledge'],
      hiddenAppIds: ['projects'],
      defaultAppId: 'knowledge',
      density: 'compact',
    });
    expect(await db.platform.getUserWorkbenchPreferences('default', user.id)).toEqual({
      version: 2,
      appOrder: ['knowledge', 'projects'],
      pinnedAppIds: ['knowledge'],
      hiddenAppIds: ['projects'],
      defaultAppId: 'knowledge',
      density: 'compact',
      tabs: [],
      widgets: [],
    });

    await db.platform.setUserWorkbenchPreferences('default', user.id, {
      version: 2,
      tabs: [],
      widgets: [],
      appOrder: ['projects'],
      pinnedAppIds: [],
      hiddenAppIds: [],
      defaultAppId: null,
      density: 'comfortable',
    });
    expect(await db.platform.getUserWorkbenchPreferences('default', user.id)).toMatchObject({
      appOrder: ['projects'],
      pinnedAppIds: [],
      density: 'comfortable',
    });
  });

  it('mutates workbench preferences against the latest normalized value', async () => {
    const user = await createUser();
    await db.platform.mutateUserWorkbenchPreferences('default', user.id, (current) => ({
      ...current,
      appOrder: ['projects'],
    }));
    const saved = await db.platform.mutateUserWorkbenchPreferences('default', user.id, (current) => ({
      ...current,
      pinnedAppIds: ['knowledge'],
    }));

    expect(saved).toMatchObject({
      version: 2,
      appOrder: ['projects'],
      pinnedAppIds: ['knowledge'],
      tabs: [],
      widgets: [],
    });
  });

  it('retains action audits after the referenced user is deleted', async () => {
    const user = await createUser();
    await db.platform.recordAudit({
      orgId: 'default',
      actorId: user.id,
      actorType: 'human',
      requestId: 'request-audit',
      resource: { appId: 'projects', moduleId: 'project', entityId: 'project', recordId: '42' },
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
