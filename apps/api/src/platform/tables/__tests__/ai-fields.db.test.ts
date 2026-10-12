/** AI producers and worker against PostgreSQL; each test rolls back its fixtures. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetProvider,
  initDatabase,
  parseTableFieldConfig,
  type DatabaseProvider,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { fullTableAccess } from '@greenhouse/types/table-access';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests, getPlatformRuntime } from '../../runtime.js';
import { humanActor } from '../../actor.js';
import { tablesRegistration } from '../application.js';
import { aiFieldAccount } from '../ai-fields.js';
import { createProviderAttemptBudgetHook } from '../../../llm/usage-budget.js';
import { createTablesAiRunner } from '../ai-worker.js';

let db: DatabaseProvider;
let owner: UserRow;
beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  owner = await createInternalTestUser(db, { email: `ai-${crypto.randomUUID()}@test.local`, nickname: 'AI owner' });
  initializePlatformRuntime(db, [tablesRegistration]);
});
afterEach(() => {
  resetPlatformRuntimeForTests();
  _resetProvider();
  vi.restoreAllMocks();
});

async function fixture(autoUpdate = true) {
  const base = await db.tables.createBase({ name: 'Feedback', owner_id: owner.id, created_by: owner.id });
  const { table, fields } = await db.tables.createTable({ base_id: base.id, name: 'Feedback', created_by: owner.id });
  const primary = fields.find((field) => field.is_primary)!;
  const input = await db.tables.createField({
    table_id: table.id,
    name: 'Feedback',
    type: 'long_text',
    created_by: owner.id,
  });
  const ai = await db.tables.createField({
    table_id: table.id,
    name: 'Summary',
    type: 'ai',
    config: {
      ai: { prompt: `Summarize {{field:${input.id}}}`, inputFieldIds: [input.id], resultType: 'text', autoUpdate },
    },
    created_by: owner.id,
  });
  const scope = fullTableAccess(owner.id);
  const meta = { actorId: owner.id, actorKind: 'user' as const, enqueueAutomations: false };
  const create = (text = 'Helpful product') =>
    db.tables.createRecord({ table_id: table.id, values: { [primary.id]: 'Feedback', [input.id]: text } }, scope, meta);
  const generate = vi.fn(async () => ({ text: '{"value":"Useful"}', tokens: 20, model: 'test' }));
  const runner = createTablesAiRunner({ db, generate, workerId: 'ai-test', concurrency: 2 });
  return { base, table, primary, input, ai, scope, meta, create, generate, runner };
}

async function action(name: string, payload: Record<string, unknown>) {
  return getPlatformRuntime().dispatch({
    appId: 'tables',
    actionId: name,
    actor: humanActor({ id: owner.id }),
    payload,
  });
}

describe('AI fields', () => {
  it('queues only input changes and preserves results on record and schema recomputation', async () => {
    const f = await fixture();
    const row = await f.create();
    expect((await db.tables.aiFieldJobs(f.ai.id))[0]?.status).toBe('queued');
    await f.runner.runOnce();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect((await db.tables.getRecord(f.table.id, row.id, f.scope))?.computed_values[String(f.ai.id)]).toBe('Useful');
    const updated = await db.tables.updateRecord(
      { table_id: f.table.id, record_id: row.id, revision: row.revision, values: { [f.primary.id]: 'Renamed' } },
      f.scope,
      f.meta,
    );
    expect(updated.ok).toBe(true);
    await f.runner.runOnce();
    expect(f.generate).toHaveBeenCalledTimes(1);
    await db.tables.createField({
      table_id: f.table.id,
      name: 'Constant',
      type: 'formula',
      config: { formula: { resultType: 'number', expression: { type: 'literal', value: 3 } } },
      created_by: owner.id,
    });
    expect((await db.tables.getRecord(f.table.id, row.id, f.scope))?.computed_values[String(f.ai.id)]).toBe('Useful');
    await db.tables.updateRecord(
      {
        table_id: f.table.id,
        record_id: row.id,
        revision: row.revision + 1,
        values: { [f.input.id]: 'Changed input' },
      },
      f.scope,
      f.meta,
    );
    expect((await db.tables.aiFieldJobs(f.ai.id))[0]?.status).toBe('queued');
  });
  it('manual fill runs with autoUpdate off and skips nonempty results', async () => {
    const f = await fixture(false);
    await f.create();
    expect(await db.tables.aiFieldJobs(f.ai.id)).toHaveLength(0);
    expect(await action('fillAiField', { fieldId: f.ai.id })).toMatchObject({ ok: true, data: { queued: 1 } });
    await f.runner.runOnce();
    expect(await action('fillAiField', { fieldId: f.ai.id })).toMatchObject({ ok: true, data: { queued: 0 } });
    expect(await action('regenerateAiField', { fieldId: f.ai.id })).toMatchObject({ ok: true, data: { queued: 1 } });
  });
  it('rejects a stale result after any edit during generation', async () => {
    const f = await fixture();
    const row = await f.create();
    f.generate.mockImplementationOnce(async () => {
      await db.tables.updateRecord(
        {
          table_id: f.table.id,
          record_id: row.id,
          revision: row.revision,
          values: { [f.primary.id]: 'Renamed while generating' },
        },
        f.scope,
        f.meta,
      );
      return { text: '{"value":"Old"}', tokens: 12, model: 'test' };
    });
    await f.runner.runOnce();
    expect((await db.tables.getRecord(f.table.id, row.id, f.scope))?.computed_values[String(f.ai.id)]).toBeUndefined();
    expect((await db.tables.aiFieldJobs(f.ai.id))[0]).toMatchObject({ status: 'failed', error: 'inputs_changed' });
  });
  it('supersedes old inputs and rejects changed configs before committing', async () => {
    const f = await fixture();
    const row = await f.create();
    const [old] = await db.tables.claimAiJobs({ workerId: 'first', leaseMs: 180000, limit: 1 });
    await db.tables.updateRecord(
      { table_id: f.table.id, record_id: row.id, revision: row.revision, values: { [f.input.id]: 'New input' } },
      f.scope,
      f.meta,
    );
    expect(
      await db.tables.completeAiJob(
        { id: old!.id, attempt: old!.attempt, workerId: 'first' },
        { revision: row.revision, value: 'old', tokens: 1, model: 'test' },
      ),
    ).toBe(false);
    f.generate.mockImplementationOnce(async () => {
      await db.tables.updateField(f.ai.id, {
        updated_by: owner.id,
        config: { ai: { ...parseTableFieldConfig(f.ai).ai!, prompt: 'A different instruction' } },
      });
      return { text: '{"value":"Old config"}', tokens: 10, model: 'test' };
    });
    await f.runner.runOnce();
    expect((await db.tables.getRecord(f.table.id, row.id, f.scope))?.computed_values[String(f.ai.id)]).toBeUndefined();
  });
  it('fails closed when the payer is disabled or its AI switch is revoked', async () => {
    const f = await fixture();
    await f.create();
    await db.userFeatures.upsert({ user_id: owner.id, feature: 'tables_ai_fields', enabled: false });
    await f.runner.runOnce();
    expect(f.generate).not.toHaveBeenCalled();
    expect((await db.tables.aiFieldJobs(f.ai.id))[0]).toMatchObject({ status: 'failed', error: 'payer_unavailable' });
    expect(await action('regenerateAiField', { fieldId: f.ai.id })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });
  it('limits each pass and never hands one lease to two workers; expiry needs explicit retry', async () => {
    const f = await fixture();
    await f.create();
    await f.create();
    await f.create();
    const at = new Date();
    const first = await db.tables.claimAiJobs({ workerId: 'a', leaseMs: 1000, limit: 2, at });
    const second = await db.tables.claimAiJobs({ workerId: 'b', leaseMs: 1000, limit: 2, at });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((job) => job.id)).size).toBe(3);
    expect(
      await db.tables.claimAiJobs({ workerId: 'c', leaseMs: 1000, limit: 4, at: new Date(at.getTime() + 1001) }),
    ).toHaveLength(0);
    expect((await db.tables.aiFieldJobs(f.ai.id)).every((job) => job.error === 'generation_interrupted')).toBe(true);
  });
  it('rechecks Base editing authority before a paid call', async () => {
    const f = await fixture();
    await f.create();
    const other = await createInternalTestUser(db, {
      email: `ai-other-${crypto.randomUUID()}@test.local`,
      nickname: 'New owner',
    });
    await db.tables.transferBaseOwner(f.base.id, {
      newOwnerId: other.id,
      previousOwnerRole: 'viewer',
      actorId: owner.id,
    });
    await f.runner.runOnce();
    expect(f.generate).not.toHaveBeenCalled();
    expect((await db.tables.aiFieldJobs(f.ai.id))[0]).toMatchObject({ error: 'payer_unavailable' });
  });
  it('atomically applies the monthly field cap and skips fills after exhaustion', async () => {
    const f = await fixture(false);
    await f.create();
    const config = { ...parseTableFieldConfig(f.ai).ai!, monthlyTokenCap: 1000 };
    await db.tables.updateField(f.ai.id, { updated_by: owner.id, config: { ai: config } });
    const hook = createProviderAttemptBudgetHook({
      db,
      userId: owner.id,
      caller: 'tables-ai-field',
      profileId: 'system',
      extraAccounts: [aiFieldAccount(f.ai.id, config)],
    });
    const input = {
      descriptor: {
        provider: 'openai-compatible' as const,
        modelId: 'test',
        apiKeyEnv: 'LLM_API_KEY',
        scopeId: 'ai:test',
      },
      options: {
        prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Feedback' }] }],
        maxOutputTokens: 100,
      },
    };
    const attempt = await hook(input);
    attempt.markProviderIoStarted();
    await attempt.settle({ inputTokens: 900, outputTokens: 100 });
    await expect(hook(input)).rejects.toMatchObject({ code: 'usage_budget_exceeded' });
    expect(await action('fillAiField', { fieldId: f.ai.id })).toMatchObject({
      ok: true,
      data: { queued: 0, skipped: 1, capReached: true },
    });
  });
  it('clears answers before replacing dependencies or changing result type', async () => {
    const f = await fixture();
    const row = await f.create();
    await f.runner.runOnce();
    const config = parseTableFieldConfig(f.ai).ai!;
    await db.tables.updateField(f.ai.id, {
      updated_by: owner.id,
      config: { ai: { ...config, monthlyTokenCap: 50000 } },
    });
    expect((await db.tables.getRecord(f.table.id, row.id, f.scope))?.computed_values[String(f.ai.id)]).toBe('Useful');
    await db.tables.updateField(f.ai.id, {
      updated_by: owner.id,
      config: { ai: { ...config, prompt: 'Score', inputFieldIds: [f.primary.id], resultType: 'number' } },
    });
    expect((await db.tables.getRecord(f.table.id, row.id, f.scope))?.computed_values[String(f.ai.id)]).toBeUndefined();
    expect(
      (
        await db.tables.queryRecords(
          f.table.id,
          { where: { combinator: 'and', clauses: [{ fieldId: f.ai.id, operator: 'gt', value: 1 }] } },
          f.scope,
        )
      ).records,
    ).toHaveLength(0);
  });
  it('does not offer create/update/fill to an account whose AI switch is off', async () => {
    const f = await fixture(false);
    await db.userFeatures.upsert({ user_id: owner.id, feature: 'tables_ai_fields', enabled: false });
    expect(
      await action('createField', {
        tableId: f.table.id,
        name: 'Other',
        type: 'ai',
        config: { ai: parseTableFieldConfig(f.ai).ai },
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await action('updateField', { fieldId: f.ai.id, name: 'Rename' })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(await action('fillAiField', { fieldId: f.ai.id })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });
  it('validates outputs and status without exposing provider error details', async () => {
    const f = await fixture();
    const row = await f.create();
    f.generate.mockRejectedValueOnce(new Error('provider secret abc'));
    await f.runner.runOnce();
    expect(await action('getAiFieldStatus', { fieldId: f.ai.id, recordIds: [row.id] })).toMatchObject({
      ok: true,
      data: { counts: { failed: 1 }, records: { [row.id]: { state: 'failed', error: 'generation_failed' } } },
    });
  });
});
