/**
 * Knowledge tools round-trip integration tests.
 *
 * Regression guard: a doc created via knowledge_mutation MUST be readable back
 * through knowledge_query (list / search / get). The personal scope is the
 * tricky one — personal docs live in scope='shared' with visibility='private'
 * and owner_user_id=<user>, but user_id MUST stay NULL. A previous bug set
 * user_id=ctx.userId on create, which hid the doc from list/search (those filter
 * on `user_id IS NULL`) while get still found it — a silent write/read mismatch.
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

// ai's tool() execute is invoked with (input, options).
function run(tool: ReturnType<typeof createKnowledgeQueryTool>, input: unknown) {
  return tool.execute!(input as never, {} as never) as Promise<any>;
}

describe('Knowledge tools round-trip', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: PG_URL });
    await db.resetSchema();
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('personal doc created via mutation is visible to list/search/get', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const mutate = createKnowledgeMutationTool(db, { userId: alice.id });
    const query = createKnowledgeQueryTool(db, { userId: alice.id });

    const created = await run(mutate, {
      action: 'knowledge.create_doc',
      scope: 'personal',
      title: 'Quarterly retro notes',
      content: 'My private retro thoughts for the quarter.',
    });
    expect(created.status).toBe('created');
    const docId = created.document.doc_id as string;

    const listed = await run(query, { action: 'list', scope: 'personal', limit: 10 });
    expect(listed.results.some((d: any) => d.doc_id === docId)).toBe(true);

    const searched = await run(query, { action: 'search', scope: 'personal', query: 'retro' });
    expect(searched.results.some((d: any) => d.doc_id === docId)).toBe(true);

    const got = await run(query, { action: 'get', scope: 'personal', doc_id: docId });
    expect(got.doc_id).toBe(docId);
    expect(got.content).toContain('retro');
  });

  it('personal docs never leak across users', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const aliceMutate = createKnowledgeMutationTool(db, { userId: alice.id });

    const created = await run(aliceMutate, {
      action: 'knowledge.create_doc',
      scope: 'personal',
      title: 'Alice secret',
      content: 'Only Alice should ever see this.',
    });
    const docId = created.document.doc_id as string;

    const bobQuery = createKnowledgeQueryTool(db, { userId: bob.id });
    const bobList = await run(bobQuery, { action: 'list', scope: 'personal', limit: 10 });
    expect(bobList.results.some((d: any) => d.doc_id === docId)).toBe(false);

    const bobGet = await run(bobQuery, { action: 'get', scope: 'personal', doc_id: docId });
    expect(bobGet.error).toBeTruthy();
  });

  it('team doc created via mutation is visible to team list/get', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const mutate = createKnowledgeMutationTool(db, { userId: alice.id });
    const query = createKnowledgeQueryTool(db, { userId: alice.id });

    const created = await run(mutate, {
      action: 'knowledge.create_doc',
      scope: 'team',
      title: 'Team onboarding guide',
      content: 'Shared onboarding steps for the whole team.',
    });
    const docId = created.document.doc_id as string;

    const listed = await run(query, { action: 'list', scope: 'team', limit: 10 });
    expect(listed.results.some((d: any) => d.doc_id === docId)).toBe(true);

    const got = await run(query, { action: 'get', scope: 'team', doc_id: docId });
    expect(got.doc_id).toBe(docId);
  });

  it('update → versions → restore_version round-trips through the tools', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const mutate = createKnowledgeMutationTool(db, { userId: alice.id });
    const query = createKnowledgeQueryTool(db, { userId: alice.id });

    const created = await run(mutate, {
      action: 'knowledge.create_doc',
      scope: 'personal',
      title: 'Project context',
      content: 'Initial context.',
    });
    const docId = created.document.doc_id as string;

    await run(mutate, {
      action: 'knowledge.update_doc',
      scope: 'personal',
      doc_id: docId,
      content: 'Revised context.',
    });

    const versions = await run(query, { action: 'versions', scope: 'personal', doc_id: docId });
    expect(versions.found).toBeGreaterThanOrEqual(2);
    // Roll back to the very first version.
    const restored = await run(mutate, {
      action: 'knowledge.restore_version',
      scope: 'personal',
      doc_id: docId,
      version: 1,
    });
    expect(restored.status).toBe('restored');

    const got = await run(query, { action: 'get', scope: 'personal', doc_id: docId });
    expect(got.content).toBe('Initial context.');
  });

  it('derives content_json (Tiptap) from Markdown on create and keeps it in sync on update', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const mutate = createKnowledgeMutationTool(db, { userId: alice.id });

    // Create with Markdown only (no editor JSON) — as the agent does.
    const created = await run(mutate, {
      action: 'knowledge.create_doc',
      scope: 'team',
      title: 'KB Tiptap sync',
      content: '# Original heading\n\nOriginal **bold** body.',
    });
    const docId = created.document.doc_id as string;

    const afterCreate = await db.knowledgeBase.get(docId, 'shared', null);
    const createdJson = JSON.parse(afterCreate!.content_json ?? '{}');
    expect(Array.isArray(createdJson.content)).toBe(true); // real Tiptap doc, not '{}'
    expect(afterCreate!.content_json).toContain('Original heading');

    // Update Markdown ONLY — the exact bug repro (agent edits MD, sends no JSON).
    await run(mutate, {
      action: 'knowledge.update_doc',
      scope: 'team',
      doc_id: docId,
      content: '# Updated heading\n\nUpdated body.',
    });

    const afterUpdate = await db.knowledgeBase.get(docId, 'shared', null);
    expect(afterUpdate!.content).toContain('Updated heading');
    // content_json now reflects the NEW Markdown — not stale, not empty.
    expect(afterUpdate!.content_json).toContain('Updated heading');
    expect(afterUpdate!.content_json).not.toContain('Original heading');
    expect(Array.isArray(JSON.parse(afterUpdate!.content_json ?? '{}').content)).toBe(true);
  });

  it('patch_doc replaces a unique substring without touching the rest, and rejects bad finds', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const mutate = createKnowledgeMutationTool(db, { userId: alice.id });

    const created = await run(mutate, {
      action: 'knowledge.create_doc',
      scope: 'team',
      title: 'Patch target',
      content: '# Guide\n\nThe price is $99 today.\n\nMore unrelated text.',
    });
    const docId = created.document.doc_id as string;

    // Targeted edit — only the price changes.
    const patched = await run(mutate, {
      action: 'knowledge.patch_doc',
      scope: 'team',
      doc_id: docId,
      find: 'The price is $99 today.',
      replace: 'The price is $79 today.',
    });
    expect(patched.error).toBeFalsy();

    const doc = await db.knowledgeBase.get(docId, 'shared', null);
    expect(doc!.content).toContain('The price is $79 today.');
    expect(doc!.content).toContain('More unrelated text.'); // rest untouched
    expect(doc!.content).not.toContain('$99');
    expect(doc!.content_json).toContain('$79'); // Tiptap kept in sync

    // Not found → error.
    const notFound = await run(mutate, {
      action: 'knowledge.patch_doc',
      scope: 'team',
      doc_id: docId,
      find: 'nonexistent text',
      replace: 'x',
    });
    expect(notFound.error).toMatch(/not found/i);

    // Ambiguous → error ("." appears in both sentences, so it is not unique).
    const ambiguous = await run(mutate, {
      action: 'knowledge.patch_doc',
      scope: 'team',
      doc_id: docId,
      find: '.',
      replace: '!',
    });
    expect(ambiguous.error).toMatch(/not unique/i);
  });

  it('append_doc adds to the end and leaves existing content intact', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const mutate = createKnowledgeMutationTool(db, { userId: alice.id });

    const created = await run(mutate, {
      action: 'knowledge.create_doc',
      scope: 'team',
      title: 'Append target',
      content: 'First line.',
    });
    const docId = created.document.doc_id as string;

    await run(mutate, {
      action: 'knowledge.append_doc',
      scope: 'team',
      doc_id: docId,
      content: '## Appended\n\nA new note.',
    });

    const doc = await db.knowledgeBase.get(docId, 'shared', null);
    expect(doc!.content).toContain('First line.');
    expect(doc!.content).toContain('## Appended');
    expect(doc!.content.indexOf('First line.')).toBeLessThan(doc!.content.indexOf('## Appended'));
  });

  it('update_section replaces one section body addressed by its heading', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const mutate = createKnowledgeMutationTool(db, { userId: alice.id });

    const created = await run(mutate, {
      action: 'knowledge.create_doc',
      scope: 'team',
      title: 'Sectioned doc',
      content: '# Doc\n\n## Install\n\nOld install steps.\n\n## Usage\n\nUsage stays.',
    });
    const docId = created.document.doc_id as string;

    const res = await run(mutate, {
      action: 'knowledge.update_section',
      scope: 'team',
      doc_id: docId,
      heading: '## Install',
      content: 'Brand new install steps.',
    });
    expect(res.error).toBeFalsy();

    const doc = await db.knowledgeBase.get(docId, 'shared', null);
    expect(doc!.content).toContain('Brand new install steps.');
    expect(doc!.content).not.toContain('Old install steps.');
    expect(doc!.content).toContain('## Usage'); // sibling section preserved
    expect(doc!.content).toContain('Usage stays.');

    // Unknown heading → error.
    const missing = await run(mutate, {
      action: 'knowledge.update_section',
      scope: 'team',
      doc_id: docId,
      heading: 'Nope',
      content: 'x',
    });
    expect(missing.error).toMatch(/not found/i);
  });

  it('archive_doc hides a doc from query and blocks cross-user mutation', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const aliceMutate = createKnowledgeMutationTool(db, { userId: alice.id });

    const created = await run(aliceMutate, {
      action: 'knowledge.create_doc',
      scope: 'personal',
      title: 'Alice plan',
      content: 'Alice private plan.',
    });
    const docId = created.document.doc_id as string;

    // Bob cannot archive Alice's personal doc.
    const bobMutate = createKnowledgeMutationTool(db, { userId: bob.id });
    const bobArchive = await run(bobMutate, { action: 'knowledge.archive_doc', scope: 'personal', doc_id: docId });
    expect(bobArchive.error).toBeTruthy();

    // Alice can; afterwards it is no longer listed.
    const archived = await run(aliceMutate, { action: 'knowledge.archive_doc', scope: 'personal', doc_id: docId });
    expect(archived.status).toBe('archived');

    const aliceQuery = createKnowledgeQueryTool(db, { userId: alice.id });
    const listed = await run(aliceQuery, { action: 'list', scope: 'personal', limit: 10 });
    expect(listed.results.some((d: any) => d.doc_id === docId)).toBe(false);
  });
});
