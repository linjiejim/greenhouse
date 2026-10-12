/** Bounded paid cell generation. Record writes only enqueue; no tools are exposed to the model. */
import { randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import {
  createModelFromConfig,
  resolveModelConfig,
  buildProviderOptions,
  usageTotalsFrom,
  getModelEntry,
} from '@greenhouse/agent-core';
import { aiInputHash, parseTableFieldConfig, type DatabaseProvider, type TableRecomputeJobRow } from '@greenhouse/db';
import { fullTableAccess } from '@greenhouse/types/table-access';
import type { TableAiFieldConfig } from '@greenhouse/types/tables';
import { runWithConcurrency } from '@greenhouse/utils/concurrency';
import { logger } from '@greenhouse/utils/logger';
import { activeUserHasFeature } from '../../auth/features.js';
import { createProviderAttemptBudgetHook } from '../../llm/usage-budget.js';
import { defaultOnSwitch } from '../../trusted-execution/kill-switches.js';
import { humanActor } from '../actor.js';
import { getPlatformRuntime } from '../runtime.js';
import { baseForField, requireBase, requireTableData } from './access.js';
import { aiFieldAccount, aiFieldPrompt, validateAiResult } from './ai-fields.js';
import { publishRecordsChanged } from './realtime.js';

export const TABLES_AI_LEASE_MS = 180_000;
export const tablesAiWorkerEnabled = () => defaultOnSwitch(process.env, 'TABLES_AI_WORKER', []);

type GenerateInput = {
  config: TableAiFieldConfig;
  fieldId: number;
  userId: string;
  instructions: string;
  prompt: string;
  signal: AbortSignal;
};
type Generate = (input: GenerateInput) => Promise<{ text: string; tokens: number; model: string }>;

function generator(db: DatabaseProvider): Generate {
  return async (input) => {
    const id = input.config.model ?? 'flash';
    const primary = getModelEntry(id)?.providers[0];
    if (!primary) throw new Error('model_unavailable');
    const config = resolveModelConfig({
      id,
      provider: primary.provider,
      model: primary.model,
      apiKey: primary.apiKeyEnv,
    });
    const model = await createModelFromConfig(config, {
      onProviderAttempt: createProviderAttemptBudgetHook({
        db,
        userId: input.userId,
        caller: 'tables-ai-field',
        profileId: 'system',
        extraAccounts: [aiFieldAccount(input.fieldId, input.config)],
        metadata: { field_id: input.fieldId },
      }),
    });
    const result = await generateText({
      model,
      instructions: input.instructions,
      messages: [{ role: 'user', content: input.prompt }],
      maxOutputTokens: 2_048,
      maxRetries: 0,
      abortSignal: input.signal,
      providerOptions: buildProviderOptions(config),
    });
    const usage = usageTotalsFrom(result.usage);
    return { text: result.text, tokens: usage.inputTokens + usage.outputTokens, model: input.config.model ?? 'flash' };
  };
}

export function createTablesAiRunner(options: {
  db: DatabaseProvider;
  workerId?: string;
  concurrency?: number;
  generate?: Generate;
}) {
  const { db } = options;
  const workerId = options.workerId ?? `tables-ai:${randomUUID()}`;
  const concurrency = Math.min(8, Math.max(1, options.concurrency ?? 4));
  const generate = options.generate ?? generator(db);
  let busy = false;
  const process = async (job: TableRecomputeJobRow) => {
    const ref = { id: job.id, attempt: job.attempt, workerId };
    try {
      const field = job.field_id && (await db.tables.getField(job.field_id));
      const config = field && parseTableFieldConfig(field).ai;
      if (!field || field.archived_at || field.type !== 'ai' || !config || !job.record_id)
        throw new Error('field_unavailable');
      const authorize = async () => {
        const user = await db.users.getById(field.created_by);
        const base = await baseForField(db, field.id);
        const actor = humanActor({ id: field.created_by });
        if (
          !user ||
          user.status !== 'active' ||
          !['super', 'team'].includes(user.role) ||
          !base ||
          !(await activeUserHasFeature(user.id, 'tables', db)) ||
          !(await activeUserHasFeature(user.id, 'tables_ai_fields', db)) ||
          !(await requireBase({ db }, actor, base.id, 'record', 'editor')) ||
          !(await requireTableData({ actor }, { db }, field.table_id, 'read')) ||
          !(await requireTableData({ actor }, { db }, field.table_id, 'update')) ||
          !(await getPlatformRuntime().authorize(actor, 'tables.data.read')).allowed ||
          !(await getPlatformRuntime().authorize(actor, 'tables.data.update')).allowed
        )
          throw new Error('payer_unavailable');
        return base;
      };
      const base = await authorize();
      const record = await db.tables.getRecord(job.table_id, job.record_id, fullTableAccess(field.created_by));
      if (!record || aiInputHash(config, { ...record.values, ...record.computed_values }) !== job.input_hash)
        throw new Error('inputs_changed');
      const result = await generate({
        config,
        fieldId: field.id,
        userId: field.created_by,
        ...aiFieldPrompt(config, { ...record.values, ...record.computed_values }),
        signal: AbortSignal.timeout(120_000),
      });
      const value = validateAiResult(config, result.text);
      await authorize();
      if (
        await db.tables.completeAiJob(ref, {
          revision: record.revision,
          value,
          tokens: result.tokens,
          model: result.model,
        })
      )
        await publishRecordsChanged({ db }, base, job.table_id, [record.id]);
    } catch (error) {
      // Store bounded, actionable codes only. Provider error text can contain
      // keys or record contents and must not appear in a cell/status response.
      const message = error instanceof Error ? error.message : '';
      const code = ['field_unavailable', 'payer_unavailable', 'inputs_changed', 'invalid_result'].includes(message)
        ? message
        : error instanceof Error && 'code' in error && String(error.code).startsWith('usage_budget_')
          ? 'budget_exceeded'
          : 'generation_failed';
      await db.tables.failAiJob(ref, code);
    }
  };
  return {
    async runOnce() {
      if (busy) return;
      busy = true;
      try {
        const jobs = await db.tables.claimAiJobs({ workerId, limit: concurrency, leaseMs: TABLES_AI_LEASE_MS });
        await runWithConcurrency(jobs, concurrency, process);
      } finally {
        busy = false;
      }
    },
  };
}

export function startTablesAiWorker(options: { db: DatabaseProvider }) {
  const runner = createTablesAiRunner(options);
  const run = () =>
    runner.runOnce().catch((error) => logger.error('[tables-ai] worker pass failed', { error: String(error) }));
  const timer = setInterval(() => {
    void run();
  }, 2_000);
  timer.unref();
  void run();
  return { stop: () => clearInterval(timer) };
}
