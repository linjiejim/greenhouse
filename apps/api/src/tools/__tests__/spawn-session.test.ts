/**
 * Unit tests for the session-orchestration tools: spawn_session + call_llm.
 *
 * These run with a fake in-memory db and a stubbed LLM (the `generate` seam), so
 * no Postgres or provider API key is needed. They cover the behavior the feature
 * promises: child lineage, the call_llm audit log, sync/async, the confirm gate,
 * and the bounded-recursion guard.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createSpawnSessionTool } from '../spawn-session.js';
import { createCallLlmTool } from '../call-llm.js';
import { getAllToolIds, getToolMeta } from '../registry.js';
import { LAZY_TOOL_IDS, childSpawnToolIds } from '../../agent-runtime/tool-resolution.js';
import { MAX_SPAWN_DEPTH } from '../spawn-session.js';

// ─── Fake db ─────────────────────────────────────────────

function makeFakeDb() {
  const sessions = new Map<string, any>();
  const messages: any[] = [];
  const llmCalls: any[] = [];
  let seq = 0;

  const api = {
    _sessions: sessions,
    _messages: messages,
    _llmCalls: llmCalls,
    sessions: {
      async create(
        title?: string,
        profileId?: string,
        userId?: string,
        appId?: string,
        channel?: string,
        parentSessionId?: string,
      ) {
        const id = `s_${++seq}`;
        const row = {
          id,
          title: title ?? null,
          status: 'active',
          profile_id: profileId ?? 'default',
          user_id: userId ?? null,
          app_id: appId ?? null,
          channel: channel ?? 'web',
          parent_session_id: parentSessionId ?? null,
          metadata: '{}',
          created_at: '2026-06-18T00:00:00Z',
          updated_at: '2026-06-18T00:00:00Z',
        };
        sessions.set(id, row);
        return row;
      },
      async getById(id: string) {
        return sessions.get(id);
      },
      async update(id: string, updates: any) {
        const row = sessions.get(id);
        if (row) Object.assign(row, updates);
        return row;
      },
      async addMessage(input: any) {
        const row = { id: `m_${messages.length + 1}`, ...input };
        messages.push(row);
        return row;
      },
      async touch() {},
    },
    llmCalls: {
      async record(input: any) {
        const row = { id: `l_${llmCalls.length + 1}`, ...input };
        llmCalls.push(row);
        return row;
      },
    },
  };
  return api as any;
}

/** Seed a fake parent session at a given lineage depth. */
function seedParent(db: any, depth = 0) {
  const id = 's_parent';
  db._sessions.set(id, {
    id,
    title: 'parent',
    status: 'active',
    profile_id: 'default',
    user_id: 'u1',
    channel: 'web',
    parent_session_id: null,
    metadata: JSON.stringify({ spawn_depth: depth }),
    created_at: '2026-06-18T00:00:00Z',
    updated_at: '2026-06-18T00:00:00Z',
  });
  return id;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ─── call_llm ────────────────────────────────────────────

describe('call_llm', () => {
  let db: any;
  beforeEach(() => {
    db = makeFakeDb();
  });

  it('returns the model output and records the full input/output to the audit log', async () => {
    const tool = createCallLlmTool(db, {
      userId: 'u1',
      sessionId: 's1',
      profileId: 'default',
      generate: async ({ prompt }) => ({ text: `SUMMARY of: ${prompt}`, usage: { inputTokens: 12, outputTokens: 4 } }),
    });

    const out: any = await tool.execute!({ prompt: 'a very long document' } as any, {} as any);

    expect(out.output).toBe('SUMMARY of: a very long document');
    expect(out.llm_call_id).toBeTruthy();
    expect(out.usage).toEqual({ input_tokens: 12, output_tokens: 4 });

    expect(db._llmCalls).toHaveLength(1);
    const rec = db._llmCalls[0];
    expect(rec.session_id).toBe('s1');
    expect(rec.input).toBe('a very long document');
    expect(rec.output).toBe('SUMMARY of: a very long document');
    expect(rec.status).toBe('ok');
  });

  it('records an error row (and returns an error) when the call throws', async () => {
    const tool = createCallLlmTool(db, {
      userId: 'u1',
      sessionId: 's1',
      profileId: 'default',
      generate: async () => {
        throw new Error('boom');
      },
    });

    const out: any = await tool.execute!({ prompt: 'x' } as any, {} as any);
    expect(out.error).toContain('boom');
    expect(db._llmCalls).toHaveLength(1);
    expect(db._llmCalls[0].status).toBe('error');
    expect(db._llmCalls[0].error).toContain('boom');
  });

  it('forwards an abort signal to the model call (timeout / parent-cancel wiring)', async () => {
    let gotSignal: unknown;
    const tool = createCallLlmTool(db, {
      userId: 'u1',
      sessionId: 's1',
      profileId: 'default',
      generate: async ({ abortSignal }) => {
        gotSignal = abortSignal;
        return { text: 'ok' };
      },
    });
    await tool.execute!({ prompt: 'x' } as any, {} as any);
    expect(gotSignal).toBeInstanceOf(AbortSignal);
  });

  it('rejects an unknown model id without calling the model', async () => {
    let called = false;
    const tool = createCallLlmTool(db, {
      userId: 'u1',
      sessionId: 's1',
      profileId: 'default',
      generate: async () => {
        called = true;
        return { text: 'nope' };
      },
    });
    const out: any = await tool.execute!({ prompt: 'x', model: 'not-a-real-model' } as any, {} as any);
    expect(out.error).toMatch(/Unknown model/);
    expect(called).toBe(false);
    expect(db._llmCalls).toHaveLength(0);
  });
});

// ─── spawn_session ───────────────────────────────────────

describe('spawn_session', () => {
  let db: any;
  let assembleCalls: Array<{ depth: number; childSessionId: string }>;

  const assembleChildTools = async ({ childSessionId, depth }: any) => {
    assembleCalls.push({ childSessionId, depth });
    return {}; // empty tool set is fine — the stubbed generate never uses tools
  };

  beforeEach(() => {
    db = makeFakeDb();
    assembleCalls = [];
  });

  function makeTool(generate: any) {
    const parentId = seedParent(db, 0);
    return createSpawnSessionTool(db, {
      userId: 'u1',
      userRole: 'super',
      parentSessionId: parentId,
      parentProfileId: 'default',
      assembleChildTools,
      generate,
    });
  }

  it('sync: creates a linked child session, runs it, and returns the result', async () => {
    const tool = makeTool(async () => ({
      text: 'child answer',
      usage: { inputTokens: 5, outputTokens: 9 },
      steps: [],
    }));

    const out: any = await tool.execute!({ prompt: 'do a subtask', mode: 'sync' } as any, {} as any);

    expect(out.status).toBe('completed');
    expect(out.depth).toBe(1);
    expect(out.result).toBe('child answer');

    const child = db._sessions.get(out.child_session_id);
    expect(child.parent_session_id).toBe('s_parent');
    expect(child.channel).toBe('subagent');
    expect(JSON.parse(child.metadata).spawn_depth).toBe(1);
    // #4: title is prefixed; output echoes it for the artifact card (#3)
    expect(child.title).toMatch(/^\[spawn-session\] /);
    expect(out.title).toBe(child.title);

    // child got the user prompt + the persisted assistant answer
    const childMsgs = db._messages.filter((m: any) => m.session_id === out.child_session_id);
    expect(childMsgs.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(childMsgs[1].content).toBe('child answer');

    // assembleChildTools was asked for depth 1
    expect(assembleCalls).toEqual([{ childSessionId: out.child_session_id, depth: 1 }]);
  });

  it('sync: a failed child is not left blank — persists a failure message and returns an error', async () => {
    const tool = makeTool(async () => {
      throw new Error('model exploded');
    });
    const out: any = await tool.execute!({ prompt: 'do x', mode: 'sync' } as any, {} as any);

    expect(out.status).toBe('error');
    expect(out.error).toContain('model exploded');
    const childMsgs = db._messages.filter((m: any) => m.session_id === out.child_session_id);
    // user prompt + a persisted assistant failure notice — never a blank child.
    expect(childMsgs.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(childMsgs[1].content).toMatch(/失败/);
  });

  it('async without confirm is rejected; no session is created', async () => {
    const tool = makeTool(async () => ({ text: 'x', steps: [] }));
    const out: any = await tool.execute!({ prompt: 'bg task', mode: 'async' } as any, {} as any);
    expect(out.error).toMatch(/confirm:true/);
    expect(db._sessions.has('s_1')).toBe(false);
  });

  it('async with confirm returns started, then persists the result in the background', async () => {
    const tool = makeTool(async () => ({ text: 'bg done', usage: {}, steps: [] }));
    const out: any = await tool.execute!({ prompt: 'bg task', mode: 'async', confirm: true } as any, {} as any);

    expect(out.status).toBe('started');
    const childId = out.child_session_id;
    expect(db._sessions.get(childId).channel).toBe('subagent');

    await flush();
    const childMsgs = db._messages.filter((m: any) => m.session_id === childId);
    expect(childMsgs.find((m: any) => m.role === 'assistant')?.content).toBe('bg done');
  });

  it('refuses to spawn beyond the depth cap', async () => {
    seedParent(db, MAX_SPAWN_DEPTH); // a parent already at the cap → child would exceed
    const tool = createSpawnSessionTool(db, {
      userId: 'u1',
      userRole: 'super',
      parentSessionId: 's_parent',
      parentProfileId: 'default',
      assembleChildTools,
      generate: async () => ({ text: 'should not run', steps: [] }),
    });
    const out: any = await tool.execute!({ prompt: 'too deep', mode: 'sync' } as any, {} as any);
    expect(out.error).toMatch(/depth/i);
    expect(assembleCalls).toHaveLength(0);
  });
});

// ─── recursion guard + registration invariants ───────────

describe('childSpawnToolIds (recursion guard)', () => {
  it('keeps spawn_session below the cap and strips it at/over the cap', () => {
    const ids = ['call_llm', 'spawn_session', 'session_query'];
    expect(childSpawnToolIds(ids, MAX_SPAWN_DEPTH - 1)).toContain('spawn_session');
    expect(childSpawnToolIds(ids, MAX_SPAWN_DEPTH)).not.toContain('spawn_session');
    // call_llm is never stripped (no recursion vector)
    expect(childSpawnToolIds(ids, MAX_SPAWN_DEPTH)).toContain('call_llm');
  });
});

describe('tool registration', () => {
  it('registers spawn_session and call_llm as lazy tools', () => {
    expect(getAllToolIds()).toEqual(expect.arrayContaining(['spawn_session', 'call_llm']));
    expect(LAZY_TOOL_IDS.has('spawn_session')).toBe(true);
    expect(LAZY_TOOL_IDS.has('call_llm')).toBe(true);
  });

  it('both tools are default-on (is_global) for internal users; spawn renders as an artifact', () => {
    expect(getToolMeta('spawn_session')?.is_global).toBe(true);
    expect(getToolMeta('call_llm')?.is_global).toBe(true);
    expect(getToolMeta('spawn_session')?.presentation).toBe('artifact');
  });
});
