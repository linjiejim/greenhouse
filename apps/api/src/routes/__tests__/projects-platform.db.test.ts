/**
 * Projects Platform Kernel parity and IDOR integration tests (real PostgreSQL).
 *
 * Covers bootstrap, guarded registry dispatch, HTTP compatibility, explicit
 * user deny precedence, private-record non-disclosure, and member-only writes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import type { AppEnv } from '../../app-env.js';
import projectsRoutes from '../projects.js';
import platformRoutes from '../platform.js';
import platformAdminRoutes from '../platform-admin.js';
import { bootstrapPlatform } from '../../platform/bootstrap.js';
import { tablesManifest } from '../../platform/manifests/tables.js';
import { projectsRegistration } from '../../platform/projects/application.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { humanActor } from '../../platform/actor.js';
import { createProjectQueryTool } from '../../tools/project-query.js';
import { createProjectMutationTool } from '../../tools/project-mutation.js';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let outsider: UserRow;
let privateProjectId: number;
let publicProjectId: number;
let actorsReady: Promise<void> | undefined;
let projectsReady: Promise<void> | undefined;

async function createUser(email: string, role: 'super' | 'team' | 'external' = 'team') {
  if (role === 'super' || role === 'team') {
    return createInternalTestUser(db, { email, role });
  }
  return db.users.create({
    email,
    password_hash: 'hash',
    nickname: email.split('@')[0]!,
    role,
  });
}

function setupActors(): Promise<void> {
  actorsReady ??= Promise.all([createUser('project-owner@test.com'), createUser('project-outsider@test.com')]).then(
    ([createdOwner, createdOutsider]) => {
      owner = createdOwner;
      outsider = createdOutsider;
    },
  );
  return actorsReady;
}

function setupProjects(): Promise<void> {
  projectsReady ??= setupActors().then(async () => {
    const [privateProject, publicProject] = await Promise.all([
      db.projects.createProject({
        title: 'Private launch',
        owner_id: owner.id,
        visibility: 'private',
        created_by: owner.id,
      }),
      db.projects.createProject({
        title: 'Public launch',
        owner_id: owner.id,
        visibility: 'public',
        created_by: owner.id,
      }),
    ]);
    privateProjectId = privateProject.id;
    publicProjectId = publicProject.id;
  });
  return projectsReady;
}

function createHttpApp(users: Record<string, UserRow>) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = users[c.req.header('x-test-user') ?? ''];
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/projects', projectsRoutes);
  return app;
}

function createPlatformHttpApp(users: Record<string, UserRow>) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = users[c.req.header('x-test-user') ?? ''];
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/platform', platformRoutes);
  app.route('/api/admin/platform', platformAdminRoutes);
  return app;
}

async function executeTool(tool: unknown, input: unknown): Promise<unknown> {
  const executable = tool as {
    execute: (value: unknown, options: { toolCallId: string; messages: never[] }) => Promise<unknown>;
  };
  return executable.execute(input, { toolCallId: 'projects-platform-test', messages: [] });
}

describe('Projects Platform Kernel migration', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    actorsReady = undefined;
    projectsReady = undefined;
    initializePlatformRuntime(db, [projectsRegistration]);
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('bootstraps active application manifests and idempotent protected internal roles', async () => {
    await setupActors();
    const second = await bootstrapPlatform(db);
    expect(second).toMatchObject({
      appReleasesActivated: [],
      rolesCreated: [],
      capabilitiesAdded: 0,
      entityPoliciesAdded: 0,
      bindingsSynchronized: 2,
    });

    // Read the versions that move from their manifests; the two rarely-touched
    // ones stay literal so a silent bump there still trips this. They moved to
    // 1.0.1 on 2026-08-11 — not a content change of their own, but every
    // manifest's serialization shifted when compileApp stopped letting a
    // caller-supplied `id` through, and an unbumped manifest whose hash moved
    // is a boot-time fatal (see platform/__tests__/manifest-hash.test.ts).
    // Core's three, pinned. A fork's extensions publish their own applications
    // beside them, so filter to core rather than asserting the whole list.
    const active = await db.platform.listActiveAppReleases();
    const coreIds = new Set(['knowledge', 'projects', 'tables']);
    expect(
      active.filter((release) => coreIds.has(release.app_id)).map((release) => `${release.app_id}@${release.version}`),
    ).toEqual(['knowledge@1.0.1', 'projects@1.0.1', `tables@${tablesManifest.version}`]);
    const roles = await db.platform.listRoles('default');
    expect(roles.map((role) => role.code)).toEqual(['super', 'team']);
    expect(roles.every((role) => role.system_protected)).toBe(true);

    const bindings = await db.platform.listRoleBindings(roles.map((role) => role.id));
    expect(bindings).toHaveLength(2);
  });

  it('refreshes system-role baseline field policies to match the manifest on re-bootstrap', async () => {
    // A field added to an already-bootstrapped app must reach the baseline system-role
    // policies, or it is denied on write and dropped on read. Simulate an old-manifest
    // seed (policy missing a field), re-bootstrap, and assert the field is restored.
    const roles = await db.platform.listRoles('default');
    const superRole = roles.find((role) => role.code === 'super')!;
    const readProjectPolicy = async () => {
      const rows = await db.platform.listRoleEntityPolicies([superRole.id]);
      const row = rows.find((r) => r.app_id === 'projects' && r.entity_id === 'project')!;
      return JSON.parse(row.field_policies) as Record<
        string,
        { read: 'full' | 'masked' | 'none'; write: boolean; export: boolean }
      >;
    };

    const seeded = await readProjectPolicy();
    // Manifest fields must be present and writable after the initial seed.
    expect(seeded.priority).toMatchObject({ write: true });
    expect(seeded.visibility).toMatchObject({ write: true });
    expect(seeded.color).toMatchObject({ write: true });

    // Simulate drift: an earlier manifest seed that never knew about `color`.
    const { color: _dropped, ...withoutColor } = seeded;
    await db.platform.upsertRoleEntityPolicy(superRole.id, {
      app_id: 'projects',
      module_id: 'portfolio',
      entity_id: 'project',
      scopes: [{ kind: 'all' }],
      field_policies: withoutColor,
    });
    expect((await readProjectPolicy()).color).toBeUndefined();

    await bootstrapPlatform(db);

    expect((await readProjectPolicy()).color).toMatchObject({ write: true });
  });

  it('preserves public/private read parity and blocks cross-project writes', async () => {
    await setupProjects();
    const app = createHttpApp({ owner, outsider });

    const publicRead = await app.request(`/api/projects/${publicProjectId}`, {
      headers: { 'x-test-user': 'outsider' },
    });
    expect(publicRead.status).toBe(200);

    const privateRead = await app.request(`/api/projects/${privateProjectId}`, {
      headers: { 'x-test-user': 'outsider' },
    });
    expect(privateRead.status).toBe(404);
    expect(await privateRead.json()).toEqual({ error: 'Project not found' });

    const idorWrite = await app.request(`/api/projects/${publicProjectId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': 'outsider' },
      body: JSON.stringify({ title: 'Hijacked' }),
    });
    expect(idorWrite.status).toBe(404);
    expect((await db.projects.getProjectById(publicProjectId))?.title).toBe('Public launch');

    const ownerWrite = await app.request(`/api/projects/${publicProjectId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner' },
      body: JSON.stringify({ title: 'Updated safely' }),
    });
    expect(ownerWrite.status).toBe(200);
    expect((await db.projects.getProjectById(publicProjectId))?.title).toBe('Updated safely');
  });

  it('applies user deny before the team baseline on HTTP and direct registry dispatch', async () => {
    await setupProjects();
    await db.platform.setUserCapabilityOverride({
      org_id: 'default',
      user_id: owner.id,
      capability: 'projects.portfolio.update',
      effect: 'deny',
      granted_by: owner.id,
      reason: 'Test restriction',
    });
    const app = createHttpApp({ owner });
    const response = await app.request(`/api/projects/${publicProjectId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner' },
      body: JSON.stringify({ title: 'Must not change' }),
    });
    expect(response.status).toBe(403);
    expect((await db.projects.getProjectById(publicProjectId))?.title).toBe('Public launch');

    const runtime = initializePlatformRuntime(db, [projectsRegistration]);
    const direct = await runtime.dispatch({
      actor: humanActor(owner),
      appId: 'projects',
      actionId: 'updateProject',
      payload: { projectId: publicProjectId, updates: { title: 'Still blocked' } },
    });
    expect(direct).toMatchObject({ ok: false, code: 'FORBIDDEN' });

    const audits = await db.platform.listAuditEvents('default');
    expect(
      audits.filter(
        (event) => event.actor_id === owner.id && event.action_id === 'updateProject' && event.result === 'denied',
      ),
    ).toHaveLength(2);
  });

  it('requires project ownership for member management', async () => {
    await setupProjects();
    const member = await createUser('ordinary-member@test.com');
    await db.projects.addMember({
      project_id: publicProjectId,
      user_id: member.id,
      role: 'member',
      added_by: owner.id,
    });
    const app = createHttpApp({ member });
    const response = await app.request(`/api/projects/${publicProjectId}/members/${outsider.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': 'member' },
    });
    expect(response.status).toBe(404);
    expect(await db.projects.isMember(publicProjectId, member.id)).toBe(true);
  });

  it('lets members edit content but not transfer ownership or change visibility', async () => {
    await setupProjects();
    const member = await createUser('project-control-member@test.com');
    await db.projects.addMember({
      project_id: publicProjectId,
      user_id: member.id,
      role: 'member',
      added_by: owner.id,
    });
    const app = createHttpApp({ member, outsider });
    const headers = { 'content-type': 'application/json', 'x-test-user': 'member' };

    const contentEdit = await app.request(`/api/projects/${publicProjectId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title: 'Member content edit' }),
    });
    expect(contentEdit.status).toBe(200);

    for (const body of [{ visibility: 'private' }, { owner_id: outsider.id }]) {
      const denied = await app.request(`/api/projects/${publicProjectId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
      });
      expect(denied.status).toBe(404);
    }
    expect(await db.projects.getProjectById(publicProjectId)).toMatchObject({
      owner_id: owner.id,
      visibility: 'public',
      title: 'Member content edit',
    });
  });

  it('never assigns historical external or disabled accounts to active project records', async () => {
    await setupProjects();
    const external = await createUser('project-external@test.com', 'external');
    const disabled = await createUser('project-disabled@test.com');
    await db.users.update(disabled.id, { status: 'disabled' });
    const app = createHttpApp({ owner });
    const headers = { 'content-type': 'application/json', 'x-test-user': 'owner' };

    const assignable = await app.request('/api/projects/meta/users', { headers });
    expect(assignable.status).toBe(200);
    expect((await assignable.json()).users.map((user: { id: string }) => user.id)).not.toContain(external.id);
    const assignableAgain = await app.request('/api/projects/meta/users', { headers });
    expect((await assignableAgain.json()).users.map((user: { id: string }) => user.id)).not.toContain(disabled.id);

    const project = await app.request('/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Invalid owner', owner_id: external.id }),
    });
    expect(project.status).toBe(400);

    const task = await app.request(`/api/projects/${publicProjectId}/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Invalid assignee', assignee_id: disabled.id }),
    });
    expect(task.status).toBe(400);

    const member = await app.request(`/api/projects/${publicProjectId}/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ user_id: external.id, role: 'member' }),
    });
    expect(member.status).toBe(400);
  });

  it('uses the same record and capability checks from Agent/MCP project tools', async () => {
    await setupProjects();
    const outsiderQuery = createProjectQueryTool(db, {
      userId: outsider.id,
    });
    const hidden = (await executeTool(outsiderQuery, {
      action: 'get',
      project_id: privateProjectId,
    })) as { error?: string };
    expect(hidden.error).toBe('Project not found');

    const ownerMutation = createProjectMutationTool({
      userId: owner.id,
    });
    const allowed = (await executeTool(ownerMutation, {
      action: 'project.update',
      project_id: publicProjectId,
      title: 'Updated by agent',
    })) as { status?: string; error?: string };
    expect(allowed).toMatchObject({ status: 'updated' });

    await db.platform.setUserCapabilityOverride({
      org_id: 'default',
      user_id: owner.id,
      capability: 'projects.portfolio.update',
      effect: 'deny',
      granted_by: owner.id,
    });
    const denied = (await executeTool(ownerMutation, {
      action: 'project.update',
      project_id: publicProjectId,
      title: 'Denied agent write',
    })) as { status?: string; error?: string };
    expect(denied.error).toMatch(/缺少能力 projects\.portfolio\.update/);
    expect((await db.projects.getProjectById(publicProjectId))?.title).toBe('Updated by agent');
  });

  it('covers the retired project_manager surface: comment.add and the rich summary report', async () => {
    // project_manager (chat monolith) was retired 2026-08-07; its two capabilities
    // the pair lacked moved here — this pins them so a regression cannot silently
    // shrink the surviving tools back to the pre-merge surface.
    await setupProjects();
    const ownerMutation = createProjectMutationTool({ userId: owner.id });
    const ownerQuery = createProjectQueryTool(db, { userId: owner.id });

    const created = (await executeTool(ownerMutation, {
      action: 'task.create',
      project_id: publicProjectId,
      title: 'Comment target',
    })) as { status?: string; task?: { id: number } };
    expect(created.status).toBe('created');

    const commented = (await executeTool(ownerMutation, {
      action: 'comment.add',
      task_id: created.task!.id,
      content: 'Ported from project_manager.add_comment',
    })) as { status?: string; comment?: { id: number; task_id: number } };
    expect(commented.status).toBe('created');
    expect(commented.comment?.task_id).toBe(created.task!.id);

    const missingContent = (await executeTool(ownerMutation, {
      action: 'comment.add',
      task_id: created.task!.id,
    })) as { error?: string };
    expect(missingContent.error).toMatch(/content is required/);

    const summary = (await executeTool(ownerQuery, {
      action: 'summary',
      project_id: publicProjectId,
    })) as {
      project?: { title: string };
      progress_percent?: number;
      overdue_tasks?: unknown[];
      by_assignee?: Record<string, { total: number; done: number }>;
      recent_activities?: unknown[];
    };
    expect(typeof summary.project?.title).toBe('string');
    expect(Array.isArray(summary.overdue_tasks)).toBe(true);
    expect(summary.by_assignee).toBeDefined();
    expect(Array.isArray(summary.recent_activities)).toBe(true);
    expect(typeof summary.progress_percent).toBe('number');
  });

  it('exposes a fail-closed catalog and super-only permission management API', async () => {
    await setupActors();
    const superUser = await createUser('platform-super@test.com', 'super');
    const app = createPlatformHttpApp({ owner, outsider, superUser });

    const visible = await app.request('/api/platform/apps', {
      headers: { 'x-test-user': 'owner' },
    });
    expect(visible.status).toBe(200);
    expect((await visible.json()).applications.map((application: { id: string }) => application.id)).toEqual([
      'projects',
    ]);

    const forbiddenAdmin = await app.request('/api/admin/platform/roles', {
      headers: { 'x-test-user': 'owner' },
    });
    expect(forbiddenAdmin.status).toBe(403);

    const created = await app.request('/api/admin/platform/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'superUser' },
      body: JSON.stringify({ code: 'projectObserver', name: 'Project observer' }),
    });
    expect(created.status).toBe(201);
    const roleId = (await created.json()).role.id as string;

    const capabilities = await app.request(`/api/admin/platform/roles/${roleId}/capabilities`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': 'superUser' },
      body: JSON.stringify({ capabilities: ['projects.portfolio.read'] }),
    });
    expect(capabilities.status).toBe(200);

    const override = await app.request(`/api/admin/platform/users/${owner.id}/overrides`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': 'superUser' },
      body: JSON.stringify({
        capability: 'projects.portfolio.read',
        effect: 'deny',
        reason: 'Catalog test',
      }),
    });
    expect(override.status).toBe(200);

    const hidden = await app.request('/api/platform/apps', {
      headers: { 'x-test-user': 'owner' },
    });
    const hiddenApplications = (await hidden.json()).applications as Array<{ id: string }>;
    expect(hiddenApplications).toEqual([
      expect.objectContaining({
        id: 'projects',
      }),
    ]);
    const hiddenProjects = hiddenApplications[0] as unknown as {
      actions: Record<string, { capability: string }>;
    };
    expect(
      Object.values(hiddenProjects.actions).some((action) => action.capability === 'projects.portfolio.read'),
    ).toBe(false);
  });

  it('round-trips user entity policies and rejects fields or scopes outside the manifest', async () => {
    await setupActors();
    const superUser = await createUser('entity-policy-super@test.com', 'super');
    const app = createPlatformHttpApp({ owner, superUser });
    const endpoint = `/api/admin/platform/users/${owner.id}/entity-policies/projects/project`;
    const headers = {
      'content-type': 'application/json',
      'x-test-user': 'superUser',
    };

    const invalidScope = await app.request(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        effect: 'allow',
        scopes: [{ kind: 'department', departmentIds: [] }],
        fields: {},
      }),
    });
    expect(invalidScope.status).toBe(400);
    expect(await invalidScope.json()).toMatchObject({
      error: expect.stringContaining('not supported'),
    });

    const invalidField = await app.request(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        effect: 'allow',
        scopes: [{ kind: 'own' }],
        fields: {
          undeclared: { read: 'full', write: false, export: false },
        },
      }),
    });
    expect(invalidField.status).toBe(400);
    expect(await invalidField.json()).toMatchObject({
      error: expect.stringContaining('not declared'),
    });

    const contradictoryField = await app.request(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        effect: 'allow',
        scopes: [{ kind: 'own' }],
        fields: {
          title: { read: 'none', write: true, export: false },
        },
      }),
    });
    expect(contradictoryField.status).toBe(400);
    expect(await contradictoryField.json()).toMatchObject({
      error: expect.stringContaining('cannot be writable'),
    });

    const saved = await app.request(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        effect: 'allow',
        scopes: [{ kind: 'own' }],
        fields: {
          title: { read: 'masked', write: true, export: false },
        },
      }),
    });
    expect(saved.status).toBe(200);

    const effective = await app.request(`/api/admin/platform/users/${owner.id}/effective`, {
      headers: { 'x-test-user': 'superUser' },
    });
    expect(effective.status).toBe(200);
    expect((await effective.json()).entityPolicies).toContainEqual(
      expect.objectContaining({
        appId: 'projects',
        entityId: 'project',
        override: expect.objectContaining({
          effect: 'allow',
          policy: {
            scopes: [{ kind: 'own' }],
            fields: {
              title: { read: 'masked', write: true, export: false },
            },
          },
        }),
      }),
    );

    const roles = await app.request('/api/admin/platform/roles', {
      headers: { 'x-test-user': 'superUser' },
    });
    expect((await roles.json()).userEntityPolicies).toContainEqual(
      expect.objectContaining({
        user_id: owner.id,
        app_id: 'projects',
        entity_id: 'project',
      }),
    );

    const cleared = await app.request(endpoint, {
      method: 'DELETE',
      headers: { 'x-test-user': 'superUser' },
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ success: true });

    const afterClear = await app.request(`/api/admin/platform/users/${owner.id}/effective`, {
      headers: { 'x-test-user': 'superUser' },
    });
    const projectPolicy = (await afterClear.json()).entityPolicies.find(
      (entry: { appId: string; entityId: string }) => entry.appId === 'projects' && entry.entityId === 'project',
    );
    expect(projectPolicy.override).toBeUndefined();
  });

  it('persists only visible applications in the user workbench', async () => {
    await setupActors();
    const app = createPlatformHttpApp({ owner });

    const initial = await app.request('/api/platform/me/workbench', {
      headers: { 'x-test-user': 'owner' },
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      preferences: {
        version: 2,
        appOrder: [],
        pinnedAppIds: [],
        hiddenAppIds: [],
        defaultAppId: null,
        density: 'comfortable',
        tabs: [],
        widgets: [],
      },
    });

    const unavailable = await app.request('/api/platform/me/workbench', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'owner',
      },
      body: JSON.stringify({
        appOrder: ['analytics'],
        pinnedAppIds: [],
        hiddenAppIds: [],
        defaultAppId: null,
        density: 'comfortable',
      }),
    });
    expect(unavailable.status).toBe(400);
    expect(await unavailable.json()).toMatchObject({
      error: expect.stringContaining('unavailable application ID'),
    });

    const conflicting = await app.request('/api/platform/me/workbench', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'owner',
      },
      body: JSON.stringify({
        appOrder: ['projects'],
        pinnedAppIds: ['projects'],
        hiddenAppIds: ['projects'],
        defaultAppId: null,
        density: 'compact',
      }),
    });
    expect(conflicting.status).toBe(400);

    const saved = await app.request('/api/platform/me/workbench', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'owner',
      },
      body: JSON.stringify({
        appOrder: ['projects'],
        pinnedAppIds: ['projects'],
        hiddenAppIds: [],
        defaultAppId: 'projects',
        density: 'compact',
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      preferences: {
        version: 2,
        appOrder: ['projects'],
        pinnedAppIds: ['projects'],
        hiddenAppIds: [],
        defaultAppId: 'projects',
        density: 'compact',
        tabs: [],
        widgets: [],
      },
    });

    const savedPreferences = {
      version: 2 as const,
      appOrder: ['projects'],
      pinnedAppIds: ['projects'],
      hiddenAppIds: [],
      defaultAppId: 'projects',
      density: 'compact' as const,
      tabs: [],
      widgets: [],
    };
    await db.platform.setUserWorkbenchPreferences('default', owner.id, {
      ...savedPreferences,
      tabs: [{ id: 'agent-tab', title: 'Added by Agent', position: 0 }],
    });
    const staleWrite = await app.request('/api/platform/me/workbench', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'owner',
      },
      body: JSON.stringify({
        preferences: { ...savedPreferences, density: 'comfortable' },
        base: savedPreferences,
      }),
    });
    expect(staleWrite.status).toBe(409);
    expect(await staleWrite.json()).toMatchObject({ error: expect.stringContaining('changed') });
    await db.platform.setUserWorkbenchPreferences('default', owner.id, savedPreferences);

    await db.platform.setUserCapabilityOverride({
      org_id: 'default',
      user_id: owner.id,
      capability: 'projects.*',
      effect: 'deny',
      granted_by: owner.id,
    });
    const filtered = await app.request('/api/platform/me/workbench', {
      headers: { 'x-test-user': 'owner' },
    });
    expect(await filtered.json()).toEqual({
      preferences: {
        version: 2,
        appOrder: [],
        pinnedAppIds: [],
        hiddenAppIds: [],
        defaultAppId: null,
        density: 'compact',
        tabs: [],
        widgets: [],
      },
    });
  });
});
