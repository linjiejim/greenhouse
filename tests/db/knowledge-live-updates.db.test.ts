/**
 * Live knowledge updates (`knowledge.changed`) — the change hook and its audience.
 *
 * The hook sits in the knowledge service, so every write path emits: the web
 * route and the `knowledge_mutation` tool (chat, MCP, approved agent writes)
 * both call `knowledgeBase.create/update`. The audience comes from real share
 * rows, direct and through a group.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, onKnowledgeDocChange } from '@greenhouse/db';
import type { DatabaseProvider, KnowledgeDocChange } from '@greenhouse/db';
import type { ServerWsEvent } from '@greenhouse/types/ws';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { knowledgeRegistration } from '../../apps/api/src/platform/knowledge/registration.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../apps/api/src/platform/runtime.js';
import { createKnowledgeMutationTool } from '../../apps/api/src/tools/knowledge-mutation.js';
import { publishKnowledgeChange } from '../../apps/api/src/knowledge/live.js';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let changes: KnowledgeDocChange[];
let unsubscribe: () => void;
const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function recordingSender() {
  const sent: Array<{ to: string | '*'; event: ServerWsEvent }> = [];
  return {
    sent,
    broadcast: (event: ServerWsEvent) => void sent.push({ to: '*', event }),
    sendToUser: (userId: string, event: ServerWsEvent) => void sent.push({ to: userId, event }),
  };
}

describe('knowledge change hook', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    initializePlatformRuntime(db, [knowledgeRegistration]);
    changes = [];
    unsubscribe = onKnowledgeDocChange((change) => changes.push(change));
  });

  afterEach(async () => {
    unsubscribe();
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('emits created, updated and archived from the service, with the audience before the change', async () => {
    const owner = await createInternalTestUser(db, { email: `kl-owner-${run}@test.local` });
    const doc = await db.knowledgeBase.create({
      doc_id: `kl-${run}`,
      title: 'Live',
      content: 'v1',
      visibility: 'team',
      owner_user_id: owner.id,
      created_by: owner.id,
    });
    await db.knowledgeBase.update(doc.id, { content: 'v2', visibility: 'private' }, owner.id);
    await db.knowledgeBase.archive(doc.id, owner.id);
    await db.knowledgeBase.update(doc.id, { status: 'published' }, owner.id);
    await db.knowledgeBase.restoreVersion(doc.id, 1, owner.id);

    expect(changes.map((change) => [change.doc.id, change.kind])).toEqual([
      [doc.id, 'created'],
      [doc.id, 'updated'],
      [doc.id, 'archived'],
      [doc.id, 'updated'],
      [doc.id, 'updated'],
    ]);
    // Made private in the second write: the event still knows it was a team doc a moment ago.
    expect(changes[1]!.previous).toEqual({ visibility: 'team', owner_user_id: owner.id });
    expect(changes[1]!.doc.visibility).toBe('private');
  });

  it('emits for a write made through the knowledge_mutation tool (chat, MCP and approved agent writes)', async () => {
    const owner = await createInternalTestUser(db, { email: `kl-tool-${run}@test.local` });
    const tool = createKnowledgeMutationTool(db, { userId: owner.id });
    const created = (await tool.execute!(
      { action: 'knowledge.create_doc', scope: 'personal', title: 'From an agent', content: 'Body.' } as never,
      {} as never,
    )) as { document: { id: number } };
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'created', doc: expect.objectContaining({ id: created.document.id }) }),
    ]);
  });

  it('a listener that throws never fails the write', async () => {
    const owner = await createInternalTestUser(db, { email: `kl-throw-${run}@test.local` });
    const stop = onKnowledgeDocChange(() => {
      throw new Error('listener bug');
    });
    try {
      const doc = await db.knowledgeBase.create({
        doc_id: `kl-throw-${run}`,
        title: 'Still saved',
        content: 'x',
        owner_user_id: owner.id,
        created_by: owner.id,
      });
      expect(await db.knowledgeBase.getById(doc.id)).toBeDefined();
    } finally {
      stop();
    }
  });
});

describe('knowledge.changed audience', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('sends a private doc to its owner and its share targets, direct and through a group — nobody else', async () => {
    const owner = await createInternalTestUser(db, { email: `ka-owner-${run}@test.local` });
    const direct = await createInternalTestUser(db, { email: `ka-direct-${run}@test.local` });
    const member = await createInternalTestUser(db, { email: `ka-member-${run}@test.local` });
    await createInternalTestUser(db, { email: `ka-outsider-${run}@test.local` });
    const doc = await db.knowledgeBase.create({
      doc_id: `ka-${run}`,
      title: 'Private',
      content: 'x',
      visibility: 'private',
      owner_user_id: owner.id,
      created_by: owner.id,
    });
    await db.knowledgeShares.grant(doc.id, direct.id, 'reader', owner.id);
    const group = await db.groups.create({ name: `ka-group-${run}`, created_by: owner.id });
    await db.groups.addMembers(group.id, [member.id], owner.id);
    await db.knowledgeShares.grant(doc.id, `group:${group.id}`, 'editor', owner.id);

    const sender = recordingSender();
    await publishKnowledgeChange(db, { kind: 'updated', doc }, sender);
    expect(sender.sent.map((entry) => entry.to).sort()).toEqual([direct.id, member.id, owner.id].sort());
    expect(sender.sent[0]!.event).toEqual({ type: 'knowledge.changed', docId: doc.id, change: 'updated' });
  });

  it('broadcasts a team doc, and a doc that was a team doc until this change', async () => {
    const owner = await createInternalTestUser(db, { email: `kb-owner-${run}@test.local` });
    const doc = await db.knowledgeBase.create({
      doc_id: `kb-${run}`,
      title: 'Team',
      content: 'x',
      visibility: 'private',
      owner_user_id: owner.id,
      created_by: owner.id,
    });
    const sender = recordingSender();
    await publishKnowledgeChange(
      db,
      { kind: 'updated', doc, previous: { visibility: 'team', owner_user_id: owner.id } },
      sender,
    );
    expect(sender.sent).toEqual([{ to: '*', event: { type: 'knowledge.changed', docId: doc.id, change: 'updated' } }]);
  });
});
