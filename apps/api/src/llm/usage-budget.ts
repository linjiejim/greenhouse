/**
 * Provider-call usage budget guard — the model half of metering.
 *
 * Every model provider call reserves before I/O: the organization / provider
 * monthly token accounts AND the call's USD price against the member, `llm` (or
 * `vision`) service and organization USD accounts (usage/metering.ts — USD is
 * the primary limit). Once provider I/O may have started, a failed/unknown call
 * is deliberately left reserved for the DB TTL sweeper to charge at the
 * conservative estimate; only failures known to precede provider I/O release.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseProvider, UsageBudgetAccountInput, UsageRecord } from '@greenhouse/db';
import { getUtcMonthPeriod, UsageBudgetError, UsageBudgetExceededError } from '@greenhouse/db';
import {
  estimateTokens,
  getAvailableProviders,
  getModelEntry,
  type ProviderAttemptHook,
  type TokenPrice,
} from '@greenhouse/agent-core';
import type { MeteringClient } from '@greenhouse/types/metering';
import { UsageBudgetAdmissionError } from '../usage/budget-errors.js';
import { requireBudgetOwner, reserveSpend, resolveMeteringClient, type SpendLease } from '../usage/metering.js';
import {
  effectiveModelPrice,
  effectiveServicePrice,
  estimateTokenCostMicros,
  syncPriceOverrides,
  tokenCostMicros,
  tokenPriceSnapshot,
  type PriceSource,
} from '../usage/pricing.js';

export { UsageBudgetAdmissionError } from '../usage/budget-errors.js';

export const MODEL_BUDGET_TTL_MS = 20 * 60_000;

const DEFAULT_OUTPUT_TOKENS = 4_096;
/** Headroom over the tokenizer approximation for one concrete provider attempt. */
const PROVIDER_ATTEMPT_ESTIMATE_MARGIN = 1.25;
const TOOL_SCHEMA_TOKEN_ALLOWANCE = 16_000;
const DEFAULT_ORG_MONTHLY_TOKENS = 1_000_000_000;
const DEFAULT_PROVIDER_MONTHLY_TOKENS = 500_000_000;
const DEFAULT_ORG_SCOPE_ID = 'default';

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
  idempotencyKey?: string;
  ttlMs?: number;
  metadata?: Readonly<Record<string, unknown>>;
  /** Metered service: `llm` (default) for chat models, `vision` for analyze_image. */
  service?: 'llm' | 'vision';
  /** Catalog id (flash / pro / …) when `modelId` is the raw provider model. */
  logicalModelId?: string;
  /**
   * The price to meter at. Default: the model's price (admin override, else
   * models.yaml), or for `vision` the services.yaml / override token price.
   * Pass null for "unpriced"; an explicit price is never re-read at settlement.
   */
  tokenPrice?: TokenPrice | null;
  /** Split of `estimatedTokens`, for a tighter USD reservation. */
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  /** Attribution; defaults to the current metering scope, then the caller's usual client. */
  client?: MeteringClient;
  oauthClientId?: string | null;
  sessionId?: string;
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
  metadata?: Readonly<Record<string, unknown>>;
  /** Attribution; defaults to the current metering scope, then the caller's usual client. */
  client?: MeteringClient;
  oauthClientId?: string | null;
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
    const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
    const lease = await reserveUserTokenBudget({
      db: context.db,
      userId: context.userId,
      caller: context.caller,
      estimatedTokens,
      estimatedInputTokens: Math.max(1, estimatedTokens - maxOutputTokens),
      estimatedOutputTokens: maxOutputTokens,
      modelId: descriptor.modelId,
      ...(descriptor.logicalModelId ? { logicalModelId: descriptor.logicalModelId } : {}),
      providerId: descriptor.scopeId,
      providerScopeOverride: descriptor.scopeId,
      runId: context.runId ?? context.sessionId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.client ? { client: context.client } : {}),
      ...(context.oauthClientId !== undefined ? { oauthClientId: context.oauthClientId } : {}),
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
        const estimatedCost = lease.spend?.reserved ? lease.spend.estimatedUsdMicros : null;
        await lease.spend?.settle(estimatedCost, { provider_usage_missing: true });
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
          ...lease.usageAttribution(estimatedCost, lease.currentPrice()),
        });
      },
    };
  };
}

