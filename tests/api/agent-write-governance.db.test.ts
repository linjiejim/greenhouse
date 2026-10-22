/**
 * Governed writes by external agents, end to end on the real Runtime tables:
 * tiers, standing grants, the legacy confirm switch, exactly-once approval,
 * supersede/withdraw/reject/expire, and the boot reconciliation that never
 * replays a write whose outcome is unknown.
 *
 * The write tool is a fake `tables_mutation` that counts its executions, so
 * "ran at most once" is asserted directly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';
import type { ToolRegistry } from '../../apps/api/src/agent.js';
import {
  AgentWriteError,
  agentWriteStatus,
  decideAgentWrite,
  governProxyWrite,
  reconcileInterruptedAgentWrites,
  sweepExpiredAgentWrites,
  withdrawAgentWrite,
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

function govern(input: Record<string, unknown>, opts: { legacy?: boolean } = {}) {
  return governProxyWrite({
    db,
    caller,
    toolId: TOOL,
    input,
    registry,
    allowedToolIds: [TOOL],
    baseRisk: 'r2',
    legacyConfirm: opts.legacy ?? false,
  });
}

const okContext = async () => ({ ok: true as const, registry, toolIds: [TOOL] });

async function pendingInterruptId(requestId: string): Promise<string> {
  const interrupts = await db.runtime.listInterrupts(requestId);
  const pending = interrupts.find((interrupt) => interrupt.status === 'pending');
  if (!pending) throw new Error('no pending interrupt');
  return pending.id;
}

describe('governed external-agent writes', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    member = await createInternalTestUser(db, { email: `${unique('awg-member')}@test.local` });
    other = await createInternalTestUser(db, { email: `${unique('awg-other')}@test.local` });
    const client = await db.platformOAuth.registerClient({
      id: unique('client'),
      client_name: 'Codex',
      redirect_uris: '[]',
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
      approverUserId: member.id,
    };
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('holds an r2 write for approval, runs it exactly once when approved, and records the output', async () => {
    const result = await govern({ action: 'records.update', record_id: 'rec_1', values: { a: 1 } });
    expect(result.status).toBe('needs_approval');
    expect(result.view.risk).toBe('r2');
    expect(calls).toHaveLength(0);

    const again = await govern({ action: 'records.update', record_id: 'rec_1', values: { a: 1 } });
    expect(again.status).toBe('needs_approval');
    expect(again.view.request_id).toBe(result.view.request_id);
    expect(again.status === 'needs_approval' && again.reused).toBe(true);

    const interruptId = await pendingInterruptId(result.view.request_id);
    const decided = await decideAgentWrite({
      db,
      interruptId,
      actor: { id: member.id, role: 'team' },
      decision: 'approve',
      resolveContext: okContext,
    });
    expect(decided.status).toBe('executed');
    expect(decided.basis).toBe('approved');
    expect(decided.output).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);

    // A second click (or a second approver) loses and runs nothing.
    await expect(
      decideAgentWrite({
        db,
        interruptId,
        actor: { id: member.id, role: 'team' },
        decision: 'approve',
        resolveContext: okContext,
      }),
    ).rejects.toBeInstanceOf(AgentWriteError);
    expect(calls).toHaveLength(1);

    const status = await agentWriteStatus(db, result.view.request_id, caller);
    expect(status.status).toBe('executed');
  });

  it('approve-and-allow creates a standing grant that covers the next r2 write but never a delete', async () => {
    const first = await govern({ action: 'records.update', record_id: 'rec_2', values: {} });
    await decideAgentWrite({
      db,
      interruptId: await pendingInterruptId(first.view.request_id),
      actor: { id: member.id, role: 'team' },
      decision: 'approve',
      grantDays: 7,
      resolveContext: okContext,
    });
    const grants = await db.agentWriteGrants.listForUser(member.id);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ tool_id: TOOL, action: 'records.update', client_id: caller.clientId });

    const covered = await govern({ action: 'records.update', record_id: 'rec_3', values: {} });
    expect(covered.status).toBe('executed');
    expect(covered.view.basis).toBe('standing_grant');
    expect((await db.agentWriteGrants.listForUser(member.id))[0]!.use_count).toBe(1);

    await db.agentWriteGrants.create({
      user_id: member.id,
      client_id: null,
      tool_id: TOOL,
      action: null,
      days: 30,
      created_via: 'settings',
    });
    const deletion = await govern({ action: 'records.delete', record_id: 'rec_3' });
    expect(deletion.status).toBe('needs_approval');
    expect(deletion.view.risk).toBe('r3');
    expect(calls).toHaveLength(2);
  });

  it('refuses to pre-approve when approving an r3 write', async () => {
    const deletion = await govern({ action: 'records.delete', record_id: 'rec_9' });
    await expect(
      decideAgentWrite({
        db,
        interruptId: await pendingInterruptId(deletion.view.request_id),
        actor: { id: member.id, role: 'team' },
        decision: 'approve',
        grantDays: 30,
        resolveContext: okContext,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(calls).toHaveLength(0);
  });

  it('honours legacy confirm:true for r2 writes only', async () => {
    const legacy = await govern({ action: 'records.update', record_id: 'rec_4', values: {} }, { legacy: true });
    expect(legacy.status).toBe('executed');
    expect(legacy.view.basis).toBe('legacy_confirm');
    const deletion = await govern({ action: 'records.delete', record_id: 'rec_4' }, { legacy: true });
    expect(deletion.status).toBe('needs_approval');
    expect(calls).toHaveLength(1);
  });

  it('runs a personal knowledge create at once (r1)', async () => {
    registry = { knowledge_mutation: registry[TOOL] } as unknown as ToolRegistry;
    const result = await governProxyWrite({
      db,
      caller,
      toolId: 'knowledge_mutation',
      input: { action: 'knowledge.create_doc', scope: 'personal', title: 't', content: 'c' },
      registry,
      allowedToolIds: ['knowledge_mutation'],
      baseRisk: 'r2',
      legacyConfirm: false,
    });
    expect(result.status).toBe('executed');
    expect(result.view.basis).toBe('own_reversible');
    expect(result.view.risk).toBe('r1');
  });

  it('rejects, supersedes and withdraws without ever executing', async () => {
    const rejected = await govern({ action: 'records.update', record_id: 'rec_5', values: { v: 1 } });
    const view = await decideAgentWrite({
      db,
      interruptId: await pendingInterruptId(rejected.view.request_id),
      actor: { id: member.id, role: 'team' },
      decision: 'reject',
      resolveContext: okContext,
    });
    expect(view.status).toBe('rejected');

    const older = await govern({ action: 'records.update', record_id: 'rec_6', values: { v: 1 } });
    const newer = await govern({ action: 'records.update', record_id: 'rec_6', values: { v: 2 } });
    expect(newer.view.request_id).not.toBe(older.view.request_id);
    expect((await agentWriteStatus(db, older.view.request_id, caller)).status).toBe('superseded');

    const withdrawn = await withdrawAgentWrite(db, newer.view.request_id, caller);
    expect(withdrawn.status).toBe('withdrawn');
    expect(calls).toHaveLength(0);
  });

  it('lets only the assignee (or a super) decide, and only the calling agent read its request', async () => {
    const result = await govern({ action: 'records.update', record_id: 'rec_7', values: {} });
    await expect(
      decideAgentWrite({
        db,
        interruptId: await pendingInterruptId(result.view.request_id),
        actor: { id: other.id, role: 'team' },
        decision: 'approve',
        resolveContext: okContext,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      agentWriteStatus(db, result.view.request_id, { userId: other.id, clientId: caller.clientId }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      agentWriteStatus(db, result.view.request_id, { userId: member.id, clientId: 'another-client' }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(calls).toHaveLength(0);
  });

  it('fails an approved write the agent is no longer permitted to make', async () => {
    const result = await govern({ action: 'records.update', record_id: 'rec_8', values: {} });
    const view = await decideAgentWrite({
      db,
      interruptId: await pendingInterruptId(result.view.request_id),
      actor: { id: member.id, role: 'team' },
      decision: 'approve',
      resolveContext: async () => ({ ok: false as const, reason: "The agent's access has been revoked" }),
    });
    expect(view.status).toBe('failed');
    expect(view.error).toContain('revoked');
    expect(calls).toHaveLength(0);
  });

  it('expires a request nobody decided', async () => {
    const result = await govern({ action: 'records.update', record_id: 'rec_10', values: {} });
    // The Runtime worker expires interrupts; run it as if 25 hours had passed.
    await db.runtime.expireInterrupts(new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(await sweepExpiredAgentWrites(db)).toBeGreaterThanOrEqual(1);
    expect((await agentWriteStatus(db, result.view.request_id, caller)).status).toBe('expired');
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
