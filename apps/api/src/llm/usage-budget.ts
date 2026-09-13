/**
 * Provider-call usage budget guard.
 *
 * Every model/image provider call must reserve the owning user's monthly token
 * budget before I/O. Once provider I/O may have started, a failed/unknown call
 * is deliberately left reserved for the DB TTL sweeper to charge at the
 * conservative estimate; only failures known to precede provider I/O release.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseProvider, UsageBudgetAccountInput, UsageRecord } from '@greenhouse/db';
import { getUtcMonthPeriod, UsageBudgetError, UsageBudgetExceededError } from '@greenhouse/db';
import { estimateTokens, getAvailableProviders, getModelEntry, type ProviderAttemptHook } from '@greenhouse/agent-core';

export const MODEL_BUDGET_TTL_MS = 20 * 60_000;
export const IMAGE_BUDGET_TTL_MS = 5 * 60_000;

const DEFAULT_OUTPUT_TOKENS = 4_096;
/** Headroom over the tokenizer approximation for one concrete provider attempt. */
const PROVIDER_ATTEMPT_ESTIMATE_MARGIN = 1.25;
const TOOL_SCHEMA_TOKEN_ALLOWANCE = 16_000;
const DEFAULT_ORG_MONTHLY_TOKENS = 1_000_000_000;
const DEFAULT_PROVIDER_MONTHLY_TOKENS = 500_000_000;
const DEFAULT_EVAL_MONTHLY_TOKENS = 100_000_000;
const DEFAULT_USER_MONTHLY_IMAGE_USD_MICROS = 20_000_000;
const DEFAULT_ORG_MONTHLY_IMAGE_USD_MICROS = 2_000_000_000;
const DEFAULT_PROVIDER_MONTHLY_IMAGE_USD_MICROS = 2_000_000_000;
const DEFAULT_ORG_SCOPE_ID = 'default';

export type UsageBudgetPool = 'standard' | 'eval';

export class UsageBudgetAdmissionError extends Error {
  constructor(
    message: string,
    public readonly status: 403 | 429 | 503,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'UsageBudgetAdmissionError';
  }
}

