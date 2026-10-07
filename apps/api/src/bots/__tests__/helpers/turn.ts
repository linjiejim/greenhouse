/**
 * A BotTurnContext for tool tests: spies for every engine callback and an
 * injectable database.
 */

import { vi } from 'vitest';
import type { BotRow, BotRequestRow, DatabaseProvider } from '@greenhouse/db';
import type { BotTurnContext } from '../../engine/context.js';

export function testBot(id = 'bot_test', name = 'Sage'): BotRow {
  const now = new Date().toISOString();
  return {
    id,
    user_id: 'u1',
    name,
    name_key: name.toLowerCase(),
    role: 'Researcher',
    instructions: '',
    avatar: '{}',
    model_id: null,
    template_key: 'researcher',
    status: 'active',
    description: '',
    tools: null,
    max_steps: null,
    is_shared: false,
    lifecycle_status: 'draft',
    lifecycle_note: null,
    current_version: 1,
    published_version: null,
    owner_backup_user_id: null,
    reviewed_by: null,
    reviewed_at: null,
    next_review_at: null,
    forked_from: null,
    legacy_custom_id: null,
    last_active_at: null,
    created_at: now,
    updated_at: now,
  };
}

export function testTurn(overrides: Partial<BotTurnContext> = {}): BotTurnContext & {
  createRequest: ReturnType<typeof vi.fn>;
  stopAfterStep: ReturnType<typeof vi.fn>;
} {
  let requestSeq = 0;
  const createRequest = vi.fn(async (kind: string, payload: unknown) => {
    const now = new Date().toISOString();
    return {
      id: `brq_${++requestSeq}`,
      user_id: 'u1',
      session_id: 'sess_1',
      bot_id: 'bot_test',
      kind,
      status: 'pending',
      payload: JSON.stringify(payload),
      result: null,
      expires_at: null,
      created_at: now,
      updated_at: now,
    } as BotRequestRow;
  });
  const stopAfterStep = vi.fn();
  let tainted = false;
  const ctx = {
    db: { bots: { listRequests: vi.fn(async () => []) } } as unknown as DatabaseProvider,
    userId: 'u1',
    userRole: 'team' as const,
    locale: 'en' as const,
    sessionId: 'sess_1',
    bot: testBot(),
    reason: 'user' as const,
    userTriggered: true,
    background: false,
    turnId: 'run_1:0',
    signal: new AbortController().signal,
    emit: vi.fn(),
    createRequest,
    requestApproval: vi.fn(async () => 'approve' as const),
    markTainted: () => {
      tainted = true;
    },
    isTainted: () => tainted,
    stopAfterStep,
    handoffs: [],
    ...overrides,
  };
  return ctx as typeof ctx & { createRequest: typeof createRequest; stopAfterStep: typeof stopAfterStep };
}
