import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_REGISTRY, setModelRegistry } from '@greenhouse/agent-core';
import {
  UsageBudgetAdmissionError,
  createProviderAttemptBudgetHook,
  estimateAgentLoopTokens,
  estimateCompletionTokens,
  estimateRelayTokens,
  reserveImageUsdBudget,
  reserveUserTokenBudget,
  resolveUsageBudgetPool,
  settleAndRecordBudgetedUsage,
  settleAndRecordBudgetedImageUsage,
} from './usage-budget.js';

function fixture() {
  const reserveMonthlyUser = vi.fn().mockResolvedValue([]);
  const settle = vi.fn().mockResolvedValue([]);
  const release = vi.fn().mockResolvedValue([]);
  const ensureAccount = vi.fn(async (input: { scope_type: string; scope_id: string; unit?: string }) => ({
    id: `${input.scope_type}:${input.scope_id}:${input.unit ?? 'tokens'}`,
  }));
  const reserve = vi.fn().mockResolvedValue([]);
  const record = vi.fn().mockResolvedValue(undefined);
  const db = {
    users: {
      getById: vi.fn().mockResolvedValue({
        id: 'user-1',
        role: 'team',
        status: 'active',
        monthly_token_limit: 20_000_000,
      }),
    },
    usageBudget: { ensureAccount, reserve, reserveMonthlyUser, settle, release },
    usage: { record },
  };
  return { db, ensureAccount, record, release, reserve, reserveMonthlyUser, settle };
}

