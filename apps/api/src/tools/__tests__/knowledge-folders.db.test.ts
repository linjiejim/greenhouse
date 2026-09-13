/**
 * Folder-placement contract for the knowledge agent tools (real PostgreSQL).
 *
 * knowledge_mutation resolves "a/b" folder paths against drive_folders
 * (scope='kb') with the same visibility rules the HTTP route enforces
 * (routes/knowledge.ts#validateFolderTarget). Misses must come back as
 * guiding errors — never as a doc silently filed at the root.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { knowledgeRegistration } from '../../platform/knowledge/registration.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { createKnowledgeMutationTool } from '../knowledge-mutation.js';
import { createKnowledgeQueryTool } from '../knowledge-query.js';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let user: UserRow;

async function execute(tool: unknown, input: unknown): Promise<Record<string, unknown>> {
  const executable = tool as {
    execute: (value: unknown, options: { toolCallId: string; messages: never[] }) => Promise<unknown>;
  };
  return (await executable.execute(input, {
    toolCallId: 'knowledge-folders-test',
    messages: [],
  })) as Record<string, unknown>;
}

async function teamFolder(name: string, parentId?: number) {
  return db.drive.createFolder({
    scope: 'kb',
    name,
    parent_id: parentId ?? null,
    visibility: 'team',
    created_by: user.id,
  });
}

describe('knowledge tools folder placement', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    initializePlatformRuntime(db, [knowledgeRegistration]);
    user = await createInternalTestUser(db, { email: 'kb-folders@test.com' });
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('creates a doc inside a nested team folder and reports the path', async () => {
    const root = await teamFolder('指南');
    const sub = await teamFolder('场景示例', root.id);
    const tool = createKnowledgeMutationTool(db, { userId: user.id });
    const res = await execute(tool, {
      action: 'knowledge.create_doc',
      scope: 'team',
      doc_id: 'guide/folder-create',
      title: '测试篇',
      content: '# 测试',
      folder: '指南/场景示例',
    });
    expect(res.status).toBe('created');
    expect((res.document as { folder?: string }).folder).toBe('指南/场景示例');
    const row = await db.knowledgeBase.get('guide/folder-create', 'shared');
    expect(row?.folder_id).toBe(sub.id);
  });

  it('rejects an unknown folder and lists the available siblings', async () => {
    await teamFolder('指南');
    const tool = createKnowledgeMutationTool(db, { userId: user.id });
    const res = await execute(tool, {
      action: 'knowledge.create_doc',
      scope: 'team',
      title: 'x',
      content: 'x',
      folder: '指北',
    });
    expect(String(res.error)).toContain('指北');
    expect(String(res.error)).toContain('指南');
    expect(res.status).toBeUndefined();
  });

  it('moves a doc into a folder and back to the root on update', async () => {
    const root = await teamFolder('指南');
    const tool = createKnowledgeMutationTool(db, { userId: user.id });
    await execute(tool, {
      action: 'knowledge.create_doc',
      scope: 'team',
      doc_id: 'guide/folder-move',
      title: 'm',
      content: 'body',
    });
    const moved = await execute(tool, {
      action: 'knowledge.update_doc',
      scope: 'team',
      doc_id: 'guide/folder-move',
      folder: '指南',
    });
    expect(moved.status).toBe('updated');
    expect((moved.document as { folder?: string }).folder).toBe('指南');
    let row = await db.knowledgeBase.get('guide/folder-move', 'shared');
    expect(row?.folder_id).toBe(root.id);

    const rooted = await execute(tool, {
      action: 'knowledge.update_doc',
      scope: 'team',
      doc_id: 'guide/folder-move',
      folder: '/',
    });
    expect(rooted.status).toBe('updated');
    row = await db.knowledgeBase.get('guide/folder-move', 'shared');
    expect(row?.folder_id).toBeNull();
  });

  it('scopes personal docs to the owner private tree — team folders are invisible', async () => {
    await teamFolder('指南');
    const tool = createKnowledgeMutationTool(db, { userId: user.id });
    const res = await execute(tool, {
      action: 'knowledge.create_doc',
      scope: 'personal',
      title: 'p',
      content: 'p',
      folder: '指南',
    });
    expect(String(res.error)).toContain('Folder not found');

    const mine = await db.drive.createFolder({
      scope: 'kb',
      name: '我的笔记',
      visibility: 'private',
      owner_user_id: user.id,
      created_by: user.id,
    });
    const ok = await execute(tool, {
      action: 'knowledge.create_doc',
      scope: 'personal',
      doc_id: 'personal/folder-doc',
      title: 'p2',
      content: 'p2',
      folder: '我的笔记',
    });
    expect(ok.status).toBe('created');
    const row = await db.knowledgeBase.get('personal/folder-doc', 'shared');
    expect(row?.folder_id).toBe(mine.id);
  });

  it('rejects an ambiguous folder name instead of guessing', async () => {
    await teamFolder('重名');
    await teamFolder('重名');
    const tool = createKnowledgeMutationTool(db, { userId: user.id });
    const res = await execute(tool, {
      action: 'knowledge.create_doc',
      scope: 'team',
      title: 'a',
      content: 'a',
      folder: '重名',
    });
    expect(String(res.error)).toContain('ambiguous');
  });

  it('knowledge_query get reports the folder path', async () => {
    const root = await teamFolder('指南');
    await teamFolder('快速上手', root.id);
    const mutation = createKnowledgeMutationTool(db, { userId: user.id });
    await execute(mutation, {
      action: 'knowledge.create_doc',
      scope: 'team',
      doc_id: 'guide/folder-query',
      title: 'q',
      content: 'q',
      folder: '指南/快速上手',
    });
    const query = createKnowledgeQueryTool(db, { userId: user.id });
    const res = await execute(query, { action: 'get', scope: 'team', doc_id: 'guide/folder-query' });
    expect(res.folder).toBe('指南/快速上手');
  });
});

/**
 * The folder tree as a READ surface — the `ls` the agent path was missing.
 *
 * Placement (above) already had coverage; what is new is that a model can see
 * which columns exist and scope a search to one of them. Both run against real
 * PostgreSQL because the interesting parts are the subtree expansion and the
 * `folder_id IN (…)` filter, neither of which a fake db would exercise.
 */
