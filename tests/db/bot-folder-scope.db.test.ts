/**
 * A Bot's private reference folder (spec 20261007 §2.5): the owner's other
 * Bots and identity-less agent surfaces never see it, the owner's own UI
 * always does, and scope "bot" is exactly that Bot's folder.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { BotRow, DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { botFolderScope, ensureBotFolder } from '../../apps/api/src/bots/folder.js';
import { searchKnowledgeScopes } from '../../apps/api/src/knowledge/search.js';
import { createKnowledgeQueryTool } from '../../apps/api/src/tools/knowledge-query.js';
import { knowledgeRegistration } from '../../apps/api/src/platform/knowledge/registration.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../apps/api/src/platform/runtime.js';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let writer: BotRow;
let analyst: BotRow;
let stamp: string;

function unique(label: string) {
  return `${label}-${Date.now()}-${Math.random()}`;
}

async function createDoc(title: string, folderId: number | null) {
  return db.knowledgeBase.create({
    doc_id: unique('doc'),
    scope: 'shared',
    title,
    content: `${title} body about ${stamp}`,
    content_json: '{}',
    visibility: 'private',
    folder_id: folderId,
    status: 'published',
    owner_user_id: owner.id,
    created_by: owner.id,
    updated_by: owner.id,
  });
}

async function run(botId: string | null | undefined, input: Record<string, unknown>) {
  const tool = createKnowledgeQueryTool(db, botId === undefined ? { userId: owner.id } : { userId: owner.id, botId });
  return (await tool.execute!(input as never, { toolCallId: 't', messages: [] })) as Record<string, any>;
}

describe('Bot reference folders', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    initializePlatformRuntime(db, [knowledgeRegistration]);
    owner = await createInternalTestUser(db, { email: `${unique('folder-owner')}@test.local` });
    stamp = unique('topic').replace(/[^a-z0-9]/gi, '');
    writer = await db.bots.createBot({ user_id: owner.id, name: unique('W').slice(0, 20), instructions: 'Write.' });
    analyst = await db.bots.createBot({ user_id: owner.id, name: unique('A').slice(0, 20), instructions: 'Count.' });
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('creates one folder per Bot, named after it, and scopes the personal library per identity', async () => {
    const writerFolder = await ensureBotFolder(db, writer);
    expect(await ensureBotFolder(db, writer)).toMatchObject({ id: writerFolder.id });
    expect(writerFolder).toMatchObject({
      scope: 'kb',
      visibility: 'private',
      owner_user_id: owner.id,
      bot_id: writer.id,
    });
    const analystFolder = await ensureBotFolder(db, analyst);

    const styleGuide = await createDoc(`Style guide ${stamp}`, writerFolder.id);
    const sqlNotes = await createDoc(`SQL notes ${stamp}`, analystFolder.id);
    const plain = await createDoc(`Plain note ${stamp}`, null);

    const asWriter = await botFolderScope(db, owner.id, writer.id);
    expect(asWriter.ownFolderIds).toEqual([writerFolder.id]);
    expect(asWriter.excludeFolderIds).toEqual([analystFolder.id]);
    const asNobody = await botFolderScope(db, owner.id, null);
    expect(asNobody.ownFolderIds).toBeNull();
    expect(asNobody.excludeFolderIds.sort()).toEqual([writerFolder.id, analystFolder.id].sort());

    // Search: the owner's UI (no exclusion) sees everything; the writer Bot sees its own files and the
    // plain note, never the analyst's; an identity-less surface sees only the plain note.
    const titles = (hits: Array<{ id: number }>) => hits.map((h) => h.id).sort();
    const all = await searchKnowledgeScopes(db, owner.id, stamp, 'personal', 20);
    expect(titles(all)).toEqual([styleGuide.id, sqlNotes.id, plain.id].sort());
    const writerHits = await searchKnowledgeScopes(db, owner.id, stamp, 'personal', 20, {
      excludeFolderIds: asWriter.excludeFolderIds,
    });
    expect(titles(writerHits)).toEqual([styleGuide.id, plain.id].sort());
    const nobodyHits = await searchKnowledgeScopes(db, owner.id, stamp, 'personal', 20, {
      excludeFolderIds: asNobody.excludeFolderIds,
    });
    expect(titles(nobodyHits)).toEqual([plain.id]);
  });

  it('the knowledge_query tool applies the scope: personal minus other Bots, "bot" = own folder only', async () => {
    const writerFolder = await ensureBotFolder(db, writer);
    const analystFolder = await ensureBotFolder(db, analyst);
    const styleGuide = await createDoc(`Style guide ${stamp}`, writerFolder.id);
    const sqlNotes = await createDoc(`SQL notes ${stamp}`, analystFolder.id);
    const plain = await createDoc(`Plain note ${stamp}`, null);
    const ids = (r: Record<string, any>) => (r.results as Array<{ id: number }>).map((h) => h.id).sort();

    expect(ids(await run(writer.id, { action: 'list', scope: 'personal', query: stamp }))).toEqual(
      [styleGuide.id, plain.id].sort(),
    );
    expect(ids(await run(writer.id, { action: 'list', scope: 'bot', query: stamp }))).toEqual([styleGuide.id]);
    expect(ids(await run(null, { action: 'list', scope: 'personal', query: stamp }))).toEqual([plain.id]);
    // The owner's own surface (no identity passed) keeps the whole library.
    expect(ids(await run(undefined, { action: 'list', scope: 'personal', query: stamp }))).toEqual(
      [styleGuide.id, sqlNotes.id, plain.id].sort(),
    );

    // Reading by id follows the same rule, and the tree never lists the hidden folder.
    expect((await run(writer.id, { action: 'get', scope: 'personal', doc_id: String(sqlNotes.id) })).error).toMatch(
      /not found/i,
    );
    expect((await run(writer.id, { action: 'get', scope: 'bot', doc_id: String(plain.id) })).error).toMatch(
      /not found/i,
    );
    expect((await run(writer.id, { action: 'get', scope: 'bot', doc_id: String(styleGuide.id) })).id).toBe(
      styleGuide.id,
    );
    const tree = await run(writer.id, { action: 'tree', scope: 'personal' });
    const paths = (tree.folders as Array<{ path: string }>).map((f) => f.path);
    expect(paths).toContain(writerFolder.name);
    expect(paths).not.toContain(analystFolder.name);
    // Without a Bot identity, scope "bot" is refused rather than widened.
    expect((await run(null, { action: 'list', scope: 'bot' })).error).toMatch(/only available/);
  });
});