export interface ReserveUserTokenBudgetInput {
  db: DatabaseProvider;
  userId: string;
  caller: string;
  estimatedTokens: number;
  modelId?: string;
  providerId?: string;
  /** Exact concrete billing scope; bypasses logical-model fallback expansion. */
  providerScopeOverride?: string;
  runId?: string;
  /** Eval traffic consumes an isolated organization pool instead of production capacity. */
  budgetPool?: UsageBudgetPool;
  idempotencyKey?: string;
  ttlMs?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ReserveImageUsdBudgetInput {
  db: DatabaseProvider;
  userId: string;
  caller: string;
  estimatedUsdMicros: number;
  providerId: string;
  modelId?: string;
  runId?: string;
  idempotencyKey?: string;
  ttlMs?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

function positiveSafeInteger(value: number): number {
  const rounded = Math.ceil(value);
  if (!Number.isSafeInteger(rounded) || rounded <= 0) {
    throw new UsageBudgetAdmissionError(
      'Unable to establish a safe usage estimate for this request',
      503,
      'usage_budget_estimate_invalid',
    );
  }
  return rounded;
}

function readPositiveLimit(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UsageBudgetAdmissionError(
      `Usage budget configuration ${name} must be a positive integer`,
      503,
      'usage_budget_configuration_invalid',
    );
  }
  return parsed;
}

/** Judge/eval callers are isolated even when an older call site has not passed the explicit pool yet. */
export function resolveUsageBudgetPool(caller: string, explicit?: UsageBudgetPool): UsageBudgetPool {
  if (explicit) return explicit;
  return /(^|[-_:])(eval|judge)([-_:]|$)/i.test(caller) ? 'eval' : 'standard';
}

function providerBudgetScopes(input: ReserveUserTokenBudgetInput): string[] {
  if (input.providerScopeOverride?.trim()) return [input.providerScopeOverride.trim()];
  if (input.modelId && getModelEntry(input.modelId)) {
    const scopes = getAvailableProviders(input.modelId).map(
      (entry) => `${entry.apiKeyEnv}:${entry.provider}:${entry.baseUrl ?? 'default'}`,
    );
    if (scopes.length > 0) return [...new Set(scopes)];
  }
  return [input.providerId?.trim() || input.modelId?.trim() || 'unattributed'];
}

export interface ProviderAttemptBudgetContext {
  db: DatabaseProvider;
  userId: string;
  caller: string;
  profileId: string;
  sessionId?: string;
  runId?: string;
  budgetPool?: UsageBudgetPool;
  metadata?: Readonly<Record<string, unknown>>;
}

function providerAttemptEstimate(options: Parameters<ProviderAttemptHook>[0]['options']): number {
  let serialized: string;
  try {
    serialized =
      JSON.stringify({
        prompt: options.prompt,
        tools: options.tools ?? [],
        responseFormat: options.responseFormat ?? null,
      }) ?? '';
  } catch {
    // V3 prompts/tools are JSON data. If a non-standard adapter violates that
    // contract, fail conservatively instead of silently underestimating.
    throw new UsageBudgetAdmissionError(
      'Unable to establish a safe provider request estimate',
      503,
      'usage_budget_estimate_invalid',
    );
  }
  // Estimate with the same tokenizer approximation the rest of this module
  // uses, plus a margin — not the UTF-8 byte count.
  //
  // Byte count is a true upper bound, but on real traffic it is ~4-5x the
  // tokens actually billed (dev, 390 settled reservations: chat reserved 148k
  // for 36k actual). Admission compares that inflated number against free
  // headroom, so a user is refused with ~20% of their limit still unspent, and
  // an unknown-outcome call is charged at the inflated estimate on TTL expiry.
  // A reservation is not a charge — settle() writes the real usage — so the
  // job here is a good estimate with headroom, not an unbeatable ceiling.
  const inputTokens = estimateTokens(serialized);
  const estimate = inputTokens * PROVIDER_ATTEMPT_ESTIMATE_MARGIN + (options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS);
  return positiveSafeInteger(Math.max(1, estimate));
}

/**
 * Hard admission at the concrete LanguageModelV3 attempt boundary.
 *
 * AI SDK retries, tool-loop steps and registry fallbacks all cross this seam,
 * so every actual provider I/O gets a fresh atomic user/org/provider reserve.
 */
export function createProviderAttemptBudgetHook(context: ProviderAttemptBudgetContext): ProviderAttemptHook {
  return async ({ descriptor, options }) => {
    const startedAt = Date.now();
    const estimatedTokens = providerAttemptEstimate(options);
    const lease = await reserveUserTokenBudget({
      db: context.db,
      userId: context.userId,
      caller: context.caller,
      estimatedTokens,
      modelId: descriptor.modelId,
      providerId: descriptor.scopeId,
      providerScopeOverride: descriptor.scopeId,
      runId: context.runId ?? context.sessionId,
      budgetPool: context.budgetPool,
      metadata: {
        ...(context.metadata ?? {}),
        profile_id: context.profileId,
        session_id: context.sessionId ?? null,
        provider: descriptor.provider,
        provider_scope: descriptor.scopeId,
        provider_model: descriptor.modelId,
        logical_model: descriptor.logicalModelId ?? null,
        request_input_token_estimate: Math.max(1, estimatedTokens - (options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS)),
        max_output_tokens: options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
      },
    });

    return {
      markProviderIoStarted: () => lease.markProviderIoStarted(),
      settle: async (usage) => {
        const inputTokens = Math.max(0, usage.inputTokens ?? 0);
        const outputTokens = Math.max(0, usage.outputTokens ?? 0);
        const hasProviderUsage = usage.inputTokens !== undefined || usage.outputTokens !== undefined;
        if (hasProviderUsage) {
          await settleAndRecordBudgetedUsage(context.db, lease, {
            profile_id: context.profileId,
            caller: context.caller,
            session_id: context.sessionId,
            user_id: context.userId,
            model: descriptor.modelId,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cached_tokens: Math.max(0, usage.cachedInputTokens ?? 0),
            reasoning_tokens: Math.max(0, usage.reasoningTokens ?? 0),
            duration_ms: Date.now() - startedAt,
          });
          return;
        }

        // A successful adapter response without usage is not free. Charge the
        // safe estimate while keeping the statistical fact explicitly zero.
        await lease.settle(lease.estimatedTokens, { provider_usage_missing: true });
        await context.db.usage.record({
          profile_id: context.profileId,
          caller: context.caller,
          session_id: context.sessionId,
          user_id: context.userId,
          model: descriptor.modelId,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          reasoning_tokens: 0,
          duration_ms: Date.now() - startedAt,
          budget_idempotency_key: lease.idempotencyKey,
        });
      },
    };
  };
}

function buildTokenSharedAccounts(input: ReserveUserTokenBudgetInput): UsageBudgetAccountInput[] {
  const period = getUtcMonthPeriod();
  const orgScope = process.env.USAGE_BUDGET_ORG_SCOPE_ID?.trim() || DEFAULT_ORG_SCOPE_ID;
  const pool = resolveUsageBudgetPool(input.caller, input.budgetPool);
  const providerScopes = providerBudgetScopes(input);

  return [
    {
      scope_type: 'organization',
      scope_id: pool === 'eval' ? `${orgScope}:eval` : orgScope,
      unit: 'tokens',
      period_start: period.start,
      period_end: period.end,
      limit_units:
        pool === 'eval'
          ? readPositiveLimit('USAGE_BUDGET_EVAL_MONTHLY_TOKENS', DEFAULT_EVAL_MONTHLY_TOKENS)
          : readPositiveLimit('USAGE_BUDGET_ORG_MONTHLY_TOKENS', DEFAULT_ORG_MONTHLY_TOKENS),
      bootstrap_metadata: { budget_pool: pool },
      update_existing_limit: true,
    },
    ...providerScopes.map(
      (providerScope): UsageBudgetAccountInput => ({
        scope_type: 'provider',
        scope_id: providerScope,
        unit: 'tokens',
        period_start: period.start,
        period_end: period.end,
        limit_units: readPositiveLimit('USAGE_BUDGET_PROVIDER_MONTHLY_TOKENS', DEFAULT_PROVIDER_MONTHLY_TOKENS),
        bootstrap_metadata: { provider_id: providerScope, logical_model: input.modelId ?? null },
        update_existing_limit: true,
      }),
    ),
  ];
}

function toAdmissionError(err: unknown): UsageBudgetAdmissionError {
  if (err instanceof UsageBudgetAdmissionError) return err;
  if (err instanceof UsageBudgetExceededError) {
    return new UsageBudgetAdmissionError(
      'Monthly token budget exceeded. Contact an administrator to increase the limit.',
      429,
      err.code,
      { cause: err },
    );
  }
  if (err instanceof UsageBudgetError) {
    const status = err.code === 'usage_budget_account_unavailable' ? 403 : 503;
    return new UsageBudgetAdmissionError('Usage budget is unavailable for this request', status, err.code, {
      cause: err,
    });
  }
  return new UsageBudgetAdmissionError(
    'Usage budget service is temporarily unavailable',
    503,
    'usage_budget_unavailable',
    { cause: err },
  );
}

/**
 * One reservation lease. `releaseBeforeProviderIo` is intentionally a no-op
 * after `markProviderIoStarted`: an interrupted network call has unknown cost
 * and must be charged by expiry rather than made free.
 */
export class UserTokenBudgetLease {
  private providerIoStarted = false;

