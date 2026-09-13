/**
 * Blast-radius tests for the planner's only write.
 *
 * `workflow_plan` runs unattended inside a chat turn — whatever it can reach, an
 * LLM can reach with a hallucinated id. A 2026-07-28 session did exactly that:
 * asked to revise its plan, the model passed `workflow_id: 1` and overwrote a
 * workflow another conversation had already confirmed AND executed, then told
 * the user "please confirm the plan" — mutating approved state before any
 * confirmation. These tests pin the boundary: the tool may only touch the
 * current conversation's not-yet-executed draft.
 */

import { describe, it, expect } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import type { WorkflowGraph } from '@greenhouse/types/workflow';
import { createWorkflowPlanTool } from '../workflow-plan.js';

const GRAPH: WorkflowGraph = {
  nodes: [{ id: 'only', agent: 'sprouty-quick', brief: { objective: '写点东西' } }],
  deliverable_node: 'only',
};

interface Row {
  id: number;
  user_id: string;
  name: string;
  status: string;
  version: number;
  graph: string;
  created_from_session_id: string | null;
}

function fakeDb(rows: Row[], runsByWorkflow: Record<number, unknown[]> = {}) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  let seq = Math.max(0, ...store.keys());
  return {
    db: {
      workflows: {
        async getById(id: number) {
          return store.get(id);
        },
        async listBySession(userId: string, sessionId: string) {
          return [...store.values()]
            .filter((w) => w.user_id === userId && w.created_from_session_id === sessionId)
            .sort((a, b) => b.id - a.id);
        },
        async listRunsByWorkflow(id: number) {
          return runsByWorkflow[id] ?? [];
        },
        async update(id: number, updates: { name?: string; graph?: string; bumpVersion?: boolean }) {
          const row = store.get(id);
          if (!row) return undefined;
          if (updates.name !== undefined) row.name = updates.name;
          if (updates.graph !== undefined) row.graph = updates.graph;
          if (updates.bumpVersion) row.version += 1;
          return row;
        },
        async create(input: { user_id: string; name: string; graph: string; created_from_session_id?: string }) {
          const row: Row = {
            id: ++seq,
            user_id: input.user_id,
            name: input.name,
            status: 'draft',
            version: 1,
            graph: input.graph,
            created_from_session_id: input.created_from_session_id ?? null,
          };
          store.set(row.id, row);
          return row;
        },
      },
    } as unknown as DatabaseProvider,
    store,
  };
}

const CTX = { userId: 'u1', sessionId: 'sess-A' };

function callPlan(db: DatabaseProvider, input: Record<string, unknown>) {
  const t = createWorkflowPlanTool(db, CTX) as unknown as {
    execute: (i: unknown) => Promise<Record<string, unknown>>;
  };
  return t.execute({ name: 'plan', task_input: '做点事', graph: GRAPH, ...input });
}

describe('workflow_plan — agent validation', () => {
  it('still accepts graphs stored under the retired profile ids', async () => {
    const { db } = fakeDb([]);
    const res = await callPlan(db, {
      action: 'draft',
      graph: { nodes: [{ id: 'only', agent: 'team', brief: { objective: 'x' } }], deliverable_node: 'only' },
    });
    expect(res.type).toBe('workflow_plan');
  });

  it('rejects an agent that is not a loadable profile', async () => {
    const { db } = fakeDb([]);
    const res = await callPlan(db, {
      action: 'draft',
      graph: { nodes: [{ id: 'only', agent: 'ghost', brief: { objective: 'x' } }], deliverable_node: 'only' },
    });
    expect(String(res.error)).toMatch(/unknown agent profile ghost/);
  });
});

describe('workflow_plan — update blast radius', () => {
  it('updates this conversation’s own draft', async () => {
    const { db, store } = fakeDb([
      {
        id: 7,
        user_id: 'u1',
        name: 'old',
        status: 'draft',
        version: 1,
        graph: '{}',
        created_from_session_id: 'sess-A',
      },
    ]);

    const res = await callPlan(db, { action: 'update', workflow_id: 7, name: 'revised' });

    expect(res.type).toBe('workflow_plan');
    expect(res.workflow_id).toBe(7);
    expect(store.get(7)!.name).toBe('revised');
    expect(store.get(7)!.version).toBe(2);
  });

  it('refuses a workflow belonging to a different conversation, even same owner', async () => {
    const { db, store } = fakeDb([
      {
        id: 1,
        user_id: 'u1',
        name: 'someone else’s confirmed plan',
        status: 'confirmed',
        version: 1,
        graph: '{"nodes":[],"deliverable_node":"x"}',
        created_from_session_id: 'sess-OTHER',
      },
      {
        id: 9,
        user_id: 'u1',
        name: 'mine',
        status: 'draft',
        version: 1,
        graph: '{}',
        created_from_session_id: 'sess-A',
      },
    ]);

    const res = await callPlan(db, { action: 'update', workflow_id: 1, name: 'clobbered' });

    expect(String(res.error)).toMatch(/not this conversation's draft/);
    expect(store.get(1)!.name).toBe('someone else’s confirmed plan');
    expect(store.get(1)!.version).toBe(1);
  });

  it('refuses when the conversation has no draft (its plan is already confirmed)', async () => {
    const { db, store } = fakeDb([
      {
        id: 3,
        user_id: 'u1',
        name: 'approved',
        status: 'confirmed',
        version: 1,
        graph: '{}',
        created_from_session_id: 'sess-A',
      },
    ]);

    const res = await callPlan(db, { action: 'update', workflow_id: 3 });

    expect(String(res.error)).toMatch(/no editable draft/);
    expect(store.get(3)!.version).toBe(1);
  });

  it('refuses to rewrite a draft that has already been executed', async () => {
    const { db, store } = fakeDb(
      [
        {
          id: 5,
          user_id: 'u1',
          name: 'ran once',
          status: 'draft',
          version: 1,
          graph: '{}',
          created_from_session_id: 'sess-A',
        },
      ],
      { 5: [{ id: 'run-1' }] },
    );

    const res = await callPlan(db, { action: 'update', workflow_id: 5 });

    expect(String(res.error)).toMatch(/already been executed/);
    expect(store.get(5)!.version).toBe(1);
  });

  it('ignores a hallucinated id when the conversation has no workflow at all', async () => {
    const { db, store } = fakeDb([
      {
        id: 42,
        user_id: 'u1',
        name: 'unrelated',
        status: 'draft',
        version: 1,
        graph: '{}',
        created_from_session_id: 'sess-OTHER',
      },
    ]);

    const res = await callPlan(db, { action: 'update', workflow_id: 42 });

    expect(String(res.error)).toMatch(/no editable draft/);
    expect(store.get(42)!.version).toBe(1);
  });

  it('draft always creates a new row bound to this conversation', async () => {
    const { db, store } = fakeDb([]);

    const res = await callPlan(db, { action: 'draft', name: 'fresh' });

    expect(res.type).toBe('workflow_plan');
    expect(store.get(res.workflow_id as number)!.created_from_session_id).toBe('sess-A');
  });
});
