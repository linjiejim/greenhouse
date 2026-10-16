import { describe, expect, it } from 'vitest';
import type { NeedsYou } from '../shared/contract';
import { cardToAnswer, heldFor, isComputerCard } from './model';

function card(id: string, partial: Partial<NeedsYou> = {}): NeedsYou {
  return {
    id,
    kind: 'takeover',
    subject: 'computer_takeover',
    status: 'pending',
    conversation_id: 'c1',
    run_id: null,
    agent_id: 'sage',
    title: id,
    payload: { reason: 'A captcha' },
    result: null,
    expires_at: null,
    decided_at: null,
    created_at: '2026-10-14T06:00:00.000Z',
    ...partial,
  };
}

describe('the computer page', () => {
  it('says how long the member has held the computer', () => {
    expect(heldFor(null, 5000)).toBe('00:00');
    expect(heldFor(0, 65_000)).toBe('01:05');
    expect(heldFor(0, 3_725_000)).toBe('1:02:05');
    expect(heldFor(10_000, 5000)).toBe('00:00');
  });

  it('hands back the card it was opened for, else this Agent’s oldest computer card', () => {
    const pending = [
      card('late', { created_at: '2026-10-14T07:00:00.000Z' }),
      card('early', { kind: 'login', subject: 'vault_fill' }),
      card('other-agent', { agent_id: 'ivy', created_at: '2026-10-14T05:00:00.000Z' }),
      card('approval', { kind: 'approval', subject: 'tool_write', created_at: '2026-10-14T04:00:00.000Z' }),
    ];
    expect(cardToAnswer(pending, { requestId: 'late', agentId: 'sage' })?.id).toBe('late');
    expect(cardToAnswer(pending, { agentId: 'sage' })?.id).toBe('early');
    expect(cardToAnswer(pending, { agentId: 'basil' })).toBeNull();
    // the card asked for was decided meanwhile: nothing to hand back on its behalf
    expect(cardToAnswer([card('done', { status: 'handed_back' })], { requestId: 'done', agentId: 'sage' })).toBeNull();
    expect(cardToAnswer(pending, { requestId: 'other-agent', agentId: 'sage' })).toBeNull();
    expect(cardToAnswer(pending, { requestId: 'approval', agentId: 'sage' })).toBeNull();
    expect(isComputerCard({ kind: 'question' })).toBe(false);
  });
});
