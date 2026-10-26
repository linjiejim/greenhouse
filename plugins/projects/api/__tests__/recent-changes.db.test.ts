import { services as knowledgeServices } from '../../../knowledge/api/services.js';
import { services as tableServices } from '../../../tables/api/services.js';
import { services as projectsServices } from '../services.js';
/**
 * Home "recent changes" on the real tables: it shows team changes across
 * domains, never what the viewer may not read, and names the agent behind a
 * change when a recorded agent write covers it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';
import {
  initializePlatformRuntime,
  resetPlatformRuntimeForTests,
  type PlatformRuntime,
} from '../../../../apps/api/src/platform/runtime.js';
import { projectsRegistration } from '../platform/application.js';
import { tablesRegistration } from '../../../tables/api/platform/application.js';
import { knowledgeRegistration } from '../../../knowledge/api/platform/registration.js';
import { listRecentChanges } from '../../../../apps/api/src/activity/recent-changes.js';
import type { ActivityItem } from '@greenhouse/types/activity';
import { sql } from 'drizzle-orm';
import type { ToolRegistry } from '../../../../apps/api/src/agent.js';
import { governProxyWrite } from '../../../../apps/api/src/agent-access/governed-write.js';
import { moveToRestrictedRole, withoutCapability } from '../../../../tests/helpers/restricted-role.js';
import { projectsManifest } from '../platform/manifest.js';

let db: DatabaseProvider;
let runtime: PlatformRuntime;
let alice: UserRow;
let bob: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function doc(owner: UserRow, visibility: 'team' | 'private', title: string) {
  const row = await knowledgeServices(db).knowledgeBase.create({
    doc_id: unique('doc'),
    title,
    content: 'x',
    visibility,
    owner_user_id: visibility === 'private' ? owner.id : undefined,
  });
  await knowledgeServices(db).knowledgeBase.createVersion(row, owner.id, 'edit');
  return row;
}

const feed = async (viewer: UserRow) => (await listRecentChanges(db, viewer, { limit: 50 }, { runtime })).items;

/** Every item a viewer reaches by following next_before with small pages. */
async function pageThrough(viewer: UserRow, limit: number) {
  const items: ActivityItem[] = [];
  let before: string | null = null;
  for (let page = 0; page < 200; page++) {
    const result = await listRecentChanges(db, viewer, { limit, before }, { runtime });
    expect(result.items.length).toBeLessThanOrEqual(limit);
    items.push(...result.items);
    if (!result.next_before) return items;
    before = result.next_before;
  }
  throw new Error('paging did not end');
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  runtime = initializePlatformRuntime(db, [projectsRegistration, tablesRegistration, knowledgeRegistration]);
  alice = await createInternalTestUser(db, { email: `${unique('rc-alice')}@test.local`, nickname: 'Alice' });
  bob = await createInternalTestUser(db, { email: `${unique('rc-bob')}@test.local`, nickname: 'Bob' });
});

afterEach(async () => {
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});

