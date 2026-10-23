import { describe, expect, it, vi } from 'vitest';
import { fakeMeteringServices } from '../../../../tests/helpers/metering-db.js';
import { DEFAULT_MODEL_REGISTRY, setModelRegistry } from '@greenhouse/agent-core';
import {
  UsageBudgetAdmissionError,
  createProviderAttemptBudgetHook,
  estimateAgentLoopTokens,
  estimateCompletionTokens,
  reserveUserTokenBudget,
  settleAndRecordBudgetedUsage,
} from './usage-budget.js';

function fixture() {
  const reserveMonthlyUser = vi.fn().mockResolvedValue([]);
  const settle = vi.fn().mockResolvedValue([]);
  const release = vi.fn().mockResolvedValue([]);
  const { ensureAccount, reserve, metering, accounts } = fakeMeteringServices();
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
    metering,
    usage: { record },
    notifications: { createWithStatus: vi.fn(), countUnread: vi.fn(async () => 0) },
  };
  return { accounts, db, ensureAccount, metering, record, release, reserve, reserveMonthlyUser, settle };
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

  it('uses conservative declared upper bounds for loops and retries', () => {
    expect(estimateAgentLoopTokens({ system: '', messages: [], maxSteps: 2, maxOutputTokens: 100 })).toBeGreaterThan(
      16_000,
    );
    expect(estimateCompletionTokens({ system: '', messages: [], maxOutputTokens: 100, maxRetries: 2 })).toBe(303);
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

  it('reserves a priced model call in USD against member, service and organization, then settles the real cost', async () => {
    const f = fixture();
    setModelRegistry({
      flash: {
        name: 'Priced model',
        price: { input: 1, output: 4, cachedInput: 0.1 },
        providers: [{ provider: 'openai-compatible', model: 'priced-model', apiKeyEnv: 'LLM_API_KEY' }],
      },
    });
    try {
      const lease = await reserveUserTokenBudget({
        db: f.db as never,
        userId: 'user-1',
        caller: 'chat',
        estimatedTokens: 1_200,
        estimatedInputTokens: 1_000,
        estimatedOutputTokens: 200,
        modelId: 'priced-model',
        logicalModelId: 'flash',
        client: 'mcp',
        oauthClientId: 'lpoa_client_codex',
        idempotencyKey: 'usd:key',
      });
      // 1000 × $1/M + 200 × $4/M = 1800 micros, every input token uncached.
      expect(f.reserve).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotency_key: 'usd:key:usd',
          estimated_units: 1_800,
          account_ids: expect.arrayContaining([
            'user:user-1:usd_micros',
            'service:llm:usd_micros',
            'organization:default:usd_micros',
          ]),
        }),
      );
      lease.markProviderIoStarted();
      await settleAndRecordBudgetedUsage(f.db as never, lease, {
        profile_id: 'team',
        caller: 'chat',
        user_id: 'user-1',
        model: 'priced-model',
        input_tokens: 900,
        output_tokens: 100,
        cached_tokens: 800,
      });
      // 100 uncached × 1 + 800 cached × 0.1 + 100 out × 4 = 580 micros.
      expect(f.settle).toHaveBeenCalledWith(
        expect.objectContaining({ idempotency_key: 'usd:key:usd', actual_units: 580 }),
      );
      expect(f.record).toHaveBeenCalledWith(
        expect.objectContaining({
          budget_idempotency_key: 'usd:key',
          cost_usd_micros: 580,
          client: 'mcp',
          oauth_client_id: 'lpoa_client_codex',
          service: 'llm',
        }),
      );
    } finally {
      setModelRegistry(DEFAULT_MODEL_REGISTRY);
    }
  });

  it('records an unpriced model call with an unknown cost and reserves no USD', async () => {
    const f = fixture();
    const lease = await reserveUserTokenBudget({
      db: f.db as never,
      userId: 'user-1',
      caller: 'chat',
      estimatedTokens: 100,
      modelId: 'flash',
      idempotencyKey: 'free:key',
    });
    expect(f.reserve).not.toHaveBeenCalled();
    await settleAndRecordBudgetedUsage(f.db as never, lease, {
      profile_id: 'team',
      caller: 'chat',
      user_id: 'user-1',
      model: 'flash',
      input_tokens: 10,
      output_tokens: 5,
    });
    expect(f.record).toHaveBeenCalledWith(expect.objectContaining({ cost_usd_micros: null, service: 'llm' }));
  });

  it('refuses an unpriced call once a USD budget is exhausted, and gives the tokens back', async () => {
    const f = fixture();
    f.metering.getAccounts.mockImplementation(async (ids: readonly string[]) =>
      ids.map((id) => ({
        ...f.accounts.get(id)!,
        spent_units: id.startsWith('user:') ? f.accounts.get(id)!.limit_units : 0,
      })),
    );
    const refusal = await reserveUserTokenBudget({
      db: f.db as never,
      userId: 'user-1',
      caller: 'chat',
      estimatedTokens: 100,
      modelId: 'flash',
      idempotencyKey: 'blocked:key',
    }).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(UsageBudgetAdmissionError);
    expect(refusal).toMatchObject({
      status: 429,
      code: 'usage_budget_exceeded',
      refusal: { unit: 'usd_micros', level: 'member' },
    });
    expect((refusal as Error).message).toContain('本月个人额度已用完');
    expect((refusal as Error).message).toContain('member budget is used up');
    expect(f.release).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: 'blocked:key', reason: 'usd_budget_refused' }),
    );
  });
});
