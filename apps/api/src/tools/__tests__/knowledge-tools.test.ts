/**
 * Privacy-guard tests for the unified knowledge_query tool.
 *
 * The personal/team boundary is the security-sensitive part, so the read guard
 * gets explicit coverage: scope=personal must never return team or other users'
 * docs; scope=team must never return private docs. This coverage moved here from
 * the retired team_knowledge / personal_knowledge tools, which knowledge_query
 * subsumes (scope=team | personal | shared).
 */

import { describe, it, expect } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { createKnowledgeQueryTool } from '../knowledge/knowledge-query.js';

interface Doc {
  doc_id: string;
  title: string;
  content: string;
  tags: string | null;
  _summary: string | null;
  status: string;
  visibility: string;
  owner_user_id: string | null;
}

function fakeDb(docs: Record<string, Doc>): DatabaseProvider {
  return {
    knowledgeBase: {
      async search() {
        return [];
      },
      async get(docId: string) {
        return docs[docId];
      },
    },
  } as unknown as DatabaseProvider;
}

const teamDoc: Doc = {
  doc_id: 'team-1',
  title: 'SOP',
  content: 'team content',
  tags: null,
  _summary: 's',
  status: 'published',
  visibility: 'team',
  owner_user_id: null,
};
const myDoc: Doc = {
  doc_id: 'mine-1',
  title: 'My note',
  content: 'private content',
  tags: null,
  _summary: 's',
  status: 'published',
  visibility: 'private',
  owner_user_id: 'u1',
};
const otherDoc: Doc = {
  doc_id: 'other-1',
  title: 'Other note',
  content: 'secret',
  tags: null,
  _summary: 's',
  status: 'published',
  visibility: 'private',
  owner_user_id: 'u2',
};

const opts = {} as never;

describe('knowledge_query scope=team get guard', () => {
  const t = createKnowledgeQueryTool(fakeDb({ 'team-1': teamDoc, 'mine-1': myDoc }), { userId: 'u1' });

  it('returns a team doc', async () => {
    const r = (await t.execute!({ action: 'get', scope: 'team', doc_id: 'team-1' }, opts)) as { content?: string };
    expect(r.content).toBe('team content');
  });

  it('refuses a private doc under team scope', async () => {
    const r = (await t.execute!({ action: 'get', scope: 'team', doc_id: 'mine-1' }, opts)) as { error?: string };
    expect(r.error).toContain('not found');
  });
});

describe('knowledge_query scope=personal get guard', () => {
  const t = createKnowledgeQueryTool(fakeDb({ 'mine-1': myDoc, 'other-1': otherDoc, 'team-1': teamDoc }), {
    userId: 'u1',
  });

  it("returns the current user's own private doc", async () => {
    const r = (await t.execute!({ action: 'get', scope: 'personal', doc_id: 'mine-1' }, opts)) as { content?: string };
    expect(r.content).toBe('private content');
  });

  it("refuses another user's private doc", async () => {
    const r = (await t.execute!({ action: 'get', scope: 'personal', doc_id: 'other-1' }, opts)) as { error?: string };
    expect(r.error).toContain('not found');
  });

  it('refuses a team doc under personal scope', async () => {
    const r = (await t.execute!({ action: 'get', scope: 'personal', doc_id: 'team-1' }, opts)) as { error?: string };
    expect(r.error).toContain('not found');
  });
});
