/**
 * Apps storage (Tables → Apps Phase 1, slice F1) against real PostgreSQL,
 * rolled back per test: draft CAS, publish = hashed immutable version + the
 * live pointer in one transaction (hash verified on every read, text kept
 * byte-for-byte), restore = copy into the draft, audiences replaced under CAS,
 * "my / shared with me / featured" (group reach = `group_members` rows only),
 * pins, and the audit scope columns.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { _resetProvider, appSpecHash, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let builder: UserRow;
let member: UserRow;
let groupCreator: UserRow;
let outsider: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  [owner, builder, member, groupCreator, outsider] = await Promise.all(
    ['owner', 'builder', 'member', 'gcreator', 'outsider'].map((who) =>
      createInternalTestUser(db, { email: `apps-${who}-${tag}@test.local`, nickname: `Apps ${who}` }),
    ),
  );
});

afterEach(() => {
  _resetProvider();
});

// Key order and spacing are part of the stored bytes: jsonb would reorder them.
const SPEC_V1 = '{"version":1,"roles":[{"key":"all","name":"All","pages":"all","tables":[]}],  "pages":[]}';
const SPEC_V2 = '{"version":1,"pages":[],"roles":[{"key":"all","name":"Everyone","pages":"all","tables":[]}]}';

async function baseWithApp(name = 'Requests') {
  const base = await db.tables.createBase({ name: 'Apps Base', owner_id: owner.id, created_by: owner.id });
  const app = await db.tables.createApp({
    base_id: base.id,
    name,
    owner_id: owner.id,
    draft_spec: SPEC_V1,
    created_by: owner.id,
  });
  return { base, app };
}

describe('drafts and versions', () => {
  it('saves drafts under revision CAS', async () => {
    const { app } = await baseWithApp();
    expect(app).toMatchObject({ status: 'draft', draft_revision: 1, published_version: null, icon: 'app' });

    const saved = await db.tables.saveAppDraft(app.id, { spec: SPEC_V2, draftRevision: 1 });
    expect(saved).toMatchObject({ ok: true, value: { draft_revision: 2, draft_spec: SPEC_V2 } });

    const stale = await db.tables.saveAppDraft(app.id, { spec: SPEC_V1, draftRevision: 1 });
    expect(stale).toEqual({ ok: false, reason: 'conflict', current: 2 });
    expect(await db.tables.saveAppDraft(999_999_999, { spec: SPEC_V1, draftRevision: 1 })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('publishes the exact draft text as a hashed version and moves the live pointer', async () => {
    const { app } = await baseWithApp();
    const stale = await db.tables.publishApp(app.id, { draftRevision: 7, publishedBy: owner.id });
    expect(stale).toEqual({ ok: false, reason: 'conflict', current: 1 });

    const first = await db.tables.publishApp(app.id, { draftRevision: 1, notes: ' First ', publishedBy: owner.id });
    if (!first.ok) throw new Error('publish failed');
    expect(first.version).toMatchObject({
      version: 1,
      draft_revision: 1,
      notes: 'First',
      spec_hash: appSpecHash(SPEC_V1),
    });
    expect(first.app).toMatchObject({ status: 'published', published_version: 1 });

    // Round trip through the database keeps every byte (spacing, key order).
    const live = await db.tables.getPublishedAppVersion(app.id);
    expect(live?.spec).toBe(SPEC_V1);

    await db.tables.saveAppDraft(app.id, { spec: SPEC_V2, draftRevision: 1 });
    const second = await db.tables.publishApp(app.id, { draftRevision: 2, publishedBy: builder.id });
    expect(second).toMatchObject({ ok: true, version: { version: 2 }, app: { published_version: 2 } });
    expect((await db.tables.listAppVersions(app.id)).map((version) => version.version)).toEqual([2, 1]);
    expect(await db.tables.listAppVersions(app.id)).not.toContainEqual(expect.objectContaining({ spec: SPEC_V1 }));
  });

  it('refuses a version whose stored text no longer matches its hash', async () => {
    const { app } = await baseWithApp();
    await db.tables.publishApp(app.id, { draftRevision: 1, publishedBy: owner.id });
    await db.executeRaw(sql`UPDATE table_app_versions SET spec = ${SPEC_V2} WHERE app_id = ${app.id} AND version = 1`);
    await expect(db.tables.getAppVersion(app.id, 1)).rejects.toThrow(/hash mismatch/);
  });

  it('restores a version into the draft; publishing it makes a new, higher version', async () => {
    const { app } = await baseWithApp();
    await db.tables.publishApp(app.id, { draftRevision: 1, publishedBy: owner.id });
    await db.tables.saveAppDraft(app.id, { spec: SPEC_V2, draftRevision: 1 });
    await db.tables.publishApp(app.id, { draftRevision: 2, publishedBy: owner.id });

    expect(await db.tables.restoreAppVersion(app.id, { version: 1, draftRevision: 1 })).toEqual({
      ok: false,
      reason: 'conflict',
      current: 2,
    });
    expect(await db.tables.restoreAppVersion(app.id, { version: 9, draftRevision: 2 })).toEqual({
      ok: false,
      reason: 'version_not_found',
    });
    const restored = await db.tables.restoreAppVersion(app.id, { version: 1, draftRevision: 2 });
    expect(restored).toMatchObject({ ok: true, value: { draft_spec: SPEC_V1, draft_revision: 3 } });
    const third = await db.tables.publishApp(app.id, { draftRevision: 3, publishedBy: owner.id });
    expect(third).toMatchObject({ ok: true, version: { version: 3, spec_hash: appSpecHash(SPEC_V1) } });
  });

  it('freezes an archived app', async () => {
    const { app } = await baseWithApp();
    expect(await db.tables.archiveApp(app.id)).toMatchObject({ status: 'archived' });
    expect(await db.tables.saveAppDraft(app.id, { spec: SPEC_V2, draftRevision: 1 })).toEqual({
      ok: false,
      reason: 'archived',
    });
    expect(await db.tables.publishApp(app.id, { draftRevision: 1, publishedBy: owner.id })).toEqual({
      ok: false,
      reason: 'archived',
    });
    expect(await db.tables.updateApp(app.id, { name: 'Renamed' })).toBeUndefined();
  });
});

describe('audiences and who sees what', () => {
  async function publishedApp(name = 'Requests') {
    const { base, app } = await baseWithApp(name);
    await db.tables.publishApp(app.id, { draftRevision: 1, publishedBy: owner.id });
    return { base, app };
  }

  it('replaces audiences under CAS and refuses a principal twice', async () => {
    const { app } = await publishedApp();
    const group = await db.groups.create({ name: 'Finance', created_by: groupCreator.id });
    const replaced = await db.tables.replaceAppAudiences(app.id, {
      entries: [
        { principal_type: 'user', user_id: member.id, role_key: 'all' },
        { principal_type: 'group', group_id: group.id, role_key: 'all' },
        { principal_type: 'team', role_key: 'all' },
      ],
      audiencesRevision: 1,
      createdBy: owner.id,
    });
    if (!replaced.ok) throw new Error('replace failed');
    expect(replaced.app.audiences_revision).toBe(2);
    expect(replaced.audiences.map((row) => row.principal_type)).toEqual(['user', 'group', 'team']);

    expect(
      await db.tables.replaceAppAudiences(app.id, { entries: [], audiencesRevision: 1, createdBy: owner.id }),
    ).toEqual({ ok: false, reason: 'conflict', current: 2 });
    await expect(
      db.tables.replaceAppAudiences(app.id, {
        entries: [
          { principal_type: 'team', role_key: 'all' },
          { principal_type: 'team', role_key: 'all' },
        ],
        audiencesRevision: 2,
        createdBy: owner.id,
      }),
    ).rejects.toThrow(/once/);

    const cleared = await db.tables.replaceAppAudiences(app.id, {
      entries: [],
      audiencesRevision: 2,
      createdBy: owner.id,
    });
    expect(cleared).toMatchObject({ ok: true, audiences: [] });
    expect(await db.tables.listAppAudiences(app.id)).toEqual([]);
  });

  it('reaches a group through group_members rows only — never its creator', async () => {
    const { app } = await publishedApp();
    const group = await db.groups.create({ name: 'Approvers', created_by: groupCreator.id });
    await db.groups.addMembers(group.id, [member.id], groupCreator.id);
    await db.tables.replaceAppAudiences(app.id, {
      entries: [{ principal_type: 'group', group_id: group.id, role_key: 'approver' }],
      audiencesRevision: 1,
      createdBy: owner.id,
    });

    const sharedIds = async (user: UserRow) => (await db.tables.listAppsSharedWith(user.id)).map((row) => row.id);
    expect(await sharedIds(member)).toContain(app.id);
    expect(await sharedIds(groupCreator)).not.toContain(app.id);
    expect(await sharedIds(outsider)).not.toContain(app.id);
    expect(await db.tables.listAudienceMatches(app.id, member.id)).toEqual([
      expect.objectContaining({ principal_type: 'group', group_id: group.id, role_key: 'approver' }),
    ]);
    expect(await db.tables.listAudienceMatches(app.id, groupCreator.id)).toEqual([]);
  });

  it('shares only published, live apps; drafts and archived apps or Bases are not shared', async () => {
    const { base, app } = await publishedApp('Live');
    const draft = await db.tables.createApp({
      base_id: base.id,
      name: 'Draft',
      owner_id: owner.id,
      draft_spec: SPEC_V1,
      created_by: owner.id,
    });
    for (const target of [app, draft]) {
      await db.tables.replaceAppAudiences(target.id, {
        entries: [{ principal_type: 'team', role_key: 'all' }],
        audiencesRevision: 1,
        createdBy: owner.id,
      });
    }
    const shared = (await db.tables.listAppsSharedWith(outsider.id)).map((row) => row.id);
    expect(shared).toContain(app.id);
    expect(shared).not.toContain(draft.id);
    expect(await db.tables.listAppsSharedWith(outsider.id)).not.toContainEqual(
      expect.objectContaining({ draft_spec: expect.anything() }),
    );

    await db.tables.archiveBase(base.id);
    expect((await db.tables.listAppsSharedWith(outsider.id)).map((row) => row.id)).not.toContain(app.id);
  });

  it('lists managed apps for the Base owner, builders and the app owner — not editors', async () => {
    const { base, app } = await baseWithApp();
    await db.tables.upsertBaseMember({ base_id: base.id, user_id: builder.id, role: 'builder', added_by: owner.id });
    await db.tables.upsertBaseMember({ base_id: base.id, user_id: member.id, role: 'editor', added_by: owner.id });
    const managedIds = async (user: UserRow) => (await db.tables.listManagedApps(user.id)).map((row) => row.id);
    expect(await managedIds(owner)).toContain(app.id);
    expect(await managedIds(builder)).toContain(app.id);
    expect(await managedIds(member)).not.toContain(app.id);

    await db.tables.transferApp(app.id, outsider.id);
    expect(await managedIds(outsider)).toContain(app.id);

    await db.tables.archiveApp(app.id);
    expect(await managedIds(owner)).not.toContain(app.id);
    expect((await db.tables.listManagedApps(owner.id, { includeArchived: true })).map((row) => row.id)).toContain(
      app.id,
    );
  });

  it('recommends featured apps to their audience and managers only', async () => {
    const { app } = await publishedApp();
    await db.tables.replaceAppAudiences(app.id, {
      entries: [{ principal_type: 'user', user_id: member.id, role_key: 'all' }],
      audiencesRevision: 1,
      createdBy: owner.id,
    });
    const featuredIds = async (user: UserRow) => (await db.tables.listFeaturedAppsFor(user.id)).map((row) => row.id);
    expect(await featuredIds(member)).not.toContain(app.id);

    await db.tables.setAppFeatured(app.id, true);
    expect(await featuredIds(member)).toContain(app.id);
    expect(await featuredIds(owner)).toContain(app.id);
    expect(await featuredIds(outsider)).not.toContain(app.id);
  });
});

describe('pins and audit scope', () => {
  it('replaces pins in order, drops duplicates and cascades with the app', async () => {
    const { base, app } = await baseWithApp('One');
    const second = await db.tables.createApp({
      base_id: base.id,
      name: 'Two',
      owner_id: owner.id,
      draft_spec: SPEC_V1,
      created_by: owner.id,
    });
    const pins = await db.tables.setAppPins(member.id, [second.id, app.id, second.id]);
    expect(pins.map((pin) => [pin.app_id, pin.position])).toEqual([
      [second.id, 0],
      [app.id, 1],
    ]);
    await db.tables.setAppPins(member.id, [app.id]);
    expect((await db.tables.listAppPins(member.id)).map((pin) => pin.app_id)).toEqual([app.id]);
    await db.executeRaw(sql`DELETE FROM table_apps WHERE id = ${app.id}`);
    expect(await db.tables.listAppPins(member.id)).toEqual([]);
  });

  it('maps an app to its Base and files audit events under the scope the resource carries', async () => {
    const { base, app } = await baseWithApp();
    expect((await db.tables.baseIdsForResources('app', [app.id])).get(app.id)).toBe(base.id);

    const requestId = `apps-audit-${Date.now()}-${Math.random()}`;
    const event = (actionId: string, scope?: { scopeType: string; scopeId: string }) =>
      db.platform.recordAudit({
        orgId: 'default',
        actorId: owner.id,
        actorType: 'human',
        requestId,
        resource: { appId: 'tables', entityId: 'app', recordId: String(app.id), ...scope },
        actionId,
        capability: 'tables.apps.manage',
        result: 'success',
      });
    const scope = { scopeType: 'base', scopeId: String(base.id) };
    await event('updateApp', scope);
    await event('getApp', scope);
    const unscoped = await event('updateApp');
    expect(unscoped).toMatchObject({ scope_type: null, scope_id: null });

    const writes = await db.platform.listAuditEventsByScope({
      orgId: 'default',
      appId: 'tables',
      scopeType: 'base',
      scopeId: String(base.id),
      actionIds: ['updateApp'],
    });
    expect(writes.map((row) => [row.action_id, row.scope_id])).toEqual([['updateApp', String(base.id)]]);
    expect(
      await db.platform.listAuditEventsByScope({
        orgId: 'default',
        appId: 'tables',
        scopeType: 'base',
        scopeId: String(base.id),
        actionIds: [],
      }),
    ).toEqual([]);
  });
});