describe('provider usage-budget guard', () => {
  it('reserves before I/O and records the same idempotency key after settlement', async () => {
    const f = fixture();
    const lease = await reserveUserTokenBudget({
      db: f.db as never,
      userId: 'user-1',
      caller: 'test',
      estimatedTokens: 100,
      idempotencyKey: 'test:key',
    });
    lease.markProviderIoStarted();
    await settleAndRecordBudgetedUsage(f.db as never, lease, {
      profile_id: 'team',
      caller: 'test',
      user_id: 'user-1',
      model: 'flash',
      input_tokens: 40,
      output_tokens: 20,
    });

    expect(f.reserveMonthlyUser).toHaveBeenCalledWith(expect.objectContaining({ idempotency_key: 'test:key' }));
    expect(f.reserveMonthlyUser).toHaveBeenCalledWith(
      expect.objectContaining({
        additional_accounts: expect.arrayContaining([
          expect.objectContaining({ scope_type: 'organization', scope_id: 'default', unit: 'tokens' }),
          expect.objectContaining({ scope_type: 'provider', scope_id: 'unattributed', unit: 'tokens' }),
        ]),
      }),
    );
    expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ idempotency_key: 'test:key', actual_units: 60 }));
    expect(f.record).toHaveBeenCalledWith(expect.objectContaining({ budget_idempotency_key: 'test:key' }));
  });

  it('only releases while provider I/O is known not to have started', async () => {
    const f = fixture();
    const beforeIo = await reserveUserTokenBudget({
      db: f.db as never,
      userId: 'user-1',
      caller: 'test',
      estimatedTokens: 10,
      idempotencyKey: 'test:before',
    });
    expect(await beforeIo.releaseBeforeProviderIo('validation_failed')).toBe(true);

    const unknownOutcome = await reserveUserTokenBudget({
      db: f.db as never,
      userId: 'user-1',
      caller: 'test',
      estimatedTokens: 10,
      idempotencyKey: 'test:after',
    });
    unknownOutcome.markProviderIoStarted();
    expect(await unknownOutcome.releaseBeforeProviderIo('network_failed')).toBe(false);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('fails closed before provider I/O when the owner cannot be resolved', async () => {
    const f = fixture();
    f.db.users.getById.mockRejectedValue(new Error('database unavailable'));
    await expect(
      reserveUserTokenBudget({
        db: f.db as never,
        userId: 'user-1',
        caller: 'test',
        estimatedTokens: 10,
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'usage_budget_unavailable',
    } satisfies Partial<UsageBudgetAdmissionError>);
    expect(f.reserveMonthlyUser).not.toHaveBeenCalled();
  });

  it('uses conservative declared upper bounds for loops, retries, and relay defaults', () => {
    expect(estimateAgentLoopTokens({ system: '', messages: [], maxSteps: 2, maxOutputTokens: 100 })).toBeGreaterThan(
      16_000,
    );
    expect(estimateCompletionTokens({ system: '', messages: [], maxOutputTokens: 100, maxRetries: 2 })).toBe(303);
    expect(estimateRelayTokens({ messages: [] }, 20_000)).toBe(20_015);
    expect(
      estimateRelayTokens(
        { messages: [], tools: [{ function: { parameters: { huge: 'x'.repeat(20_000) } } }] },
        20_000,
      ),
    ).toBeGreaterThan(40_000);
  });

  it('isolates judge and eval traffic into the dedicated organization pool', async () => {
    const f = fixture();
    await reserveUserTokenBudget({
      db: f.db as never,
      userId: 'user-1',
      caller: 'batch-eval-judge',
      estimatedTokens: 10,
      providerId: 'deepseek',
    });

    expect(resolveUsageBudgetPool('chat-eval')).toBe('eval');
    expect(resolveUsageBudgetPool('chat', 'eval')).toBe('eval');
    expect(f.reserveMonthlyUser).toHaveBeenCalledWith(
      expect.objectContaining({
        additional_accounts: expect.arrayContaining([
          expect.objectContaining({
            scope_type: 'organization',
            scope_id: 'default:eval',
            limit_units: 100_000_000,
          }),
          expect.objectContaining({ scope_type: 'provider', scope_id: 'deepseek' }),
        ]),
      }),
    );
  });

  it('reserves every configured billing credential in a registry fallback chain', async () => {
    const f = fixture();
    const previousPrimary = process.env.LLM_API_KEY;
    const previousFallback = process.env.FALLBACK_API_KEY;
    process.env.LLM_API_KEY = 'primary-test-key';
    process.env.FALLBACK_API_KEY = 'fallback-test-key';
    setModelRegistry({
      flash: {
        name: 'Chained model',
        providers: [
          { provider: 'openai-compatible', model: 'primary-model', apiKeyEnv: 'LLM_API_KEY' },
          {
            provider: 'openai-compatible',
            model: 'fallback-model',
            apiKeyEnv: 'FALLBACK_API_KEY',
            baseUrl: 'https://fallback.example.com/v1',
          },
        ],
      },
    });
    try {
      await reserveUserTokenBudget({
        db: f.db as never,
        userId: 'user-1',
        caller: 'chat',
        estimatedTokens: 10,
        modelId: 'flash',
      });
      const input = f.reserveMonthlyUser.mock.calls[0]![0] as {
        additional_accounts: Array<{ scope_type: string; scope_id: string }>;
      };
      expect(input.additional_accounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ scope_type: 'provider', scope_id: 'LLM_API_KEY:openai-compatible:default' }),
          expect.objectContaining({
            scope_type: 'provider',
            scope_id: 'FALLBACK_API_KEY:openai-compatible:https://fallback.example.com/v1',
          }),
        ]),
      );
    } finally {
      setModelRegistry(DEFAULT_MODEL_REGISTRY);
      if (previousPrimary === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = previousPrimary;
      if (previousFallback === undefined) delete process.env.FALLBACK_API_KEY;
      else process.env.FALLBACK_API_KEY = previousFallback;
    }
  });

  it('meters one concrete provider attempt with a token estimate and actual credential scope', async () => {
    const f = fixture();
    const hook = createProviderAttemptBudgetHook({
      db: f.db as never,
      userId: 'user-1',
      caller: 'chat',
      profileId: 'custom:7@3',
      sessionId: 'session-1',
    });
    const attempt = await hook({
      descriptor: {
        provider: 'openai-compatible',
        modelId: 'deepseek-v4-0324',
        apiKeyEnv: 'SILICONFLOW_API_KEY',
        baseUrl: 'https://api.siliconflow.cn/v1',
        logicalModelId: 'flash',
        scopeId: 'SILICONFLOW_API_KEY:openai-compatible:https://api.siliconflow.cn/v1',
      },
      options: {
        prompt: [{ role: 'user', content: [{ type: 'text', text: '你好 world' }] }],
        tools: [],
        maxOutputTokens: 200,
      },
    });

    const reservation = f.reserveMonthlyUser.mock.calls[0]![0] as {
      estimated_units: number;
      additional_accounts: Array<{ scope_type: string; scope_id: string }>;
    };
    expect(reservation.estimated_units).toBeGreaterThan(200);
    expect(reservation.additional_accounts.filter((account) => account.scope_type === 'provider')).toEqual([
      expect.objectContaining({
        scope_id: 'SILICONFLOW_API_KEY:openai-compatible:https://api.siliconflow.cn/v1',
      }),
    ]);

    attempt.markProviderIoStarted();
    await attempt.settle({ inputTokens: 40, outputTokens: 20, cachedInputTokens: 5, reasoningTokens: 3 });
    expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ actual_units: 60 }));
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({
        profile_id: 'custom:7@3',
        model: 'deepseek-v4-0324',
        input_tokens: 40,
        output_tokens: 20,
      }),
    );
  });

  it('estimates a provider attempt in tokens, not payload bytes', async () => {
    const f = fixture();
    const hook = createProviderAttemptBudgetHook({
      db: f.db as never,
      userId: 'user-1',
      caller: 'chat',
      profileId: 'team',
    });
    // Stands in for a real chat payload: tool schemas dominate and are ASCII
    // JSON, where one token covers roughly four bytes.
    const toolSchema = 'a'.repeat(40_000);
    await hook({
      descriptor: {
        provider: 'openai-compatible',
        modelId: 'deepseek-v4-0324',
        apiKeyEnv: 'LLM_API_KEY',
        scopeId: 'LLM_API_KEY:openai-compatible:default',
      },
      options: {
        prompt: [{ role: 'user', content: [{ type: 'text', text: toolSchema }] }],
        tools: [],
        maxOutputTokens: 1_000,
      },
    });

    const { estimated_units: estimate } = f.reserveMonthlyUser.mock.calls[0]![0] as { estimated_units: number };
    // Admission compares this against free headroom, so an inflated estimate
    // locks a user out well before the limit is actually spent.
    expect(estimate).toBeLessThan(20_000);
    // Still comfortably above the real cost of that payload.
    expect(estimate).toBeGreaterThan(11_000);
  });

  it('accounts image generation in atomic user, organization, and provider USD micros', async () => {
    const f = fixture();
    const lease = await reserveImageUsdBudget({
      db: f.db as never,
      userId: 'user-1',
      caller: 'generate-image',
      estimatedUsdMicros: 6_000,
      providerId: 'media',
      modelId: 'gpt-image-2',
      idempotencyKey: 'image:key',
    });
    lease.markProviderIoStarted();
    await settleAndRecordBudgetedImageUsage(f.db as never, lease, 6_000, {
      profile_id: 'image',
      caller: 'generate-image',
      user_id: 'user-1',
      model: 'gpt-image-2',
      input_tokens: 10,
      output_tokens: 200,
    });

    expect(f.ensureAccount).toHaveBeenCalledTimes(3);
    expect(f.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        account_ids: expect.arrayContaining([
          'user:user-1:usd_micros',
          'organization:default:image:usd_micros',
          'provider:media:usd_micros',
        ]),
        estimated_units: 6_000,
      }),
    );
    expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ actual_units: 6_000 }));
    expect(f.record).toHaveBeenCalledWith(expect.objectContaining({ budget_idempotency_key: 'image:key' }));
  });
});
