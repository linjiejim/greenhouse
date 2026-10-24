/**
 * Knowledge sharing (Phase 3) integration tests.
 *
 * Covers granular sharing of PRIVATE docs with specific users, the
 * reader/editor role distinction, and the security boundary (readers can't write; shared docs don't leak to team scope).
 *
 * Requires: PostgreSQL running at localhost:5432 with greenhouse_test database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { knowledgeRegistration } from '../../apps/api/src/platform/knowledge/registration.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../apps/api/src/platform/runtime.js';
import { createKnowledgeMutationTool } from '../../apps/api/src/tools/knowledge-mutation.js';
import { createKnowledgeQueryTool } from '../../apps/api/src/tools/knowledge-query.js';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;

async function createUser(db: DatabaseProvider, email: string, nickname: string) {
  return createInternalTestUser(db, { email, nickname, passwordHash: 'h' });
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
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });
  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('effectiveRole returns the granted role, and a re-grant replaces it', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const doc = await createPrivateDoc(alice.id, 'sop', 'SOP');

    // Direct reader grant.
    await db.knowledgeShares.grant(doc.id, bob.id, 'reader', alice.id);
    expect(await db.knowledgeShares.effectiveRole(doc.id, bob.id)).toBe('reader');

    // Granting again upgrades the same grant.
    await db.knowledgeShares.grant(doc.id, bob.id, 'editor', alice.id);
    expect(await db.knowledgeShares.effectiveRole(doc.id, bob.id)).toBe('editor');
    expect(await db.knowledgeShares.userIdsWithAccess(doc.id)).toEqual([bob.id]);

    // listDocIdsForUser finds the doc.
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
});

describe('Knowledge sharing — tools', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    initializePlatformRuntime(db, [knowledgeRegistration]);
  });
  afterEach(async () => {
    resetPlatformRuntimeForTests();
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

  it('editor share lets the recipient read and update', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const dave = await createUser(db, 'dave@test.com', 'Dave');

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
      share_targets: [dave.id],
      share_role: 'editor',
    });

    // Dave (editor) can read via shared scope and update.
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
