/**
 * Knowledge Base Repository integration tests.
 *
 * Focus: the `list()` filter conditions, in particular the personal-KB scope
 * model (visibility='private' + owner_user_id) where listing MUST be scoped to
 * the requesting owner — a missing owner filter is a cross-user data leak.
 *
 * Requires: PostgreSQL running at localhost:5432 with greenhouse_test database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';

const PG_URL = 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test';
let db: DatabaseProvider;

// ─── Helpers ─────────────────────────────────────────────

async function createUser(db: DatabaseProvider, email: string, nickname: string) {
  return db.users.create({ email, password_hash: 'h', nickname, role: 'member' });
}

async function createPersonalDoc(db: DatabaseProvider, ownerId: string, docId: string, title: string) {
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

// ─── Tests ───────────────────────────────────────────────

describe('Knowledge Base Repository — list()', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: PG_URL });
    await db.resetSchema();
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('filters personal-KB listing by ownerUserId (no cross-user leak)', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');

    await createPersonalDoc(db, alice.id, 'alice-note-1', 'Alice Note 1');
    await createPersonalDoc(db, alice.id, 'alice-note-2', 'Alice Note 2');
    await createPersonalDoc(db, bob.id, 'bob-note-1', 'Bob Note 1');

    const aliceDocs = await db.knowledgeBase.list({
      scope: 'shared',
      status: 'published',
      visibility: 'private',
      ownerUserId: alice.id,
    });

    expect(aliceDocs).toHaveLength(2);
    expect(aliceDocs.every((d) => d.owner_user_id === alice.id)).toBe(true);
    expect(aliceDocs.map((d) => d.doc_id).sort()).toEqual(['alice-note-1', 'alice-note-2']);
    // Bob's private doc must never appear in Alice's listing.
    expect(aliceDocs.some((d) => d.doc_id === 'bob-note-1')).toBe(false);
  });

  it('returns empty for an owner with no personal docs', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');

    await createPersonalDoc(db, alice.id, 'alice-note-1', 'Alice Note 1');

    const bobDocs = await db.knowledgeBase.list({
      scope: 'shared',
      status: 'published',
      visibility: 'private',
      ownerUserId: bob.id,
    });

    expect(bobDocs).toEqual([]);
  });

  it('without ownerUserId, listing is not owner-scoped', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');

    await createPersonalDoc(db, alice.id, 'alice-note-1', 'Alice Note 1');
    await createPersonalDoc(db, bob.id, 'bob-note-1', 'Bob Note 1');

    const allPrivate = await db.knowledgeBase.list({
      scope: 'shared',
      status: 'published',
      visibility: 'private',
    });

    expect(allPrivate).toHaveLength(2);
  });
});

describe('Knowledge Base Repository — restoreVersion()', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: PG_URL });
    await db.resetSchema();
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('rolls content back and records the rollback as a new version (non-destructive)', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const doc = await db.knowledgeBase.create({
      doc_id: 'sop-1',
      scope: 'shared',
      title: 'SOP v1',
      content: 'Step one.',
      visibility: 'team',
      status: 'published',
      created_by: alice.id,
    });
    // create() snapshots v1; update() snapshots v2.
    await db.knowledgeBase.update(doc.id, { content: 'Step one. Step two.' }, alice.id, 'Add step two');

    const restored = await db.knowledgeBase.restoreVersion(doc.id, 1, alice.id);
    expect(restored).toBeDefined();
    expect(restored!.content).toBe('Step one.');

    // The current doc reflects the restored content.
    const current = await db.knowledgeBase.getById(doc.id);
    expect(current!.content).toBe('Step one.');

    // History is preserved + extended: v1, v2, and a new v3 for the restore.
    const versions = await db.knowledgeBase.listVersions(doc.id);
    expect(versions.map((v) => v.version).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    const latest = versions.find((v) => v.version === 3);
    expect(latest!.change_reason).toBe('Restored from v1');
    expect(latest!.content).toBe('Step one.');
  });

  it('returns undefined for an unknown version', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const doc = await db.knowledgeBase.create({
      doc_id: 'sop-2',
      scope: 'shared',
      title: 'SOP',
      content: 'Body.',
      visibility: 'team',
      status: 'published',
      created_by: alice.id,
    });
    const restored = await db.knowledgeBase.restoreVersion(doc.id, 99, alice.id);
    expect(restored).toBeUndefined();
  });
});

describe('Knowledge Base Repository — content_json staleness safety net', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: PG_URL });
    await db.resetSchema();
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('clears stale content_json when Markdown changes without new editor JSON', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const doc = await db.knowledgeBase.create({
      doc_id: 'kb-stale-json',
      scope: 'shared',
      title: 'Doc',
      content: 'old body',
      content_json: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"old body"}]}]}',
      visibility: 'team',
      status: 'published',
      created_by: alice.id,
    });

    // Update Markdown ONLY (no editor JSON) — the old content_json is now stale and
    // must not survive, or the editor would render the previous content.
    const updated = await db.knowledgeBase.update(doc.id, { content: 'new body' }, alice.id);
    expect(updated!.content).toBe('new body');
    expect(updated!.content_json).toBe('{}');
  });

  it('leaves content_json untouched on metadata-only updates', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const json = '{"type":"doc","content":[{"type":"paragraph"}]}';
    const doc = await db.knowledgeBase.create({
      doc_id: 'kb-meta-only',
      scope: 'shared',
      title: 'Doc',
      content: 'body',
      content_json: json,
      visibility: 'team',
      status: 'published',
      created_by: alice.id,
    });

    const updated = await db.knowledgeBase.update(doc.id, { tags: ['x'] }, alice.id);
    expect(updated!.content_json).toBe(json);
  });
});
