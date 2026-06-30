/**
 * Privacy-guard tests for the scope-bound knowledge tools.
 *
 * The personal/team boundary is the security-sensitive part of these tools, so
 * the read guard gets explicit coverage: personal must never return team or
 * other-users' docs; team must never return private docs.
 */

import { describe, it, expect } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { createTeamKnowledgeTool } from '../team-knowledge.js';
import { createPersonalKnowledgeTool } from '../personal-knowledge.js';

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

describe('team_knowledge get guard', () => {
  const t = createTeamKnowledgeTool(fakeDb({ 'team-1': teamDoc, 'mine-1': myDoc }));

  it('returns a team doc', async () => {
    const r = (await t.execute!({ action: 'get', doc_id: 'team-1' }, opts)) as { content?: string };
    expect(r.content).toBe('team content');
  });

  it('refuses a private doc', async () => {
    const r = (await t.execute!({ action: 'get', doc_id: 'mine-1' }, opts)) as { error?: string };
    expect(r.error).toContain('not found');
  });
});

describe('personal_knowledge get guard', () => {
  const t = createPersonalKnowledgeTool(fakeDb({ 'mine-1': myDoc, 'other-1': otherDoc, 'team-1': teamDoc }), {
    userId: 'u1',
  });

  it("returns the current user's own private doc", async () => {
    const r = (await t.execute!({ action: 'get', doc_id: 'mine-1' }, opts)) as { content?: string };
    expect(r.content).toBe('private content');
  });

  it("refuses another user's private doc", async () => {
    const r = (await t.execute!({ action: 'get', doc_id: 'other-1' }, opts)) as { error?: string };
    expect(r.error).toContain('not found');
  });

  it('refuses a team doc', async () => {
    const r = (await t.execute!({ action: 'get', doc_id: 'team-1' }, opts)) as { error?: string };
    expect(r.error).toContain('not found');
  });
});
