/**
 * The new-chat bridge row (./bridge-item.ts, spec §2.5.2): needs you > a report
 * that landed elsewhere > unread > carry on with Sprouty. Root vitest.
 */

import { describe, expect, it } from 'vitest';
import type { BotConversationSummary, BotRequestView, BotView } from '../../shared/bots';
import { initialBotsData, type BotsData } from '../store-core';
import { bridgeItem } from './bridge-item';

const NOW = Date.parse('2026-10-08T10:00:00.000Z');

function bot(id: string, partial: Partial<BotView> = {}): BotView {
  return {
    id,
    name: id,
    role: '',
    description: '',
    instructions: '',
    avatar: {},
    model_id: null,
    tools: null,
    max_steps: null,
    template_key: null,
    status: 'active',
    dm_session_id: null,
    current_version: 1,
    user_id: 'u1',
    last_active_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...partial,
  };
}

const SPROUTY = bot('b_sprouty', { name: 'Sprouty', template_key: 'sprouty', dm_session_id: 's_sprouty' });
const DANDY = bot('b_dandy', { name: 'Dandy' });

function dm(botId: string, partial: Partial<BotConversationSummary> = {}): BotConversationSummary {
  return {
    session_id: `s_${botId}`,
    kind: 'direct',
    title: null,
    owner_bot_id: botId,
    lead_bot_id: botId,
    members: [{ bot_id: botId, role: 'owner', position: 0 }],
    last_message: null,
    attention: 'idle',
    pending_requests: 0,
    last_activity_at: '2026-10-08T09:00:00.000Z',
    ...partial,
  };
}

function card(id: string, sessionId: string, partial: Partial<BotRequestView> = {}): BotRequestView {
  return {
    id,
    session_id: sessionId,
    bot_id: 'b_dandy',
    kind: 'approval',
    status: 'pending',
    payload: {} as BotRequestView['payload'],
    result: null,
    expires_at: null,
    created_at: '2026-10-08T09:59:00.000Z',
    ...partial,
  };
}

function state(partial: Partial<BotsData> = {}): BotsData {
  return { ...initialBotsData(), bots: [SPROUTY, DANDY], botsLoaded: true, ...partial };
}

describe('bridgeItem', () => {
  it('is null until the Bot list is in', () => {
    expect(bridgeItem(state({ botsLoaded: false }), NOW)).toBeNull();
  });

  it('defaults to carrying on with Sprouty', () => {
    expect(bridgeItem(state(), NOW)).toEqual({ kind: 'sprouty', bot: SPROUTY, sessionId: 's_sprouty' });
  });

  it('offers Sprouty without a DM yet (the tap bootstraps it)', () => {
    const sprouty = { ...SPROUTY, dm_session_id: null };
    expect(bridgeItem(state({ bots: [sprouty] }), NOW)).toEqual({ kind: 'sprouty', bot: sprouty, sessionId: null });
  });

  it('points at the first unread conversation over Sprouty', () => {
    const row = dm('b_dandy', { attention: 'unread' });
    expect(bridgeItem(state({ conversations: [dm('b_sprouty'), row] }), NOW)).toEqual({ kind: 'unread', row });
  });

  it('puts a report that landed elsewhere over unread', () => {
    const arrival = { botId: 'b_dandy', title: 'Notes', status: 'succeeded' as const, at: NOW - 1000 };
    const item = bridgeItem(
      state({ conversations: [dm('b_sprouty', { attention: 'unread' })], arrivals: { s_b_dandy: arrival } }),
      NOW,
    );
    expect(item).toEqual({ kind: 'report', sessionId: 's_b_dandy', arrival });
  });

  it('puts a waiting card over everything, with the card and the count', () => {
    const arrival = { botId: 'b_dandy', title: 'Notes', status: null, at: NOW };
    const item = bridgeItem(
      state({
        pendingRequests: [card('brq_1', 's_b_dandy'), card('brq_2', 's_b_dandy')],
        arrivals: { s_b_dandy: arrival },
      }),
      NOW,
    );
    expect(item).toEqual({ kind: 'needs_you', sessionId: 's_b_dandy', botId: 'b_dandy', requestId: 'brq_1', count: 2 });
  });

  it('falls back to the rows while the pending list is unread', () => {
    const item = bridgeItem(
      state({ conversations: [dm('b_sprouty'), dm('b_dandy', { pending_requests: 2, attention: 'needs_you' })] }),
      NOW,
    );
    expect(item).toEqual({ kind: 'needs_you', sessionId: 's_b_dandy', botId: 'b_dandy', requestId: null, count: 2 });
  });

  it('ignores cards decided on this device and cards past their expiry', () => {
    const decided = card('brq_1', 's_b_dandy');
    const expired = card('brq_2', 's_b_dandy', { expires_at: '2026-10-08T09:00:00.000Z' });
    const item = bridgeItem(
      state({
        pendingRequests: [decided, expired],
        requestOverrides: { brq_1: { ...decided, status: 'resolved' } },
      }),
      NOW,
    );
    expect(item).toEqual({ kind: 'sprouty', bot: SPROUTY, sessionId: 's_sprouty' });
  });
});