describe('knowledge_query folder navigation', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    initializePlatformRuntime(db, [knowledgeRegistration]);
    user = await createInternalTestUser(db, { email: 'kb-tree@test.com' });
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  /** One column with a subfolder, a doc in each, plus a doc outside entirely. */
  async function seedColumns(prefix: string) {
    const mutation = createKnowledgeMutationTool(db, { userId: user.id });
    const product = await teamFolder(`${prefix}产品`);
    await teamFolder(`${prefix}智能种植机`, product.id);
    const create = (docId: string, title: string, content: string, folder?: string) =>
      execute(mutation, {
        action: 'knowledge.create_doc',
        scope: 'team',
        doc_id: docId,
        title,
        content,
        ...(folder ? { folder } : {}),
      });
    await create(`${prefix}/overview`, `${prefix}产品总览`, '总览正文', `${prefix}产品`);
    await create(`${prefix}/lph`, `${prefix}LPH-Max 规格`, '规格参数 正文', `${prefix}产品/${prefix}智能种植机`);
    await create(`${prefix}/sop`, `${prefix}发布流程`, '发布 SOP 正文');
    return product;
  }

  it('tree lists folders with the docs filed in each, including empty ones', async () => {
    const prefix = `t${Date.now()}`;
    await seedColumns(prefix);
    await teamFolder(`${prefix}空栏目`);

    const query = createKnowledgeQueryTool(db, { userId: user.id });
    const res = await execute(query, { action: 'tree', scope: 'team' });
    const folders = res.folders as Array<{ path: string; docs: Array<{ id: number; title: string }> }>;
    const byPath = new Map(folders.map((f) => [f.path, f]));

    expect(byPath.get(`${prefix}产品`)?.docs.map((d) => d.title)).toEqual([`${prefix}产品总览`]);
    expect(byPath.get(`${prefix}产品/${prefix}智能种植机`)?.docs.map((d) => d.title)).toEqual([
      `${prefix}LPH-Max 规格`,
    ]);
    // A column that exists but is empty is a real answer, so it must appear.
    expect(byPath.get(`${prefix}空栏目`)?.docs).toEqual([]);
    // Root-level docs are reachable too.
    expect(byPath.get('/')?.docs.some((d) => d.title === `${prefix}发布流程`)).toBe(true);
  });

  it('tree can be rooted at one column and then shows only its subtree', async () => {
    const prefix = `r${Date.now()}`;
    await seedColumns(prefix);

    const query = createKnowledgeQueryTool(db, { userId: user.id });
    const res = await execute(query, { action: 'tree', scope: 'team', folder: `${prefix}产品` });
    const folders = res.folders as Array<{ path: string; docs: Array<{ title: string }> }>;

    expect(res.root).toBe(`${prefix}产品`);
    expect(folders.map((f) => f.path).sort()).toEqual([`${prefix}产品`, `${prefix}产品/${prefix}智能种植机`].sort());
    // The root-level SOP is outside this subtree and must not leak in.
    expect(folders.flatMap((f) => f.docs).some((d) => d.title.includes('发布流程'))).toBe(false);
  });

  it('search scoped to a folder excludes matches outside its subtree', async () => {
    const prefix = `s${Date.now()}`;
    await seedColumns(prefix);
    const query = createKnowledgeQueryTool(db, { userId: user.id });

    const scoped = await execute(query, {
      action: 'search',
      scope: 'team',
      query: '正文',
      folder: `${prefix}产品`,
    });
    const scopedTitles = (scoped.results as Array<{ title: string }>).map((r) => r.title);
    expect(scopedTitles).toContain(`${prefix}产品总览`);
    // Subfolders are included …
    expect(scopedTitles).toContain(`${prefix}LPH-Max 规格`);
    // … and anything filed outside the column is not.
    expect(scopedTitles).not.toContain(`${prefix}发布流程`);
    expect(scoped.folder).toBe(`${prefix}产品`);

    const unscoped = await execute(query, { action: 'search', scope: 'team', query: '正文' });
    expect((unscoped.results as Array<{ title: string }>).map((r) => r.title)).toContain(`${prefix}发布流程`);
  });

  it('search results carry the folder path so the model can weigh them', async () => {
    const prefix = `p${Date.now()}`;
    await seedColumns(prefix);
    const query = createKnowledgeQueryTool(db, { userId: user.id });
    const res = await execute(query, { action: 'search', scope: 'team', query: '规格参数' });
    const hit = (res.results as Array<{ title: string; folder?: string }>).find((r) => r.title.includes('LPH-Max'));
    expect(hit?.folder).toBe(`${prefix}产品/${prefix}智能种植机`);
  });

  it('names the available folders when the requested one does not exist', async () => {
    const prefix = `e${Date.now()}`;
    await seedColumns(prefix);
    const query = createKnowledgeQueryTool(db, { userId: user.id });
    const res = await execute(query, { action: 'search', scope: 'team', query: 'x', folder: `${prefix}不存在` });
    expect(String(res.error)).toContain('Available folders');
  });

  /**
   * A folder filter must never widen. If the subtree is empty the answer is an
   * empty result set, not the whole library — the failure would be silent and
   * would read as a confident, wrongly-scoped answer.
   */
  it('an empty folder returns nothing rather than falling back to everything', async () => {
    const prefix = `z${Date.now()}`;
    await seedColumns(prefix);
    await teamFolder(`${prefix}空栏目`);
    const query = createKnowledgeQueryTool(db, { userId: user.id });
    const res = await execute(query, {
      action: 'search',
      scope: 'team',
      query: '正文',
      folder: `${prefix}空栏目`,
    });
    expect(res.found).toBe(0);
  });

  /**
   * Personal folders are a different tree; a team-scoped browse must not see
   * them even though both live in the same drive_folders table.
   */
  it('team tree never shows personal folders', async () => {
    const prefix = `x${Date.now()}`;
    await db.drive.createFolder({
      scope: 'kb',
      name: `${prefix}我的笔记`,
      parent_id: null,
      visibility: 'private',
      owner_user_id: user.id,
      created_by: user.id,
    });
    const query = createKnowledgeQueryTool(db, { userId: user.id });
    const res = await execute(query, { action: 'tree', scope: 'team' });
    const paths = (res.folders as Array<{ path: string }>).map((f) => f.path);
    expect(paths).not.toContain(`${prefix}我的笔记`);

    const personal = await execute(query, { action: 'tree', scope: 'personal' });
    expect((personal.folders as Array<{ path: string }>).map((f) => f.path)).toContain(`${prefix}我的笔记`);
  });
});
