/**
 * Privacy-guard and read-shape tests for the unified `knowledge_query`.
 *
 * These guards moved here when `team_knowledge` / `personal_knowledge` were
 * retired (2026-08-14) — the scope boundary is the security-sensitive part of
 * knowledge reads and must not have got weaker in the merge: personal must
 * never return team or other users' docs, team must never return private ones.
 *
 * The platform dispatch wrapper is stubbed so this stays a pure unit test; what
 * it guards (capability + audit) has its own coverage in the platform suite.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';

vi.mock('../../platform/knowledge/agent-adapter.js', () => ({
  runKnowledgeAgentAction: async <T>(_ctx: unknown, _action: unknown, _payload: unknown, op: () => Promise<T>) => op(),
}));

const { createKnowledgeQueryTool } = await import('../knowledge-query.js');

interface Doc {
  id: number;
  doc_id: string;
  scope: string;
  title: string;
  content: string;
  tags: string | null;
  _summary: string | null;
  status: string;
  visibility: string;
  owner_user_id: string | null;
  folder_id: number | null;
}

function fakeDb(docs: Record<string, Doc>, searchResults: unknown[] = []): DatabaseProvider {
  const rows = Object.values(docs);
  return {
    knowledgeBase: {
      async search() {
        return searchResults;
      },
      async searchShared() {
        return searchResults;
      },
      async list() {
        return rows;
      },
      async listByIds(ids: number[]) {
        return rows.filter((d) => ids.includes(d.id));
      },
      async get(docId: string, scope: string) {
        const doc = docs[docId];
        return doc && doc.scope === scope ? doc : undefined;
      },
      async getById(id: number) {
        return rows.find((d) => d.id === id);
      },
    },
    knowledgeShares: {
      async listDocIdsForUser() {
        return rows.map((d) => d.id);
      },
    },
    drive: {
      async breadcrumb() {
        return [{ name: '产品' }];
      },
      async listFolders() {
        return [];
      },
    },
  } as unknown as DatabaseProvider;
}

const base: Omit<Doc, 'id' | 'doc_id' | 'title' | 'content' | 'visibility' | 'owner_user_id'> = {
  scope: 'shared',
  tags: null,
  _summary: 's',
  status: 'published',
  folder_id: null,
};

const teamDoc: Doc = {
  ...base,
  id: 37,
  doc_id: 'team-1',
  title: 'SOP',
  content: 'team content',
  visibility: 'team',
  owner_user_id: null,
};
const myDoc: Doc = {
  ...base,
  id: 41,
  doc_id: 'mine-1',
  title: 'My note',
  content: 'private content',
  visibility: 'private',
  owner_user_id: 'u1',
};
const otherDoc: Doc = {
  ...base,
  id: 42,
  doc_id: 'other-1',
  title: 'Other note',
  content: 'secret',
  visibility: 'private',
  owner_user_id: 'u2',
};

const opts = {} as never;
const ctx = { userId: 'u1' };

describe('knowledge_query team scope guard', () => {
  const t = createKnowledgeQueryTool(fakeDb({ 'team-1': teamDoc, 'mine-1': myDoc }), ctx);

  it('returns a team doc', async () => {
    const r = (await t.execute({ action: 'get', scope: 'team', doc_id: 'team-1' }, opts)) as { content?: string };
    expect(r.content).toBe('team content');
  });

  it('refuses a private doc', async () => {
    const r = (await t.execute({ action: 'get', scope: 'team', doc_id: 'mine-1' }, opts)) as { error?: string };
    expect(r.error).toContain('not found');
  });
});

/**
 * Two id namespaces reach `get`: the string doc_id key, and the numeric row id
 * that search results, tree results and deep links expose. Docs 22/37/46/47 on
 * dev were "not found" for days while existing and team-visible — the model was
 * passing the id every other surface hands out. This fallback was carried over
 * from the retired scoped tools (knowledge_query did NOT have it), so these
 * cases are the ones proving the merge did not regress.
 */
describe('knowledge_query get by numeric id', () => {
  const t = createKnowledgeQueryTool(fakeDb({ 'team-1': teamDoc, 'mine-1': myDoc }), ctx);

  it('resolves a numeric row id', async () => {
    const r = (await t.execute({ action: 'get', scope: 'team', doc_id: '37' }, opts)) as {
      content?: string;
      doc_id?: string;
    };
    expect(r.content).toBe('team content');
    expect(r.doc_id).toBe('team-1');
  });

  it('prefers a digits-only text doc_id over the numeric fallback', async () => {
    const collision: Doc = { ...teamDoc, id: 88, doc_id: '37', content: 'keyed by digits' };
    const shadowed: Doc = { ...teamDoc, id: 37, doc_id: 'unrelated', content: 'row 37' };
    const tool = createKnowledgeQueryTool(fakeDb({ '37': collision, unrelated: shadowed }), ctx);
    const r = (await tool.execute({ action: 'get', scope: 'team', doc_id: '37' }, opts)) as { content?: string };
    expect(r.content).toBe('keyed by digits');
  });

  it('still enforces the visibility guard on the numeric path', async () => {
    // myDoc is private; reaching it through its numeric id must not help.
    const r = (await t.execute({ action: 'get', scope: 'team', doc_id: '41' }, opts)) as { error?: string };
    expect(r.error).toContain('not found');
  });

  it('refuses a numeric id whose row is outside the shared scope', async () => {
    const foreign: Doc = { ...teamDoc, id: 55, doc_id: 'foreign-1', scope: 'archive' };
    const tool = createKnowledgeQueryTool(fakeDb({ 'foreign-1': foreign }), ctx);
    const r = (await tool.execute({ action: 'get', scope: 'team', doc_id: '55' }, opts)) as { error?: string };
    expect(r.error).toContain('not found');
  });
});

