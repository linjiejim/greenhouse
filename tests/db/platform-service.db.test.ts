/**
 * Platform Kernel v2 control-plane integration tests (real PostgreSQL).
 *
 * Requires: PostgreSQL at localhost:5432 with a migrated greenhouse_test database.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider } from '@greenhouse/db';
import {
  canAccessRecord,
  compileApp,
  resolveCapability,
  resolveEntityPolicy,
  type ActorContext,
  type ApplicationDefinition,
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

function projectsManifest(version = '1.0.0', title = 'Projects') {
  const definition: ApplicationDefinition = {
    id: 'platformTestProjects',
    version,
    title,
    modules: { project: { title: 'Projects' } },
    entities: {
      project: {
        title: 'Project',
        module: 'project',
        table: 'projects',
        accessScopes: ['own', 'collaborating', 'all'],
        fields: {
          title: { kind: 'text', title: 'Title' },
        },
      },
    },
    actions: {
      listProjects: {
        title: 'List projects',
        module: 'project',
        entity: 'project',
        kind: 'query',
        capability: 'platformTestProjects.project.read',
        risk: 'read',
      },
    },
  };
  return compileApp(definition);
}

describe('Platform control-plane service', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    await db.platform.ensureOrganization({ id: 'default', code: 'default', name: 'Greenhouse' });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('persists role grants and applies a user deny override first', async () => {
    const user = await createUser();
    const role = await createRole(user.id);
    await db.platform.replaceRoleCapabilities(role.id, ['projects.project.*'], user.id);
    await db.platform.setUserCapabilityOverride({
      org_id: 'default',
      user_id: user.id,
      capability: 'projects.project.read',
      effect: 'deny',
      granted_by: user.id,
      reason: 'Temporary restriction',
    });

    const snapshot = await db.platform.getAuthorizationSnapshot(user.id, 'default');
    expect(
      resolveCapability({
        capability: 'projects.project.read',
        ...snapshot,
      }),
    ).toMatchObject({ allowed: false, reason: 'user-deny' });
    expect(
      resolveCapability({
        capability: 'projects.project.update',
        ...snapshot,
      }),
    ).toMatchObject({ allowed: true, reason: 'role-allow' });
  });

  it('round-trips entity policies and user replacement semantics', async () => {
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

    await db.platform.setUserEntityPolicyOverride({
      org_id: 'default',
      user_id: user.id,
      effect: 'deny',
      policy: {
        app_id: 'projects',
        module_id: 'project',
        entity_id: 'project',
        scopes: [],
        field_policies: {},
      },
      granted_by: user.id,
    });
    const deniedSnapshot = await db.platform.getEntityPolicySnapshot({
      orgId: 'default',
      userId: user.id,
      appId: 'projects',
      entityId: 'project',
    });
    expect(resolveEntityPolicy(deniedSnapshot.rolePolicies, deniedSnapshot.userOverride)).toEqual({
      scopes: [],
      fields: {},
    });

    expect(await db.platform.listUserEntityPolicyOverrides('default', user.id)).toEqual([
      expect.objectContaining({
        org_id: 'default',
        user_id: user.id,
        app_id: 'projects',
        entity_id: 'project',
        effect: 'deny',
      }),
    ]);
    expect(await db.platform.clearUserEntityPolicyOverride('default', user.id, 'projects', 'project')).toBe(true);
    expect(await db.platform.listUserEntityPolicyOverrides('default', user.id)).toEqual([]);
    expect(await db.platform.clearUserEntityPolicyOverride('default', user.id, 'projects', 'project')).toBe(false);
  });

  it('keeps app versions immutable and allows only one active release', async () => {
    const user = await createUser();
    const first = await db.platform.publishAppRelease({
      manifest: projectsManifest('1.0.0'),
      created_by: user.id,
    });
    await db.platform.activateAppRelease(first.id);

    await expect(
      db.platform.publishAppRelease({
        manifest: projectsManifest('1.0.0', 'Changed without a version bump'),
        created_by: user.id,
      }),
    ).rejects.toThrow(/different manifest hash/);

    const second = await db.platform.publishAppRelease({
      manifest: projectsManifest('1.1.0'),
      created_by: user.id,
    });
    await db.platform.activateAppRelease(second.id);

    const active = (await db.platform.listActiveAppReleases()).filter(
      (release) => release.app_id === 'platformTestProjects',
    );
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      app_id: 'platformTestProjects',
      version: '1.1.0',
      status: 'active',
      parsedManifest: { id: 'platformTestProjects', schemaVersion: 2 },
    });
  });

  it('stores versioned workbench preferences and returns safe defaults', async () => {
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