  constructor(
    private readonly db: DatabaseProvider,
    public readonly idempotencyKey: string,
    public readonly estimatedTokens: number,
  ) {}

  markProviderIoStarted(): void {
    this.providerIoStarted = true;
  }

  async releaseBeforeProviderIo(reason: string): Promise<boolean> {
    if (this.providerIoStarted) return false;
    await this.db.usageBudget.release({
      idempotency_key: this.idempotencyKey,
      reason,
    });
    return true;
  }

  async settle(actualTokens: number, metadata?: Readonly<Record<string, unknown>>): Promise<void> {
    await this.db.usageBudget.settle({
      idempotency_key: this.idempotencyKey,
      actual_units: Math.max(0, Math.ceil(actualTokens)),
      metadata,
    });
  }
}

/** USD-denominated image lease; image output pricing is not comparable to text tokens. */
export class ImageUsdBudgetLease {
  private providerIoStarted = false;

  constructor(
    private readonly db: DatabaseProvider,
    public readonly idempotencyKey: string,
    public readonly estimatedUsdMicros: number,
  ) {}

  markProviderIoStarted(): void {
    this.providerIoStarted = true;
  }

  async releaseBeforeProviderIo(reason: string): Promise<boolean> {
    if (this.providerIoStarted) return false;
    await this.db.usageBudget.release({ idempotency_key: this.idempotencyKey, reason });
    return true;
  }

  async settle(actualUsdMicros: number, metadata?: Readonly<Record<string, unknown>>): Promise<void> {
    await this.db.usageBudget.settle({
      idempotency_key: this.idempotencyKey,
      actual_units: Math.max(0, Math.ceil(actualUsdMicros)),
      metadata,
    });
  }
}

async function requireBudgetOwner(db: DatabaseProvider, userId: string) {
  const user = await db.users.getById(userId);
  if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) {
    throw new UsageBudgetAdmissionError(
      'The account responsible for this request is unavailable',
      403,
      'usage_budget_subject_unavailable',
    );
  }
  return user;
}

