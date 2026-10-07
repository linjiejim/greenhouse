/**
 * Chat-eval reference loading honours the knowledge ACL (real PostgreSQL).
 *
 * The eval feeds the judge the full text of every knowledge doc a session cited,
 * and its output is visible to whoever ran it — a super or a session-share
 * recipient — so cited docs must resolve through the EVALUATING identity's
 * knowledge access, not the citing session owner's.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetProvider,
  initDatabase,
  type DatabaseProvider,
  type KnowledgeDocRow,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { loadReferenceSources } from '../../chat/eval.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let evaluator: UserRow;
let privateDoc: KnowledgeDocRow;

/** The stored `references_` of an assistant message in the owner's session that cited `privateDoc` by `key`. */
async function citedReferences(key: string): Promise<string> {
  const session = await db.sessions.create('Eval ACL fixture', undefined, owner.id);
  const message = await db.sessions.addMessage({
    session_id: session.id,
    role: 'assistant',
    content: 'An answer grounded in the cited note.',
    references: [{ slug: privateDoc.doc_id, title: privateDoc.title, type: 'kb_doc', source_id: key }],
  });
  return message.references_;
}

describe('chat eval cited references', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: 'eval-ref-owner@test.com' });
    evaluator = await createInternalTestUser(db, { email: 'eval-ref-evaluator@test.com' });
    privateDoc = await db.knowledgeBase.create({
      doc_id: 'eval-ref-private-note',
      title: 'Private note',
      content: '# Private note\n\nprivate marker eval-ref',
      visibility: 'private',
      status: 'published',
      owner_user_id: owner.id,
      created_by: owner.id,
    });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('loads a private doc cited by the owner only for an evaluator who can read it', async () => {
    // Both keys knowledge_query exposes: the doc_id and the numeric row id.
    for (const key of [privateDoc.doc_id, String(privateDoc.id)]) {
      const referencesJson = await citedReferences(key);

      const denied = await loadReferenceSources(db, referencesJson, { userId: evaluator.id });
      expect(denied.referenceSources).toEqual([]);
      expect(denied.referencesChecked).toEqual([expect.objectContaining({ slug: privateDoc.doc_id, relevant: false })]);

      const allowed = await loadReferenceSources(db, referencesJson, { userId: owner.id });
      expect(allowed.referenceSources).toEqual([
        expect.objectContaining({
          slug: privateDoc.doc_id,
          content: expect.stringContaining('private marker eval-ref'),
        }),
      ]);
      expect(allowed.referencesChecked).toEqual([
        expect.objectContaining({ slug: privateDoc.doc_id, source_id: privateDoc.doc_id, relevant: true }),
      ]);
    }
  });

  it('follows the knowledge share ACL, not just ownership', async () => {
    const referencesJson = await citedReferences(privateDoc.doc_id);
    await db.knowledgeShares.grant(privateDoc.id, evaluator.id, 'reader', owner.id);

    const shared = await loadReferenceSources(db, referencesJson, { userId: evaluator.id });
    expect(shared.referenceSources.map((source) => source.slug)).toEqual([privateDoc.doc_id]);
    expect(shared.referencesChecked).toEqual([expect.objectContaining({ relevant: true })]);
  });
});