export interface OrganizationAttemptBudgetContext {
  db: DatabaseProvider;
  caller: string;
  profileId: string;
  metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Hard admission for a model call the organization pays for — there is no
 * member behind it (the monthly retro). USD only, against the `llm` service and
 * organization accounts with client `system`; the usage event carries no
 * user. Same outcome rules as the member hook: a refusal throws before I/O, a
 * call whose outcome is unknown stays reserved for the sweeper.
 */
export function createOrganizationAttemptBudgetHook(context: OrganizationAttemptBudgetContext): ProviderAttemptHook {
  return async ({ descriptor, options }) => {
    const startedAt = Date.now();
    const estimatedTokens = providerAttemptEstimate(options);
    const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
    await syncPriceOverrides(context.db);
    const applied = () => effectiveModelPrice(descriptor.modelId, descriptor.logicalModelId);
    const price = applied()?.price;
    const spend = await reserveSpend({
      db: context.db,
      service: 'llm',
      provider: descriptor.scopeId,
      model: descriptor.modelId,
      caller: context.caller,
      estimatedUsdMicros: price
        ? estimateTokenCostMicros(price, {
            inputTokens: Math.max(1, estimatedTokens - maxOutputTokens),
            outputTokens: maxOutputTokens,
          })
        : null,
      client: 'system',
      organizationOnly: true,
      ttlMs: MODEL_BUDGET_TTL_MS,
      metadata: {
        ...(context.metadata ?? {}),
        profile_id: context.profileId,
        provider: descriptor.provider,
        provider_scope: descriptor.scopeId,
        logical_model: descriptor.logicalModelId ?? null,
      },
    });
    return {
      markProviderIoStarted: () => spend.markProviderIoStarted(),
      settle: async (usage) => {
        const hasProviderUsage = usage.inputTokens !== undefined || usage.outputTokens !== undefined;
        const inputTokens = Math.max(0, usage.inputTokens ?? 0);
        const outputTokens = Math.max(0, usage.outputTokens ?? 0);
        const cachedTokens = Math.max(0, usage.cachedInputTokens ?? 0);
        await syncPriceOverrides(context.db);
        const appliedNow = applied();
        // A response without usage is not free: charge the reservation.
        const cost = hasProviderUsage
          ? tokenCostMicros(appliedNow?.price, { inputTokens, outputTokens, cachedInputTokens: cachedTokens })
          : spend.reserved
            ? spend.estimatedUsdMicros
            : null;
        await spend.settle(cost, { input_tokens: inputTokens, output_tokens: outputTokens });
        await context.db.usage.record({
          profile_id: context.profileId,
          caller: context.caller,
          model: descriptor.modelId,
          input_tokens: hasProviderUsage ? inputTokens : 0,
          output_tokens: hasProviderUsage ? outputTokens : 0,
          cached_tokens: hasProviderUsage ? cachedTokens : 0,
          reasoning_tokens: Math.max(0, usage.reasoningTokens ?? 0),
          duration_ms: Date.now() - startedAt,
          ...(spend.ledgerKey ? { budget_idempotency_key: spend.ledgerKey } : {}),
          cost_usd_micros: cost,
          client: 'system',
          oauth_client_id: null,
          service: 'llm',
          price_applied:
            cost !== null && appliedNow
              ? tokenPriceSnapshot(
                  appliedNow.price,
                  appliedNow.source,
                  appliedNow.model ? { model: appliedNow.model } : {},
                )
              : null,
        });
      },
    };
  };
}

function buildTokenSharedAccounts(input: ReserveUserTokenBudgetInput): UsageBudgetAccountInput[] {
  const period = getUtcMonthPeriod();
  const orgScope = process.env.USAGE_BUDGET_ORG_SCOPE_ID?.trim() || DEFAULT_ORG_SCOPE_ID;
  const providerScopes = providerBudgetScopes(input);

  return [
    {
      scope_type: 'organization',
      scope_id: orgScope,
      unit: 'tokens',
      period_start: period.start,
      period_end: period.end,
      limit_units: readPositiveLimit('USAGE_BUDGET_ORG_MONTHLY_TOKENS', DEFAULT_ORG_MONTHLY_TOKENS),
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
    /** The USD half of this call (null only for test doubles built without one). */
    public readonly spend: SpendLease | null = null,
    /**
     * The call's price as of now — re-read at settlement, so a price an admin
     * changes mid-call applies to the call settled after the change.
     */
    private readonly pricer: () => AppliedTokenPrice | undefined = () => undefined,
  ) {}

  /** The price this call settles at; undefined = unpriced. */
  currentPrice(): AppliedTokenPrice | undefined {
    return this.pricer();
  }

  markProviderIoStarted(): void {
    this.providerIoStarted = true;
    this.spend?.markProviderIoStarted();
  }

  async releaseBeforeProviderIo(reason: string): Promise<boolean> {
    if (this.providerIoStarted) return false;
    await this.db.usageBudget.release({
      idempotency_key: this.idempotencyKey,
      reason,
    });
    await this.spend?.releaseBeforeProviderIo(reason);
    return true;
  }

  /** See `SpendLease.releaseAfterProviderRefusal`: a definite provider refusal owes nothing. */
  async releaseAfterProviderRefusal(reason: string): Promise<void> {
    await this.db.usageBudget.release({ idempotency_key: this.idempotencyKey, reason });
    await this.spend?.releaseAfterProviderRefusal(reason);
  }

  /** Settle the token reservation (the USD half settles in settleAndRecordBudgetedUsage). */
  async settle(actualTokens: number, metadata?: Readonly<Record<string, unknown>>): Promise<void> {
    await this.db.usageBudget.settle({
      idempotency_key: this.idempotencyKey,
      actual_units: Math.max(0, Math.ceil(actualTokens)),
      metadata,
    });
  }

  /** The metering columns of this call's model usage event, with the price it was settled at. */
  usageAttribution(costUsdMicros: number | null, applied: AppliedTokenPrice | undefined) {
    const attribution = this.spend?.attribution;
    return {
      cost_usd_micros: costUsdMicros,
      client: attribution?.client ?? null,
      oauth_client_id: attribution?.oauthClientId ?? null,
      service: attribution?.service ?? 'llm',
      price_applied:
        costUsdMicros !== null && applied
          ? tokenPriceSnapshot(applied.price, applied.source, applied.model ? { model: applied.model } : {})
          : null,
    };
  }
}

export interface AppliedTokenPrice {
  price: TokenPrice;
  source: PriceSource;
  /** Catalog model id the price belongs to. */
  model?: string;
}

/** How a lease finds its price, now or at settlement. */
function pricerFor(input: ReserveUserTokenBudgetInput): () => AppliedTokenPrice | undefined {
  if (input.tokenPrice === null) return () => undefined;
  if (input.tokenPrice) {
    const fixed: AppliedTokenPrice = { price: input.tokenPrice, source: 'config' };
    return () => fixed;
  }
  if (input.service === 'vision') {
    return () => {
      const entry = effectiveServicePrice('vision', 'media');
      return entry?.tokenPrice ? { price: entry.tokenPrice, source: entry.source } : undefined;
    };
  }
  return () => effectiveModelPrice(input.modelId, input.logicalModelId);
}

function estimateUsd(input: ReserveUserTokenBudgetInput, price: TokenPrice | undefined, tokens: number) {
  if (!price) return null;
  if (input.estimatedInputTokens !== undefined || input.estimatedOutputTokens !== undefined) {
    return estimateTokenCostMicros(price, {
      inputTokens: input.estimatedInputTokens ?? 0,
      outputTokens: input.estimatedOutputTokens ?? 0,
    });
  }
  // Only a total is known: every token at the dearer rate.
  const dearer = Math.max(price.input, price.output);
  return estimateTokenCostMicros({ input: dearer, output: dearer }, { inputTokens: 0, outputTokens: tokens });
}

/**
 * Reserve the call's tokens against the organization and provider monthly
 * token accounts (env-configured caps), then its USD against the member /
 * service / organization accounts. The owner must be an active internal member.
 * A USD refusal releases the token reservation it just made.
 */
export async function reserveUserTokenBudget(input: ReserveUserTokenBudgetInput): Promise<UserTokenBudgetLease> {
  const estimatedTokens = positiveSafeInteger(input.estimatedTokens);
  const idempotencyKey = input.idempotencyKey ?? `${input.caller}:${randomUUID()}`;
  await syncPriceOverrides(input.db);
  const pricer = pricerFor(input);
  const price = pricer()?.price;

  try {
    const user = await requireBudgetOwner(input.db, input.userId);
    const tokenAccounts = await Promise.all(
      buildTokenSharedAccounts(input).map((account) => input.db.usageBudget.ensureAccount(account)),
    );
    await input.db.usageBudget.reserve({
      account_ids: tokenAccounts.map((account) => account.id),
      user_id: user.id,
      idempotency_key: idempotencyKey,
      estimated_units: estimatedTokens,
      caller: input.caller,
      ttl_ms: input.ttlMs ?? MODEL_BUDGET_TTL_MS,
      model_id: input.modelId,
      provider_id: input.providerId,
      run_id: input.runId,
      metadata: input.metadata,
    });
  } catch (err) {
    throw toAdmissionError(err);
  }

  let spend: SpendLease;
  try {
    spend = await reserveSpend({
      db: input.db,
      service: input.service ?? 'llm',
      provider: input.providerScopeOverride ?? input.providerId ?? input.modelId ?? 'unattributed',
      model: input.modelId ?? null,
      caller: input.caller,
      estimatedUsdMicros: estimateUsd(input, price, estimatedTokens),
      userId: input.userId,
      ownerVerified: true,
      client: resolveMeteringClient(input.client, input.caller),
      ...(input.oauthClientId !== undefined ? { oauthClientId: input.oauthClientId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      idempotencyKey: `${idempotencyKey}:usd`,
      ttlMs: input.ttlMs ?? MODEL_BUDGET_TTL_MS,
      metadata: { token_reservation: idempotencyKey, logical_model: input.logicalModelId ?? null },
    });
  } catch (err) {
    // Nothing reached the provider: give the tokens back before refusing.
    await input.db.usageBudget
      .release({ idempotency_key: idempotencyKey, reason: 'usd_budget_refused' })
      .catch(() => {});
    throw err;
  }
  return new UserTokenBudgetLease(input.db, idempotencyKey, estimatedTokens, spend, pricer);
}

export type BudgetedUsageRecord = Omit<
  UsageRecord,
  'budget_idempotency_key' | 'cost_usd_micros' | 'client' | 'oauth_client_id' | 'service'
>;

/**
 * Settle the token and USD reservations, then append the model usage event with
 * the same key, its cost and its attribution. Callers may catch failures after
 * provider I/O; an unsettled reservation remains conservative and expires to
 * the original estimate.
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
  await syncPriceOverrides(db);
  const applied = lease.currentPrice();
  const cost = tokenCostMicros(applied?.price, {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cached_tokens ?? 0,
  });
  await lease.spend?.settle(cost, { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens });
  await db.usage.record({
    ...usage,
    budget_idempotency_key: lease.idempotencyKey,
    ...lease.usageAttribution(cost, applied),
  });
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