/** Reserve the active internal owner's current UTC-month token account. */
export async function reserveUserTokenBudget(input: ReserveUserTokenBudgetInput): Promise<UserTokenBudgetLease> {
  const estimatedTokens = positiveSafeInteger(input.estimatedTokens);
  const idempotencyKey = input.idempotencyKey ?? `${input.caller}:${randomUUID()}`;

  try {
    const user = await requireBudgetOwner(input.db, input.userId);
    await input.db.usageBudget.reserveMonthlyUser({
      user_id: user.id,
      limit_tokens: user.monthly_token_limit,
      idempotency_key: idempotencyKey,
      estimated_units: estimatedTokens,
      caller: input.caller,
      ttl_ms: input.ttlMs ?? MODEL_BUDGET_TTL_MS,
      model_id: input.modelId,
      provider_id: input.providerId,
      run_id: input.runId,
      additional_accounts: buildTokenSharedAccounts(input),
      metadata: input.metadata,
    });
    return new UserTokenBudgetLease(input.db, idempotencyKey, estimatedTokens);
  } catch (err) {
    throw toAdmissionError(err);
  }
}

/** Reserve image spend atomically across user, organization, and provider USD accounts. */
export async function reserveImageUsdBudget(input: ReserveImageUsdBudgetInput): Promise<ImageUsdBudgetLease> {
  const estimatedUsdMicros = positiveSafeInteger(input.estimatedUsdMicros);
  const idempotencyKey = input.idempotencyKey ?? `${input.caller}:${randomUUID()}`;

  try {
    const user = await requireBudgetOwner(input.db, input.userId);
    const period = getUtcMonthPeriod();
    const orgScope = process.env.USAGE_BUDGET_ORG_SCOPE_ID?.trim() || DEFAULT_ORG_SCOPE_ID;
    const accountInputs: UsageBudgetAccountInput[] = [
      {
        scope_type: 'user',
        scope_id: user.id,
        unit: 'usd_micros',
        period_start: period.start,
        period_end: period.end,
        limit_units: readPositiveLimit(
          'USAGE_BUDGET_USER_MONTHLY_IMAGE_USD_MICROS',
          DEFAULT_USER_MONTHLY_IMAGE_USD_MICROS,
        ),
        bootstrap_metadata: { workload: 'image' },
        update_existing_limit: true,
      },
      {
        scope_type: 'organization',
        scope_id: `${orgScope}:image`,
        unit: 'usd_micros',
        period_start: period.start,
        period_end: period.end,
        limit_units: readPositiveLimit(
          'USAGE_BUDGET_ORG_MONTHLY_IMAGE_USD_MICROS',
          DEFAULT_ORG_MONTHLY_IMAGE_USD_MICROS,
        ),
        bootstrap_metadata: { workload: 'image' },
        update_existing_limit: true,
      },
      {
        scope_type: 'provider',
        scope_id: input.providerId,
        unit: 'usd_micros',
        period_start: period.start,
        period_end: period.end,
        limit_units: readPositiveLimit(
          'USAGE_BUDGET_PROVIDER_MONTHLY_IMAGE_USD_MICROS',
          DEFAULT_PROVIDER_MONTHLY_IMAGE_USD_MICROS,
        ),
        bootstrap_metadata: { workload: 'image', provider_id: input.providerId },
        update_existing_limit: true,
      },
    ];
    const accounts = await Promise.all(accountInputs.map((account) => input.db.usageBudget.ensureAccount(account)));
    await input.db.usageBudget.reserve({
      account_ids: accounts.map((account) => account.id),
      idempotency_key: idempotencyKey,
      estimated_units: estimatedUsdMicros,
      caller: input.caller,
      user_id: user.id,
      run_id: input.runId,
      provider_id: input.providerId,
      model_id: input.modelId,
      ttl_ms: input.ttlMs ?? IMAGE_BUDGET_TTL_MS,
      metadata: input.metadata,
    });
    return new ImageUsdBudgetLease(input.db, idempotencyKey, estimatedUsdMicros);
  } catch (err) {
    throw toAdmissionError(err);
  }
}

export type BudgetedUsageRecord = Omit<UsageRecord, 'budget_idempotency_key'>;