describe('knowledge_query personal scope guard', () => {
  const t = createKnowledgeQueryTool(fakeDb({ 'mine-1': myDoc, 'other-1': otherDoc, 'team-1': teamDoc }), ctx);

  it("returns the current user's own private doc", async () => {
    const r = (await t.execute({ action: 'get', scope: 'personal', doc_id: 'mine-1' }, opts)) as { content?: string };
    expect(r.content).toBe('private content');
  });

  it("refuses another user's private doc", async () => {
    const r = (await t.execute({ action: 'get', scope: 'personal', doc_id: 'other-1' }, opts)) as { error?: string };
    expect(r.error).toContain('not found');
  });

  it('refuses a team doc', async () => {
    const r = (await t.execute({ action: 'get', scope: 'personal', doc_id: 'team-1' }, opts)) as { error?: string };
    expect(r.error).toContain('not found');
  });

  it("refuses another user's private doc by numeric id too", async () => {
    const r = (await t.execute({ action: 'get', scope: 'personal', doc_id: '42' }, opts)) as { error?: string };
    expect(r.error).toContain('not found');
  });
});

describe('knowledge_query read modes', () => {
  const long: Doc = {
    ...teamDoc,
    content: ['# Title', 'intro', '', '## 规格参数', '| a | b |', '', '## 常见问题', 'faq body'].join('\n'),
  };
  const t = createKnowledgeQueryTool(fakeDb({ 'team-1': long }), ctx);

  it('outline returns headings and sizes without the body', async () => {
    const r = (await t.execute({ action: 'get', scope: 'team', doc_id: 'team-1', mode: 'outline' }, opts)) as {
      outline?: Array<{ text: string }>;
      content?: string;
    };
    expect(r.content).toBeUndefined();
    expect(r.outline?.map((h) => h.text)).toEqual(['Title', '规格参数', '常见问题']);
  });

  it('section returns just the addressed section', async () => {
    const r = (await t.execute(
      { action: 'get', scope: 'team', doc_id: 'team-1', mode: 'section', section: '规格参数' },
      opts,
    )) as { content?: string };
    expect(r.content).toContain('| a | b |');
    expect(r.content).not.toContain('faq body');
  });

  it('names the available headings when the section does not exist', async () => {
    const r = (await t.execute(
      { action: 'get', scope: 'team', doc_id: 'team-1', mode: 'section', section: '不存在' },
      opts,
    )) as { error?: string };
    expect(r.error).toContain('规格参数');
  });
});

/**
 * A search that only turns up marginal keyword hits must say so. Silence here
 * is how a 0.14-relevance hit on a nonsense query ends up cited as a product
 * spec.
 *
 * The numbers below are MEASURED `ts_rank` values from the seeded 指南 column
 * (2026-08-14), not invented: 0.66 is a title match on "知识库", 0.12–0.19 are
 * ordinary body matches, and 0.14/0.09/0.07 is what the junk query
 * "zzz 完全无关的词" scores after jieba splits it and the OR pass matches 完全 /
 * 无关 / 词 in prose. The threshold has to sit above that junk band, which is
 * why a theory-derived 0.05 (below the body floor) never fired at all.
 */
describe('knowledge_query weak-match honesty', () => {
  const hit = (relevance: number) => ({
    id: 37,
    doc_id: 'team-1',
    title: 'SOP',
    _summary: '',
    snippet: '…',
    tags: '[]',
    relevance,
    folder_id: null,
  });

  it('flags the junk-query profile', async () => {
    const t = createKnowledgeQueryTool(fakeDb({}, [hit(0.14), hit(0.09), hit(0.07)]), ctx);
    const r = (await t.execute({ action: 'search', scope: 'team', query: 'x' }, opts)) as { weak_match?: boolean };
    expect(r.weak_match).toBe(true);
  });

  it('does not flag a real result set led by a title match', async () => {
    const t = createKnowledgeQueryTool(fakeDb({}, [hit(0.66), hit(0.19), hit(0.12)]), ctx);
    const r = (await t.execute({ action: 'search', scope: 'team', query: 'x' }, opts)) as { weak_match?: boolean };
    expect(r.weak_match).toBeUndefined();
  });
});

/**
 * `tree` is a folder browse; the scope that has no folder tree must say where
 * to go instead of returning a confusing empty tree.
 */
describe('knowledge_query tree scope limits', () => {
  const t = createKnowledgeQueryTool(fakeDb({ 'team-1': teamDoc }), ctx);

  it('refuses tree on shared scope and points at list/search', async () => {
    const r = (await t.execute({ action: 'tree', scope: 'shared' }, opts)) as { error?: string };
    expect(r.error).toContain('action=list');
  });
});
