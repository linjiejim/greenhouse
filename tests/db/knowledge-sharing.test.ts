/**
 * Knowledge sharing (Phase 3) integration tests.
 *
 * Covers granular sharing of PRIVATE docs with specific users and groups, the
 * reader/editor role distinction, group-membership-based access, and the
 * security boundary (readers can't write; shared docs don't leak to team scope).
 *
 * Requires: PostgreSQL running at localhost:5432 with greenhouse_test database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { createKnowledgeMutationTool } from '../../apps/api/src/tools/knowledge-mutation.js';
import { createKnowledgeQueryTool } from '../../apps/api/src/tools/knowledge-query.js';

const PG_URL = 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test';
let db: DatabaseProvider;

async function createUser(db: DatabaseProvider, email: string, nickname: string) {
  return db.users.create({ email, password_hash: 'h', nickname, role: 'member' });
}

function run(tool: ReturnType<typeof createKnowledgeQueryTool>, input: unknown) {
  return tool.execute!(input as never, {} as never) as Promise<any>;
}

async function createPrivateDoc(ownerId: string, docId: string, title: string) {
  return db.knowledgeBase.create({
    doc_id: docId,
    scope: 'shared',
    title,
    content: `${title} body`,
    visibility: 'private',
    status: 'published',
    owner_user_id: ownerId,
    created_by: ownerId,
  });
}

describe('Knowledge sharing — repositories', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: PG_URL });
    await db.resetSchema();
  });
  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('effectiveRole folds in direct + group grants and takes the highest', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const doc = await createPrivateDoc(alice.id, 'sop', 'SOP');

    // Direct reader grant.
    await db.knowledgeShares.grant(doc.id, bob.id, 'reader', alice.id);
    expect(await db.knowledgeShares.effectiveRole(doc.id, bob.id)).toBe('reader');

    // Bob also gets editor via a group → editor wins.
    const group = await db.groups.create({ name: 'Ops', created_by: alice.id });
    await db.groups.addMembers(group.id, [bob.id], alice.id);
    await db.knowledgeShares.grant(doc.id, `group:${group.id}`, 'editor', alice.id);
    expect(await db.knowledgeShares.effectiveRole(doc.id, bob.id)).toBe('editor');

    // listDocIdsForUser finds the doc (via either grant).
    expect(await db.knowledgeShares.listDocIdsForUser(bob.id)).toContain(doc.id);
  });

  it('revoke removes access; non-members get no role', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const carol = await createUser(db, 'carol@test.com', 'Carol');
    const doc = await createPrivateDoc(alice.id, 'sop', 'SOP');

    await db.knowledgeShares.grant(doc.id, bob.id, 'reader', alice.id);
    expect(await db.knowledgeShares.effectiveRole(doc.id, carol.id)).toBeNull();

    await db.knowledgeShares.revoke(doc.id, bob.id);
    expect(await db.knowledgeShares.effectiveRole(doc.id, bob.id)).toBeNull();
    expect(await db.knowledgeShares.listDocIdsForUser(bob.id)).not.toContain(doc.id);
  });

  it('groups: listForUser returns owned + member groups', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const g = await db.groups.create({ name: 'Marketing', created_by: alice.id });
    await db.groups.addMembers(g.id, [bob.id], alice.id);

    expect((await db.groups.listForUser(alice.id)).some((x) => x.id === g.id)).toBe(true); // owner
    expect((await db.groups.listForUser(bob.id)).some((x) => x.id === g.id)).toBe(true); // member
    expect(await db.groups.isMember(g.id, bob.id)).toBe(true);
  });
});

describe('Knowledge sharing — tools', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: PG_URL });
    await db.resetSchema();
  });
  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('owner shares (reader); recipient reads via shared scope but cannot write', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const aliceMutate = createKnowledgeMutationTool(db, { userId: alice.id });

    const created = await run(aliceMutate, {
      action: 'knowledge.create_doc',
      scope: 'personal',
      title: 'Roadmap',
      content: 'Q3 roadmap details.',
    });
    const docId = created.document.doc_id as string;

    const shared = await run(aliceMutate, {
      action: 'knowledge.share_doc',
      scope: 'personal',
      doc_id: docId,
      share_targets: [bob.id],
      share_role: 'reader',
    });
    expect(shared.status).toBe('shared');

    // Bob can read it via the 'shared' scope.
    const bobQuery = createKnowledgeQueryTool(db, { userId: bob.id });
    const list = await run(bobQuery, { action: 'list', scope: 'shared' });
    expect(list.results.some((d: any) => d.doc_id === docId)).toBe(true);
    const got = await run(bobQuery, { action: 'get', scope: 'shared', doc_id: docId });
    expect(got.content).toContain('roadmap');

    // It must NOT leak into team scope.
    const teamList = await run(bobQuery, { action: 'list', scope: 'team' });
    expect(teamList.results.some((d: any) => d.doc_id === docId)).toBe(false);

    // Bob (reader) cannot update.
    const bobMutate = createKnowledgeMutationTool(db, { userId: bob.id });
    const denied = await run(bobMutate, {
      action: 'knowledge.update_doc',
      scope: 'personal',
      doc_id: docId,
      content: 'hacked',
    });
    expect(denied.error).toBeTruthy();
  });

  it('editor grant lets a non-owner update; archive/share stay owner-only', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const carol = await createUser(db, 'carol@test.com', 'Carol');
    const aliceMutate = createKnowledgeMutationTool(db, { userId: alice.id });

    const created = await run(aliceMutate, {
      action: 'knowledge.create_doc',
      scope: 'personal',
      title: 'Spec',
      content: 'Initial spec.',
    });
    const docId = created.document.doc_id as string;
    await run(aliceMutate, {
      action: 'knowledge.share_doc',
      scope: 'personal',
      doc_id: docId,
      share_targets: [carol.id],
      share_role: 'editor',
    });

    const carolMutate = createKnowledgeMutationTool(db, { userId: carol.id });
    const updated = await run(carolMutate, {
      action: 'knowledge.update_doc',
      scope: 'personal',
      doc_id: docId,
      content: 'Carol revised the spec.',
    });
    expect(updated.status).toBe('updated');

    // Editor cannot archive or re-share (owner-only).
    const archiveDenied = await run(carolMutate, { action: 'knowledge.archive_doc', scope: 'personal', doc_id: docId });
    expect(archiveDenied.error).toBeTruthy();
    const shareDenied = await run(carolMutate, {
      action: 'knowledge.share_doc',
      scope: 'personal',
      doc_id: docId,
      share_targets: ['someone'],
    });
    expect(shareDenied.error).toBeTruthy();
  });

  it('group share grants access to all members', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const dave = await createUser(db, 'dave@test.com', 'Dave');
    const group = await db.groups.create({ name: 'Eng', created_by: alice.id });
    await db.groups.addMembers(group.id, [dave.id], alice.id);

    const aliceMutate = createKnowledgeMutationTool(db, { userId: alice.id });
    const created = await run(aliceMutate, {
      action: 'knowledge.create_doc',
      scope: 'personal',
      title: 'Eng notes',
      content: 'Engineering context.',
    });
    const docId = created.document.doc_id as string;
    await run(aliceMutate, {
      action: 'knowledge.share_doc',
      scope: 'personal',
      doc_id: docId,
      share_targets: [`group:${group.id}`],
      share_role: 'editor',
    });

    // Dave (group member, editor) can read via shared scope and update.
    const daveQuery = createKnowledgeQueryTool(db, { userId: dave.id });
    const got = await run(daveQuery, { action: 'get', scope: 'shared', doc_id: docId });
    expect(got.content).toContain('Engineering');

    const daveMutate = createKnowledgeMutationTool(db, { userId: dave.id });
    const updated = await run(daveMutate, {
      action: 'knowledge.update_doc',
      scope: 'personal',
      doc_id: docId,
      content: 'Dave updated eng notes.',
    });
    expect(updated.status).toBe('updated');
  });
});
