/**
 * Recorded writes by external agents, end to end on the real Runtime tables:
 * a permitted write runs at once and is recorded, a delete returns a preview
 * until the agent confirms, unknown outcomes are never reported as failures,
 * and the boot reconciliation never replays a write.
 *
 * The write tool is a fake `tables_mutation` that counts its executions, so
 * "ran / did not run" is asserted directly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';
import type { ToolRegistry } from '../../apps/api/src/agent.js';
import { ProxyToolError } from '../../apps/api/src/agent-runtime/tool-proxy.js';
import {
  governProxyWrite,
  reconcileInterruptedAgentWrites,
  type WriteCaller,
} from '../../apps/api/src/agent-access/governed-write.js';

let db: DatabaseProvider;
let member: UserRow;
let other: UserRow;
let calls: unknown[];
let registry: ToolRegistry;
let caller: WriteCaller;
const TOOL = 'tables_mutation';

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function govern(input: Record<string, unknown>, opts: { confirmed?: boolean } = {}) {
  return governProxyWrite({
    db,
    caller,
    toolId: TOOL,
    input,
    registry,
    allowedToolIds: [TOOL],
    baseRisk: 'r2',
    confirmed: opts.confirmed ?? false,
  });
}

async function writeRuns() {
  return (await db.runtime.listRuns({ owner_user_id: member.id, kinds: ['agent_write'], limit: 50 })).items;
}

describe('recorded external-agent writes', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    member = await createInternalTestUser(db, { email: `${unique('awg-member')}@test.local` });
    other = await createInternalTestUser(db, { email: `${unique('awg-other')}@test.local` });
    const client = await db.platformOAuth.registerClient({
      id: unique('client'),
      client_name: 'Codex',
      redirect_uris: [],
      created_by: member.id,
    });
    calls = [];
    registry = {
      [TOOL]: {
        description: 'fake',
        execute: async (input: unknown) => {
          calls.push(input);
          return { ok: true, echoed: input };
        },
      },
    } as unknown as ToolRegistry;
    caller = {
      userId: member.id,
      clientId: client.id,
      clientName: 'Codex',
      authMethod: 'oauth',
    };
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('runs a permitted shared-data write at once, as the member, and records it', async () => {
    const result = await govern({ action: 'records.update', record_id: 'rec_1', values: { a: 1 } });
    expect(result.status).toBe('executed');
    if (result.status !== 'executed') throw new Error('expected executed');
    expect(result.view).toMatchObject({ status: 'executed', risk: 'r2', basis: 'direct', client_name: 'Codex' });
    expect(result.view.output).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);

    const [run] = await writeRuns();
    expect(run).toMatchObject({ id: result.view.request_id, status: 'succeeded', owner_user_id: member.id });
    expect(run!.input).toMatchObject({ tool_id: TOOL, action: 'records.update', risk: 'r2' });
    const [call] = await db.runtime.listToolCalls(run!.id);
    expect(call).toMatchObject({ status: 'succeeded' });
  });

  it('records a personal knowledge create as r1', async () => {
    registry.knowledge_mutation = registry[TOOL]!;
    const result = await governProxyWrite({
      db,
      caller,
      toolId: 'knowledge_mutation',
      input: { action: 'knowledge.create_doc', scope: 'personal', title: 'Mine', content: 'x' },
      registry,
      allowedToolIds: ['knowledge_mutation'],
      baseRisk: 'r2',
      confirmed: false,
    });
    expect(result.status).toBe('executed');
    if (result.status !== 'executed') throw new Error('expected executed');
    expect(result.view).toMatchObject({ risk: 'r1', basis: 'direct' });
  });

  it('answers a delete with a preview and runs nothing until the agent confirms', async () => {
    const preview = await govern({ action: 'records.delete', record_id: 'rec_2' });
    expect(preview).toMatchObject({
      status: 'needs_confirmation',
      preview: {
        status: 'needs_confirmation',
        tool: TOOL,
        action: 'records.delete',
        risk: 'r3',
        input: { record_id: 'rec_2' },
      },
    });
    expect(calls).toHaveLength(0);
    expect(await writeRuns()).toHaveLength(0);

    const confirmed = await govern({ action: 'records.delete', record_id: 'rec_2' }, { confirmed: true });
    expect(confirmed.status).toBe('executed');
    if (confirmed.status !== 'executed') throw new Error('expected executed');
    expect(confirmed.view).toMatchObject({ risk: 'r3', basis: 'confirmed' });
    expect(calls).toHaveLength(1);
  });

  it('ignores confirm on ordinary writes', async () => {
    const result = await govern({ action: 'records.update', record_id: 'rec_3', values: {} }, { confirmed: true });
    expect(result.status).toBe('executed');
    if (result.status !== 'executed') throw new Error('expected executed');
    expect(result.view.basis).toBe('direct');
  });

  it("records the tool's own refusal as a failed write", async () => {
    registry[TOOL] = {
      description: 'fake',
      execute: async () => ({ error: 'Record not found' }),
    } as unknown as ToolRegistry[string];
    const result = await govern({ action: 'records.update', record_id: 'missing', values: {} });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.view).toMatchObject({ status: 'failed', error: 'Record not found' });
  });

  it('refuses a tool the agent cannot reach before anything is recorded', async () => {
    await expect(
      governProxyWrite({
        db,
        caller,
        toolId: TOOL,
        input: { action: 'records.update' },
        registry,
        allowedToolIds: [],
        baseRisk: 'r2',
        confirmed: false,
      }),
    ).rejects.toBeInstanceOf(ProxyToolError);
    expect(await writeRuns()).toHaveLength(0);
  });

  it('reports outcome unknown, not failed, when the write ran but its result was not recorded', async () => {
    const transition = db.runtime.transitionToolCall.bind(db.runtime);
    db.runtime.transitionToolCall = (async (input: Parameters<typeof transition>[0]) => {
      if (input.to_status === 'succeeded') throw new Error('database went away');
      return transition(input);
    }) as typeof transition;
    try {
      const result = await govern({ action: 'records.update', record_id: 'rec_21', values: {} });
      expect(calls).toHaveLength(1);
      expect(result.status).toBe('outcome_unknown');
      if (result.status !== 'outcome_unknown') throw new Error('expected outcome_unknown');
      expect(result.view.status).toBe('outcome_unknown');
    } finally {
      db.runtime.transitionToolCall = transition;
    }
  });

  it('still settles as outcome unknown when even the uncertain marker cannot be written', async () => {
    const transition = db.runtime.transitionToolCall.bind(db.runtime);
    db.runtime.transitionToolCall = (async (input: Parameters<typeof transition>[0]) => {
      if (input.to_status === 'succeeded' || input.to_status === 'uncertain') throw new Error('database went away');
      return transition(input);
    }) as typeof transition;
    try {
      const result = await govern({ action: 'records.update', record_id: 'rec_23', values: {} });
      expect(calls).toHaveLength(1);
      // Never left running: no sweep would ever pick it up again.
      expect(result.status).toBe('outcome_unknown');
      if (result.status !== 'outcome_unknown') throw new Error('expected outcome_unknown');
      expect(result.view.status).toBe('outcome_unknown');
    } finally {
      db.runtime.transitionToolCall = transition;
    }
  });

  it('names a team document on the record but never a private one its owner cannot read', async () => {
    const team = await db.knowledgeBase.create({
      doc_id: unique('kb-team'),
      title: 'Team roadmap',
      content: 'x',
      visibility: 'team',
      owner_user_id: other.id,
      created_by: other.id,
    });
    const secret = await db.knowledgeBase.create({
      doc_id: unique('kb-secret'),
      title: 'Salary review',
      content: 'x',
      visibility: 'private',
      owner_user_id: other.id,
      created_by: other.id,
    });
    const knowledge = (docId: string) =>
      governProxyWrite({
        db,
        caller,
        toolId: 'knowledge_mutation',
        input: { action: 'knowledge.append_doc', doc_id: docId, content: 'more' },
        registry: { knowledge_mutation: registry[TOOL] } as unknown as ToolRegistry,
        allowedToolIds: ['knowledge_mutation'],
        baseRisk: 'r2',
        confirmed: false,
      });
    expect(((await knowledge(team.doc_id)) as { view: { target_label: string | null } }).view.target_label).toBe(
      'Team roadmap',
    );
    expect(
      ((await knowledge(secret.doc_id)) as { view: { target_label: string | null } }).view.target_label,
    ).toBeNull();
  });

  it('closes a write left running by a crash as outcome unknown and never replays it', async () => {
    let run = await db.runtime.createRun({
      kind: 'agent_write',
      owner_user_id: member.id,
      initiated_by_user_id: member.id,
      source_kind: 'proxy_call',
      source_id: unique('awr'),
      max_attempts: 1,
      input: {
        version: 1,
        channel: 'mcp',
        client_id: caller.clientId,
        client_name: 'Codex',
        auth_method: 'oauth',
        tool_id: TOOL,
        action: 'records.update',
        risk: 'r2',
        target_key: null,
        input_hash: 'x',
        input: {},
      },
    });
    const step = await db.runtime.createStep({ run_id: run.id, step_key: 'proxy_call', kind: 'proxy_call', input: {} });
    run = await db.runtime.transitionRun({
      id: run.id,
      expected_version: run.version,
      to_status: 'claimed',
      idempotency_key: unique('c'),
    });
    run = await db.runtime.transitionRun({
      id: run.id,
      expected_version: run.version,
      to_status: 'running',
      idempotency_key: unique('r'),
      projection_only: true,
    });
    expect(step.status).toBe('queued');
    expect(await reconcileInterruptedAgentWrites(db)).toBeGreaterThanOrEqual(1);
    const after = await db.runtime.getRun(run.id);
    expect(after?.status).toBe('interrupted');
    expect(after?.error_code).toBe('agent_write_outcome_unknown');
    expect(calls).toHaveLength(0);
  });
});
