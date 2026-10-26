/**
 * The activity log on the real audit and Runtime tables: which changes count,
 * who may see them, how pages merge, and which objects get named.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { ActivityItem } from '@greenhouse/types/activity';
import type { RuntimeJsonValue } from '@greenhouse/types/runtime';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { projectsManifest } from '../../platform/manifests/projects.js';
import { knowledgeManifest } from '../../platform/manifests/knowledge.js';
import { tablesManifest } from '../../platform/manifests/tables.js';
import { initializePlatformRuntime, PLATFORM_ORG_ID, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { projectsRegistration } from '../../platform/projects/application.js';
import { humanActor } from '../../platform/actor.js';
import {
  ActivityQueryError,
  activityCsvRows,
  describeToolWrite,
  listActivity,
  verbOf,
  type ActivityQuery,
} from '../activity-log.js';

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

async function agentWrite(
  owner: UserRow,
  toolId: string,
  action: string,
  args: { [key: string]: RuntimeJsonValue } = {},
  result?: { [key: string]: RuntimeJsonValue },
) {
  const run = await db.runtime.createRun({
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
      input: args,
    },
    actor_user_id: owner.id,
  });
  if (!result) return run;
  // Settle it the way a governed write does, with the tool's result recorded.
  let current = run;
  for (const status of ['claimed', 'running', 'succeeded'] as const) {
    current = await db.runtime.transitionRun({
      id: current.id,
      expected_version: current.version,
      to_status: status,
      idempotency_key: `test:${current.id}:${status}`,
      actor_user_id: owner.id,
      ...(status === 'succeeded'
        ? { output: { basis: 'direct', result }, settled_at: new Date().toISOString() }
        : status === 'running'
          ? { projection_only: true }
          : {}),
    });
  }
  return current;
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
  resetPlatformRuntimeForTests();
  await db.close();
  _resetProvider();
});

describe('activity log', () => {
  it('shows a member only their own changes, including their agents', async () => {
    const items = await all(alice);
    expect(items.every((item) => item.actor.id === alice.id)).toBe(true);
    expect(items.map((item) => item.action).sort()).toEqual(['createProject', 'knowledge.update_doc']);

    const write = items.find((item) => item.source === 'agent')!;
    expect(write).toMatchObject({
      agent: { client_name: 'Claude Code' },
      module: 'knowledge',
      verb: 'update',
      entity: 'document',
    });
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

  it('names what an agent created from its result, only for a viewer who may read it', async () => {
    const doc = await db.knowledgeBase.create({
      doc_id: unique('agent-created'),
      title: 'Q4 customer interview notes',
      content: 'x',
      visibility: 'private',
      owner_user_id: alice.id,
    });
    await agentWrite(
      alice,
      'knowledge_mutation',
      'knowledge.create_doc',
      { title: 'Q4 customer interview notes', scope: 'personal' },
      { action: 'knowledge.create_doc', status: 'created', document: { id: doc.id, title: doc.title } },
    );
    const own = (await all(alice, { source: 'agent' })).find((item) => item.action === 'knowledge.create_doc')!;
    expect(own).toMatchObject({
      verb: 'create',
      entity: 'document',
      target: { id: String(doc.id), label: 'Q4 customer interview notes' },
    });
    expect(own.target?.url).toContain(String(doc.id));

    // The super sees that Alice's agent created a document — not which one.
    const seen = (await all(admin, { userId: alice.id, source: 'agent' })).find(
      (item) => item.action === 'knowledge.create_doc',
    )!;
    expect(seen).toMatchObject({ verb: 'create', entity: 'document', target: null });
  });

  it('says what each kind of agent write did to which kind of object', async () => {
    const project = await db.projects.createProject({
      title: unique('Agent launch'),
      owner_id: alice.id,
      visibility: 'public',
      created_by: alice.id,
    });
    await agentWrite(alice, 'project_mutation', 'project.update', { project_id: project.id });
    await agentWrite(alice, 'knowledge_mutation', 'knowledge.append_doc', { doc_id: unique('missing') });
    // A file the agent deleted is gone; its member still sees the name the write carried.
    await agentWrite(alice, 'files_mutation', 'files.delete', { file_id: 987654 }, { file: { name: 'old.pdf' } });

    const items = await all(alice, { source: 'agent' });
    const by = (action: string) => items.find((item) => item.action === action)!;
    expect(by('project.update')).toMatchObject({
      verb: 'update',
      entity: 'project',
      target: { label: project.title },
    });
    expect(by('knowledge.append_doc')).toMatchObject({ verb: 'update', entity: 'document', target: null });
    expect(by('files.delete')).toMatchObject({ verb: 'delete', entity: 'file', target: { label: 'old.pdf' } });
    expect(
      (await all(admin, { userId: alice.id, source: 'agent' })).find((i) => i.action === 'files.delete'),
    ).toMatchObject({ target: null });
  });

  it('names a project a person created or deleted, through the audit the projects app keeps', async () => {
    const runtime = initializePlatformRuntime(db, [projectsRegistration]);
    const created = await runtime.dispatch({
      actor: humanActor(alice),
      appId: 'projects',
      actionId: 'createProject',
      payload: { title: 'E2E launch plan', visibility: 'private' },
    });
    expect(created.ok).toBe(true);
    const projectId = (created as { data: { project: { id: number } } }).data.project.id;
    expect(created).not.toHaveProperty('audit');

    const createdRow = (await all(alice)).find((item) => item.action === 'createProject' && item.target)!;
    expect(createdRow).toMatchObject({
      verb: 'create',
      entity: 'project',
      target: { id: String(projectId), label: 'E2E launch plan' },
    });

    const removed = await runtime.dispatch({
      actor: humanActor(alice),
      appId: 'projects',
      actionId: 'deleteProject',
      payload: { projectId },
      resource: { appId: 'projects', moduleId: 'portfolio', entityId: 'project', recordId: String(projectId) },
    });
    expect(removed.ok).toBe(true);
    const deletedRow = (await all(alice)).find((item) => item.action === 'deleteProject')!;
    expect(deletedRow).toMatchObject({ verb: 'delete', target: { label: 'E2E launch plan', url: null } });
    // A super reads every project, so may see the name of one that is gone.
    const forAdmin = (await all(admin, { userId: alice.id })).find((item) => item.action === 'deleteProject')!;
    expect(forAdmin.target?.label).toBe('E2E launch plan');
  });

  it('reads a comment on a task as a comment on that task, and names a deleted one by its task', async () => {
    const project = await db.projects.createProject({
      title: unique('Comments'),
      owner_id: alice.id,
      visibility: 'public',
      created_by: alice.id,
    });
    const task = await db.projects.createTask({ project_id: project.id, title: 'Fix login', created_by: alice.id });
    const common = { actor: alice, appId: 'projects', entityId: 'comment' } as const;
    await audit({ ...common, actionId: 'addComment', recordId: String(task.id), at: minutesAgo(2) });
    await audit({
      ...common,
      actionId: 'deleteComment',
      recordId: '999999',
      summary: { task_id: task.id, project_id: project.id },
      at: minutesAgo(1),
    });
    const items = await all(alice, { module: 'projects' });
    expect(items.find((item) => item.action === 'addComment')).toMatchObject({
      verb: 'comment',
      entity: 'task',
      target: { label: 'Fix login' },
    });
    expect(items.find((item) => item.action === 'deleteComment')).toMatchObject({
      verb: 'delete',
      entity: 'comment',
      target: { label: 'Fix login' },
    });
  });

  it('leaves editor heartbeats out and reads a knowledge reorder as a move', async () => {
    const doc = await db.knowledgeBase.create({
      doc_id: unique('team-doc'),
      title: 'Team handbook',
      content: 'x',
      visibility: 'team',
      owner_user_id: bob.id,
    });
    const common = { actor: alice, appId: 'knowledge', actionId: 'updateDocument', entityId: 'document' } as const;
    await audit({
      ...common,
      recordId: String(doc.id),
      summary: { change: 'presence', activity: false },
      at: minutesAgo(3),
    });
    await audit({ ...common, recordId: String(doc.id), summary: { change: 'reorder' }, at: minutesAgo(2) });
    const rows = (await all(alice, { module: 'knowledge' })).filter((item) => item.target?.id === String(doc.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verb: 'move', entity: 'document', target: { label: 'Team handbook' } });
  });

  it('bounds the time window', async () => {
    await expect(all(admin, { from: '2020-01-01', to: '2026-01-01' })).rejects.toBeInstanceOf(ActivityQueryError);
    await expect(all(admin, { cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(ActivityQueryError);
    expect(mine(await all(admin, { from: minutesAgo(35), to: minutesAgo(25) }), alice, bob, admin)).toHaveLength(1);
  });
});

describe('describeToolWrite', () => {
  it('reads the verb from the action and the object from the tool, not the module', () => {
    expect(describeToolWrite('knowledge_mutation', 'knowledge.update_doc')).toEqual({
      verb: 'update',
      entity: 'document',
    });
    expect(describeToolWrite('knowledge_mutation', 'knowledge.create_doc')).toEqual({
      verb: 'create',
      entity: 'document',
    });
    expect(describeToolWrite('knowledge_mutation', 'knowledge.patch_doc').verb).toBe('update');
    expect(describeToolWrite('knowledge_mutation', 'knowledge.unshare_doc').verb).toBe('unshare');
    expect(describeToolWrite('files_mutation', 'folders.update')).toEqual({ verb: 'update', entity: 'folder' });
    expect(describeToolWrite('files_mutation', 'files.upload')).toEqual({ verb: 'create', entity: 'file' });
    expect(describeToolWrite('project_mutation', 'task.create')).toEqual({ verb: 'create', entity: 'task' });
    expect(describeToolWrite('project_mutation', 'comment.add')).toEqual({ verb: 'comment', entity: 'task' });
    expect(describeToolWrite('tables_mutation', 'records.batch_upsert')).toEqual({ verb: 'update', entity: 'record' });
    expect(describeToolWrite('automation_mutation', 'run_now')).toEqual({ verb: 'run', entity: 'automation' });
    expect(describeToolWrite('log_friction', 'wrong_params')).toEqual(
      db.extensions.feedback ? { verb: 'create', entity: 'friction' } : { verb: 'other', entity: null },
    );
    expect(describeToolWrite('report_render', null)).toEqual(
      db.extensions.reports ? { verb: 'create', entity: 'file' } : { verb: 'other', entity: null },
    );
    expect(describeToolWrite('crm_mutation', 'deals.frobnicate')).toEqual({ verb: 'other', entity: null });
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