describe('recent changes', () => {
  it('shows team knowledge edits and public project changes to everyone, private ones only to whoever may read them', async () => {
    const team = await doc(alice, 'team', unique('Team handbook'));
    const secret = await doc(alice, 'private', unique('Alice private'));
    const open = await projectsServices(db).projects.createProject({
      title: unique('Open project'),
      owner_id: alice.id,
      created_by: alice.id,
      visibility: 'public',
    });
    const closed = await projectsServices(db).projects.createProject({
      title: unique('Closed project'),
      owner_id: alice.id,
      created_by: alice.id,
      visibility: 'private',
    });

    const bobs = await feed(bob);
    const labels = bobs.map((item) => item.target?.label);
    expect(labels).toContain(team.title);
    expect(labels).toContain(open.title);
    expect(labels).not.toContain(secret.title);
    expect(labels).not.toContain(closed.title);
    const edit = bobs.find((item) => item.target?.label === team.title)!;
    expect(edit).toMatchObject({ module: 'knowledge', entity: 'document', actor: { id: alice.id, name: 'Alice' } });
    expect(edit.target?.url).toMatch(/^#\/knowledge\/doc\//);

    const alices = (await feed(alice)).map((item) => item.target?.label);
    expect(alices).toEqual(expect.arrayContaining([team.title, secret.title, open.title, closed.title]));
  });

  it('shows a task change only to a viewer the task-aware listing lets read it', async () => {
    const project = await projectsServices(db).projects.createProject({
      title: unique('Public project'),
      owner_id: alice.id,
      created_by: alice.id,
      visibility: 'public',
    });
    const task = await projectsServices(db).projects.createTask({
      project_id: project.id,
      title: unique('Hidden task'),
      created_by: alice.id,
    });
    expect((await feed(bob)).map((item) => item.target?.label)).toContain(task.title);

    // Bob may read the project but not its tasks: the task row disappears, the project row stays.
    const projectCapabilities = [
      ...new Set(Object.values(projectsManifest.actions).map((action) => action.capability)),
    ];
    await moveToRestrictedRole(db, bob.id, {
      capabilities: withoutCapability('projects.execution.read', { 'projects.*': projectCapabilities }),
    });
    const labels = (await feed(bob)).map((item) => item.target?.label);
    expect(labels).not.toContain(task.title);
    expect(labels).toContain(project.title);
  });

  it('authorizes just the tasks its rows name, with shared lookups made once', async () => {
    const project = await projectsServices(db).projects.createProject({
      title: unique('Busy project'),
      owner_id: alice.id,
      created_by: alice.id,
      visibility: 'public',
    });
    const titles: string[] = [];
    for (let i = 0; i < 20; i++) {
      const task = await projectsServices(db).projects.createTask({
        project_id: project.id,
        title: unique(`Task ${i}`),
        created_by: alice.id,
      });
      titles.push(task.title);
    }
    const listTasks = vi.spyOn(projectsServices(db).projects, 'listTasks');
    const getMembers = vi.spyOn(projectsServices(db).projects, 'getMembers');
    const getTaskById = vi.spyOn(projectsServices(db).projects, 'getTaskById');
    const policies = vi.spyOn(db.platform, 'getEntityPolicySnapshot');
    try {
      const labels = (await feed(bob)).map((item) => item.target?.label);
      expect(labels).toEqual(expect.arrayContaining(titles));
      // No whole-project task listing; one task read per task row; members and
      // the task policy loaded once for the request, not once per task.
      expect(listTasks).not.toHaveBeenCalled();
      expect(getTaskById.mock.calls.length).toBeLessThanOrEqual(20);
      expect(getMembers.mock.calls.filter(([id]) => id === project.id)).toHaveLength(1);
      expect(policies.mock.calls.filter(([input]) => input.entityId === 'task')).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('shows new team files, not someone else’s personal ones', async () => {
    const make = async (visibility: 'team' | 'private', name: string) => {
      const row = await db.drive.initFile({
        scope: 'kb',
        name,
        cos_key: `drive/test/${unique('k')}`,
        visibility,
        owner_user_id: visibility === 'private' ? alice.id : null,
        uploaded_by: alice.id,
      });
      return db.drive.completeFile(row.id, { size: 1 });
    };
    const teamName = `${unique('plan')}.pdf`;
    const privateName = `${unique('mine')}.pdf`;
    await make('team', teamName);
    await make('private', privateName);
    const labels = (await feed(bob)).map((item) => item.target?.label);
    expect(labels).toContain(teamName);
    expect(labels).not.toContain(privateName);
  });

  it('says which agent made a change when a recorded agent write covers it', async () => {
    const client = await db.platformOAuth.registerClient({
      id: unique('client'),
      client_name: 'Claude Code',
      redirect_uris: [],
      created_by: alice.id,
    });
    let title = '';
    // A stand-in knowledge write that saves a version, run through the real recorded-write path.
    const registry = {
      knowledge_mutation: {
        execute: async () => {
          title = (await doc(alice, 'team', unique('Agent edited'))).title;
          return { ok: true };
        },
      },
    } as unknown as ToolRegistry;
    const written = await governProxyWrite({
      db,
      caller: { userId: alice.id, clientId: client.id, clientName: 'Claude Code', authMethod: 'oauth' },
      toolId: 'knowledge_mutation',
      input: { action: 'knowledge.update_doc' },
      registry,
      allowedToolIds: ['knowledge_mutation'],
      baseRisk: 'r2',
      confirmed: false,
    });
    expect(written.status).toBe('executed');

    const edit = (await feed(bob)).find((item) => item.target?.label === title)!;
    expect(edit).toMatchObject({ source: 'agent', agent: { client_name: 'Claude Code' } });
    // A person's own edit stays theirs.
    const manual = await doc(alice, 'team', unique('By hand'));
    expect((await feed(bob)).find((item) => item.target?.label === manual.title)).toMatchObject({
      source: 'person',
      agent: null,
    });
  });

  it('pages with an opaque cursor: no repeats, newest first, nothing skipped, same window', async () => {
    const titles: string[] = [];
    for (let i = 0; i < 3; i++) titles.push((await doc(alice, 'team', unique(`Paged ${i}`))).title);
    const items = await pageThrough(bob, 2);
    const ids = items.map((item) => item.id);
    expect(new Set(ids).size, 'an item repeated across pages').toBe(ids.length);
    for (let i = 1; i < items.length; i++) {
      expect(Date.parse(items[i].at)).toBeLessThanOrEqual(Date.parse(items[i - 1].at));
    }
    expect(items.map((item) => item.target?.label)).toEqual(expect.arrayContaining(titles));

    // A plain ISO timestamp (older clients) still pages: strictly older only.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(await listRecentChanges(db, bob, { limit: 2, before: old }, { runtime })).toEqual({
      items: [],
      next_before: null,
    });
  });

  it('does not skip changes that share the page boundary’s timestamp', async () => {
    const docs: Array<{ id: string; title: string }> = [];
    for (let i = 0; i < 5; i++) docs.push(await doc(alice, 'team', unique(`Same instant ${i}`)));
    const at = new Date(Date.now() - 60_000).toISOString();
    await db.executeRaw(
      sql`UPDATE kb_versions SET created_at = ${at}::timestamptz WHERE doc_id IN (${sql.join(
        docs.map((row) => sql`${row.id}`),
        sql`, `,
      )})`,
    );
    const labels = (await pageThrough(bob, 2)).map((item) => item.target?.label);
    expect(labels).toEqual(expect.arrayContaining(docs.map((row) => row.title)));
    expect(labels.filter((label) => docs.some((row) => row.title === label))).toHaveLength(5);
  });

  it('keeps reading past rows the viewer may not see instead of ending the feed early', async () => {
    const project = await projectsServices(db).projects.createProject({
      title: unique('Project under tasks'),
      owner_id: alice.id,
      created_by: alice.id,
      visibility: 'public',
    });
    for (let i = 0; i < 6; i++) {
      await projectsServices(db).projects.createTask({
        project_id: project.id,
        title: unique(`Unreadable ${i}`),
        created_by: alice.id,
      });
    }
    const projectCapabilities = [
      ...new Set(Object.values(projectsManifest.actions).map((action) => action.capability)),
    ];
    await moveToRestrictedRole(db, bob.id, {
      capabilities: withoutCapability('projects.execution.read', { 'projects.*': projectCapabilities }),
    });
    // The newest project rows are all about tasks Bob may not read; the project row is older.
    const labels = (await pageThrough(bob, 2)).map((item) => item.target?.label);
    expect(labels).toContain(project.title);
  });

  it('counts a person’s table edits once for the whole window, never split across pages', async () => {
    const base = await tableServices(db).tables.createBase({
      name: unique('Base'),
      visibility: 'team',
      owner_id: alice.id,
      created_by: alice.id,
    });
    const { table, fields } = await tableServices(db).tables.createTable({
      base_id: base.id,
      name: unique('Table'),
      created_by: alice.id,
    });
    const values = Object.fromEntries(fields.filter((field) => field.required).map((field) => [field.id, 'x']));
    for (let i = 0; i < 3; i++)
      await tableServices(db).tables.createRecord({ table_id: table.id, values, user_id: alice.id });
    await tableServices(db).tables.createRecord({ table_id: table.id, values, user_id: bob.id });

    const rows = (await pageThrough(alice, 1)).filter((item) => item.target?.id === String(table.id));
    expect(rows.map((item) => [item.actor.id, item.detail])).toEqual([
      [bob.id, '1'],
      [alice.id, '3'],
    ]);
  });
});
