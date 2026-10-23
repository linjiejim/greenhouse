/**
 * Home "recent changes" on the real tables: it shows team changes across
 * domains, never what the viewer may not read, and names the agent behind a
 * change when a recorded agent write covers it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import {
  initializePlatformRuntime,
  resetPlatformRuntimeForTests,
  type PlatformRuntime,
} from '../../platform/runtime.js';
import { projectsRegistration } from '../../platform/projects/application.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { knowledgeRegistration } from '../../platform/knowledge/registration.js';
import { listRecentChanges } from '../recent-changes.js';
import type { ToolRegistry } from '../../agent.js';
import { governProxyWrite } from '../../agent-access/governed-write.js';

let db: DatabaseProvider;
let runtime: PlatformRuntime;
let alice: UserRow;
let bob: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function doc(owner: UserRow, visibility: 'team' | 'private', title: string) {
  const row = await db.knowledgeBase.create({
    doc_id: unique('doc'),
    title,
    content: 'x',
    visibility,
    owner_user_id: visibility === 'private' ? owner.id : undefined,
  });
  await db.knowledgeBase.createVersion(row, owner.id, 'edit');
  return row;
}

const feed = (viewer: UserRow) => listRecentChanges(db, viewer, { limit: 50 }, { runtime });

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
    const open = await db.projects.createProject({
      title: unique('Open project'),
      owner_id: alice.id,
      created_by: alice.id,
      visibility: 'public',
    });
    const closed = await db.projects.createProject({
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
    const project = await db.projects.createProject({
      title: unique('Public project'),
      owner_id: alice.id,
      created_by: alice.id,
      visibility: 'public',
    });
    const task = await db.projects.createTask({
      project_id: project.id,
      title: unique('Hidden task'),
      created_by: alice.id,
    });
    expect((await feed(bob)).map((item) => item.target?.label)).toContain(task.title);

    // Bob may read the project but not its tasks: the task row disappears, the project row stays.
    await db.platform.setUserCapabilityOverride({
      org_id: 'default',
      user_id: bob.id,
      capability: 'projects.execution.read',
      effect: 'deny',
      granted_by: alice.id,
      reason: 'Test restriction',
    });
    const labels = (await feed(bob)).map((item) => item.target?.label);
    expect(labels).not.toContain(task.title);
    expect(labels).toContain(project.title);
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
      redirect_uris: '[]',
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
});
