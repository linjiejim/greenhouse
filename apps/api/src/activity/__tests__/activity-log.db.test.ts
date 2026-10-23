/**
 * The activity log on the real audit and Runtime tables: which changes count,
 * who may see them, how pages merge, and which objects get named.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { ActivityItem } from '@greenhouse/types/activity';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { projectsManifest } from '../../platform/manifests/projects.js';
import { knowledgeManifest } from '../../platform/manifests/knowledge.js';
import { tablesManifest } from '../../platform/manifests/tables.js';
import { PLATFORM_ORG_ID } from '../../platform/runtime.js';
import { ActivityQueryError, activityCsvRows, listActivity, verbOf, type ActivityQuery } from '../activity-log.js';

const manifests = [projectsManifest, knowledgeManifest, tablesManifest];

let db: DatabaseProvider;
let alice: UserRow;
let bob: UserRow;
let admin: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

async function audit(input: {
  actor: UserRow;
  appId: string;
  actionId: string;
  entityId?: string;
  recordId?: string;
  moduleId?: string;
  summary?: Record<string, unknown>;
  at: string;
}) {
  return db.platform.recordAudit({
    orgId: PLATFORM_ORG_ID,
    actorId: input.actor.id,
    actorType: 'human',
    requestId: unique('req'),
    resource: { appId: input.appId, moduleId: input.moduleId, entityId: input.entityId, recordId: input.recordId },
    actionId: input.actionId,
    capability: `${input.appId}.test`,
    result: 'success',
    summary: input.summary,
    createdAt: input.at,
  });
}

async function agentWrite(owner: UserRow, toolId: string, action: string) {
  return db.runtime.createRun({
    kind: 'agent_write',
    owner_user_id: owner.id,
    initiated_by_user_id: owner.id,
    source_kind: 'proxy_call',
    source_id: unique('awr'),
    max_attempts: 1,
    input: {
      version: 1,
      channel: 'mcp',
      client_id: 'c1',
      client_name: 'Claude Code',
      tool_id: toolId,
      action,
      input: {},
    },
    actor_user_id: owner.id,
  });
}

async function all(viewer: UserRow, query: ActivityQuery = {}): Promise<ActivityItem[]> {
  return (await listActivity(db, viewer, query, { manifests })).items;
}

const mine = (items: ActivityItem[], ...people: UserRow[]) =>
  items.filter((item) => people.some((person) => person.id === item.actor.id));

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  alice = await createInternalTestUser(db, { email: `${unique('act-alice')}@test.local`, nickname: 'Alice' });
  bob = await createInternalTestUser(db, { email: `${unique('act-bob')}@test.local`, nickname: 'Bob' });
  admin = await createInternalTestUser(db, { email: `${unique('act-admin')}@test.local`, role: 'super' });

  await audit({ actor: alice, appId: 'projects', actionId: 'createProject', entityId: 'project', at: minutesAgo(50) });
  // A read is audited too, and is never activity.
  await audit({ actor: alice, appId: 'projects', actionId: 'listProjects', entityId: 'project', at: minutesAgo(45) });
  await audit({
    actor: bob,
    appId: 'drive',
    actionId: 'uploadFile',
    entityId: 'file',
    recordId: '1',
    moduleId: 'files',
    summary: { name: 'team.pdf', scope: 'kb', visibility: 'team', owner_user_id: null },
    at: minutesAgo(40),
  });
  await audit({
    actor: admin,
    appId: 'platform',
    actionId: 'updateWorkspaceSettings',
    moduleId: 'settings',
    entityId: 'workspaceSetting',
    summary: { set: ['LLM_MODEL', 'LLM_API_KEY'], cleared: [], secret_keys: ['LLM_API_KEY'] },
    at: minutesAgo(30),
  });
  await agentWrite(alice, 'knowledge_mutation', 'knowledge.update_doc');
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

describe('activity log', () => {
  it('shows a member only their own changes, including their agents', async () => {
    const items = await all(alice);
    expect(items.every((item) => item.actor.id === alice.id)).toBe(true);
    expect(items.map((item) => item.action).sort()).toEqual(['createProject', 'knowledge.update_doc']);

    const write = items.find((item) => item.source === 'agent')!;
    expect(write).toMatchObject({ agent: { client_name: 'Claude Code' }, module: 'knowledge', verb: 'update' });
    expect(write.run?.kind).toBe('agent_write');

    // A member cannot widen to someone else, nor see admin changes.
    expect(mine(await all(alice, { userId: bob.id }), bob)).toEqual([]);
    expect(await all(alice, { source: 'admin' })).toEqual([]);
  });

  it('shows a super everyone, narrows by person, source and module, and names only setting keys', async () => {
    const items = mine(await all(admin), alice, bob, admin);
    expect(items.map((item) => item.source).sort()).toEqual(['admin', 'agent', 'person', 'person']);

    const adminOnly = mine(await all(admin, { source: 'admin' }), admin);
    expect(adminOnly).toHaveLength(1);
    expect(adminOnly[0]).toMatchObject({ module: 'settings', detail: 'LLM_MODEL, LLM_API_KEY' });

    const bobs = await all(admin, { userId: bob.id });
    expect(bobs.map((item) => item.action)).toEqual(['uploadFile']);
    expect(bobs[0]).toMatchObject({ module: 'files', target: { label: 'team.pdf' } });

    const files = mine(await all(admin, { module: 'files' }), alice, bob, admin);
    expect(files.map((item) => item.action)).toEqual(['uploadFile']);
  });

  it('pages newest first on one cursor without repeats', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await listActivity(db, admin, { userId: alice.id, cursor, limit: 1 }, { manifests });
      seen.push(...page.items.map((item) => item.action));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(['knowledge.update_doc', 'createProject']);
  });

  it('never names a document the viewer cannot read', async () => {
    const doc = await db.knowledgeBase.create({
      doc_id: unique('secret'),
      title: 'Alice private plan',
      content: 'x',
      visibility: 'private',
      owner_user_id: alice.id,
    });
    await audit({
      actor: alice,
      appId: 'knowledge',
      actionId: 'updateDocument',
      entityId: 'document',
      recordId: String(doc.id),
      at: minutesAgo(1),
    });
    const ownView = (await all(alice)).find((item) => item.target?.id === String(doc.id));
    expect(ownView?.target?.label).toBe('Alice private plan');
    // A super sees the change, not the private title.
    const adminView = (await all(admin, { userId: alice.id })).find((item) => item.target?.id === String(doc.id));
    expect(adminView?.target?.label).toBeNull();
  });

  it('names the document an agent wrote only for a viewer who may read it, in the list and the CSV', async () => {
    const doc = await db.knowledgeBase.create({
      doc_id: unique('agent-secret'),
      title: 'Alice private roadmap',
      content: 'x',
      visibility: 'private',
      owner_user_id: alice.id,
    });
    await db.runtime.createRun({
      kind: 'agent_write',
      owner_user_id: alice.id,
      initiated_by_user_id: alice.id,
      source_kind: 'proxy_call',
      source_id: unique('awr'),
      max_attempts: 1,
      input: {
        client_name: 'Codex',
        tool_id: 'knowledge_mutation',
        action: 'knowledge.update_doc',
        input: { doc_id: doc.doc_id },
      },
      actor_user_id: alice.id,
    });
    const own = (await all(alice)).filter((item) => item.source === 'agent');
    expect(own.map((item) => item.target?.label)).toContain('Alice private roadmap');

    // The super sees the write, never the private title — on screen or in the export.
    const adminItems = await all(admin, { userId: alice.id, source: 'agent' });
    expect(adminItems.length).toBeGreaterThan(0);
    expect(adminItems.map((item) => item.target?.label)).not.toContain('Alice private roadmap');
    expect(activityCsvRows(adminItems).join('\n')).not.toContain('Alice private roadmap');
  });

  it('bounds the time window', async () => {
    await expect(all(admin, { from: '2020-01-01', to: '2026-01-01' })).rejects.toBeInstanceOf(ActivityQueryError);
    await expect(all(admin, { cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(ActivityQueryError);
    expect(mine(await all(admin, { from: minutesAgo(35), to: minutesAgo(25) }), alice, bob, admin)).toHaveLength(1);
  });
});

describe('verbOf', () => {
  it('reads the verb from action ids and tool actions', () => {
    expect(verbOf('createProject')).toBe('create');
    expect(verbOf('records.update')).toBe('update');
    expect(verbOf('files.delete')).toBe('delete');
    expect(verbOf('archiveDocument')).toBe('archive');
    expect(verbOf('moveTask')).toBe('move');
    expect(verbOf('submit')).toBe('create');
  });
});
