import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const events: string[] = [];
  const rows = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    user_id: 'user-1',
    category: 'fact',
    title: `Memory ${index + 1}`,
    content: `Remembered fact ${index + 1}`,
    pinned: false,
    status: 'active',
    source: 'agent',
    last_used_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    superseded_by: null,
  }));
  const reserveMonthlyUser = vi.fn(async (_input: Record<string, unknown>) => {
    events.push('reserve');
  });
  const settle = vi.fn(async (_input: Record<string, unknown>) => {
    events.push('settle');
  });
  const release = vi.fn(async (_input: Record<string, unknown>) => {
    events.push('release');
  });
  const record = vi.fn(async (_input: Record<string, unknown>) => {
    events.push('record');
  });
  const db = {
    users: {
      getById: vi.fn(async () => ({
        id: 'user-1',
        role: 'team',
        status: 'active',
        monthly_token_limit: 1_000_000,
      })),
    },
    userMemories: {
      demoteStale: vi.fn(async () => 0),
      listUsersForConsolidation: vi.fn(async () => [{ user_id: 'user-1' }]),
      listForIndex: vi.fn(async () => rows),
      create: vi.fn(),
      setStatus: vi.fn(),
    },
    usageBudget: { reserveMonthlyUser, settle, release },
    usage: { record },
  };
  return {
    db,
    events,
    record,
    release,
    reserveMonthlyUser,
    settle,
    providerAttemptHook: undefined as undefined | ((input: any) => Promise<any>),
  };
});

vi.mock('@greenhouse/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@greenhouse/db')>();
  return { ...actual, getDb: () => mocks.db };
});

vi.mock('@greenhouse/agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@greenhouse/agent-core')>();
  return {
    ...actual,
    resolveModelConfig: (model: unknown) => model,
    createModelFromConfig: vi.fn(
      async (_config: unknown, options?: { onProviderAttempt?: (input: any) => Promise<any> }) => {
        mocks.events.push('prepare');
        mocks.providerAttemptHook = options?.onProviderAttempt;
        return {};
      },
    ),
    buildProviderOptions: vi.fn(() => undefined),
  };
});

vi.mock('../../auth/features.js', () => ({ userHasFeature: vi.fn(async () => true) }));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(async () => {
      const lease = await mocks.providerAttemptHook!({
        descriptor: {
          provider: 'deepseek',
          modelId: 'deepseek-v4-flash',
          apiKeyEnv: 'LLM_API_KEY',
          logicalModelId: 'flash',
          scopeId: 'LLM_API_KEY:deepseek:default',
        },
        options: {
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'memories' }] }],
          maxOutputTokens: 1500,
        },
      });
      lease.markProviderIoStarted();
      mocks.events.push('provider');
      await lease.settle({ inputTokens: 120, outputTokens: 4 });
      return { text: '[]', usage: { inputTokens: 120, outputTokens: 4 } };
    }),
  };
});

import { runMemoryConsolidation } from '../memory.js';

describe('memory consolidation usage budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
  });

  it('reserves before provider I/O and settles the permanent usage linkage', async () => {
    await expect(runMemoryConsolidation()).resolves.toEqual({ demoted: 0, usersProcessed: 1, opsApplied: 0 });

    expect(mocks.events).toEqual(['prepare', 'reserve', 'provider', 'settle', 'record']);
    const reservation = mocks.reserveMonthlyUser.mock.calls[0]![0] as { idempotency_key: string };
    expect(reservation).toMatchObject({ user_id: 'user-1', caller: 'memory-consolidation' });
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: reservation.idempotency_key, actual_units: 124 }),
    );
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        caller: 'memory-consolidation',
        budget_idempotency_key: reservation.idempotency_key,
      }),
    );
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
