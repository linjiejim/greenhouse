/**
 * "Needs you" request merging and decision-error reading (./requests.ts). Root vitest.
 */

import { describe, expect, it } from 'vitest';
import type { BotRequestView } from '../shared/bots';
import { classifyDecision, mergeRequests } from './requests';

const card = (id: string, status: BotRequestView['status'], title = id): BotRequestView => ({
  id,
  session_id: 's1',
  bot_id: 'bot_a',
  kind: 'approval',
  status,
  payload: { action: 'tool_call', title, details: [], allow_always: false },
  result: null,
  expires_at: null,
  created_at: '2026-10-08T00:00:00.000Z',
});

describe('mergeRequests', () => {
  it('applies REST, then the live stream, then this device’s decisions', () => {
    const merged = mergeRequests({
      rest: [card('a', 'pending', 'rest'), card('b', 'pending')],
      live: [card('a', 'pending', 'live'), card('c', 'pending')],
      overrides: { b: card('b', 'resolved') },
    });
    expect([...merged.keys()]).toEqual(['a', 'b', 'c']);
    expect((merged.get('a')?.payload as { title: string }).title).toBe('live');
    expect(merged.get('b')?.status).toBe('resolved');
  });

  it('never turns a settled card back into a pending one', () => {
    const merged = mergeRequests({
      rest: [card('a', 'denied')],
      live: [card('a', 'pending')],
      overrides: {},
    });
    expect(merged.get('a')?.status).toBe('denied');
    const stale = mergeRequests({ rest: [card('x', 'expired')], live: [], overrides: { x: card('x', 'pending') } });
    expect(stale.get('x')?.status).toBe('expired');
    // A settled state may still move to another settled state (the server's later word).
    const moved = mergeRequests({ rest: [card('y', 'resolved')], live: [card('y', 'canceled')], overrides: {} });
    expect(moved.get('y')?.status).toBe('canceled');
  });
});

describe('classifyDecision', () => {
  it('reads 409 already_decided / deciding / code-less as stale', () => {
    expect(classifyDecision(409, 'already_decided')).toBe('stale');
    expect(classifyDecision(409, 'deciding')).toBe('stale');
    expect(classifyDecision(409, null)).toBe('stale');
  });

  it('reads every other failure as refused (the card stays pending)', () => {
    for (const code of [
      'page_gone',
      'origin_mismatch',
      'no_fields',
      'failed',
      'invalid',
      'limit',
      'computer_restarted',
      'bot_gone',
    ]) {
      expect(classifyDecision(409, code)).toBe('refused');
    }
    expect(classifyDecision(400, null)).toBe('refused');
    expect(classifyDecision(404, null)).toBe('refused');
    expect(classifyDecision(503, null)).toBe('refused');
    expect(classifyDecision(0, null)).toBe('refused');
  });
});