/**
 * Settle the hard-budget ledger, then append the statistical llm_usage fact
 * with the same key. Callers may catch failures after provider I/O; an unsettled
 * reservation remains conservative and expires to the original estimate.
 */
export async function settleAndRecordBudgetedUsage(
  db: DatabaseProvider,
  lease: UserTokenBudgetLease,
  usage: BudgetedUsageRecord,
): Promise<void> {
  const actualTokens = Math.max(0, usage.input_tokens) + Math.max(0, usage.output_tokens);
  await lease.settle(actualTokens, {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cached_tokens: usage.cached_tokens ?? 0,
    reasoning_tokens: usage.reasoning_tokens ?? 0,
  });
  await db.usage.record({ ...usage, budget_idempotency_key: lease.idempotencyKey });
}

/** Settle an image's dollar budget and preserve its provider token usage as a linked fact. */
export async function settleAndRecordBudgetedImageUsage(
  db: DatabaseProvider,
  lease: ImageUsdBudgetLease,
  actualUsdMicros: number,
  usage: BudgetedUsageRecord,
): Promise<void> {
  await lease.settle(actualUsdMicros, {
    usd_micros: Math.max(0, Math.ceil(actualUsdMicros)),
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
  });
  await db.usage.record({ ...usage, budget_idempotency_key: lease.idempotencyKey });
}

/**
 * Conservative upper bound for one bounded agent loop. Tool schemas/results
 * are not available as plain text at this layer, so reserve a fixed schema
 * allowance plus the declared per-step output cap for every possible step.
 */
export function estimateAgentLoopTokens(input: {
  system: string;
  messages: readonly unknown[];
  maxSteps: number;
  maxOutputTokens?: number;
  /** AI SDK retries per provider call (default 2). */
  maxRetries?: number;
  /** DeepSeek's tool-less final-answer streams, each with its own retries. */
  finalAnswerAttempts?: number;
}): number {
  const serializedMessages = JSON.stringify(input.messages);
  const basePromptTokens = estimateTokens(input.system) + estimateTokens(serializedMessages);
  const promptTokens = basePromptTokens + TOOL_SCHEMA_TOKEN_ALLOWANCE;
  const outputPerStep = positiveSafeInteger(input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS);
  const steps = Math.max(1, Math.ceil(input.maxSteps));
  // Every tool step re-sends the system/tool schema, prior transcript and all
  // generated/tool-result context. Without exact tool-result byte bounds at
  // this layer, charge a conservative triangular context-growth envelope:
  // step N can include the base prompt plus N-1 full output-sized results.
  const repeatedBasePrompt = promptTokens * steps;
  const triangularGeneratedContext = outputPerStep * ((steps * (steps + 1)) / 2);
  const primaryLoop = repeatedBasePrompt + triangularGeneratedContext;
  // The fallback flattens tool evidence to at most 16k characters. In the
  // worst case every character is a token, so keep the allowance in token
  // units rather than assuming Latin text.
  const finalAnswerAttempt = basePromptTokens + 16_000 + outputPerStep;
  const allLogicalAttempts = primaryLoop + finalAnswerAttempt * Math.max(0, Math.ceil(input.finalAnswerAttempts ?? 0));
  const providerAttemptMultiplier = Math.max(0, Math.ceil(input.maxRetries ?? 2)) + 1;
  return positiveSafeInteger(allLogicalAttempts * providerAttemptMultiplier);
}

/** Conservative single-completion bound, including SDK retry attempts. */
export function estimateCompletionTokens(input: {
  system: string;
  messages: readonly unknown[];
  maxOutputTokens?: number;
  maxRetries?: number;
}): number {
  const oneAttempt =
    estimateTokens(input.system) +
    estimateTokens(JSON.stringify(input.messages)) +
    positiveSafeInteger(input.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS);
  return positiveSafeInteger(oneAttempt * (Math.max(0, Math.ceil(input.maxRetries ?? 3)) + 1));
}

/**
 * Conservative bound for one exact relay request. Every forwarded field is
 * counted, including tool schemas and response formats. UTF-8 byte length is
 * a safe upper bound on tokenizer pieces and avoids an untrusted client hiding
 * a huge schema behind a tiny `messages` array.
 */
export function estimateRelayTokens(forwardedBody: Record<string, unknown>, maxOutputTokens: number): number {
  return positiveSafeInteger(
    Buffer.byteLength(JSON.stringify(forwardedBody), 'utf8') + positiveSafeInteger(maxOutputTokens),
  );
}
