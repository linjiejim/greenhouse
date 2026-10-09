/**
 * Floor controller traces (design review R13): depth-first hand-offs, the
 * owner's single reserved follow-up, ask refusals and budgets.
 */

import { describe, expect, it } from 'vitest';
import { CHAIN_LIMITS, FloorController, type FloorItem } from '../floor.js';

function floor(members: string[], opts: { turnBudget?: number } = {}) {
  return new FloorController({
    members: new Set(members),
    ...(opts.turnBudget !== undefined ? { turnBudget: opts.turnBudget } : {}),
  });
}

/** Take the next turn and assert who speaks and why. */
function take(f: FloorController, botId: string, reason: FloorItem['reason']): FloorItem {
  const item = f.next();
  expect(item).not.toBeNull();
  expect(item).not.toBe('turns');
  const turn = item as FloorItem;
  expect([turn.botId, turn.reason]).toEqual([botId, reason]);
  return turn;
}

function ask(f: FloorController, to: string): void {
  expect(f.checkAsk(to)).toBeNull();
  f.acceptAsk(to, `please ${to}`);
}

describe('FloorController', () => {
  it('A asks B and C in one turn → B, C, then A follows up once', () => {
    const f = floor(['A', 'B', 'C']);
    f.start([{ botId: 'A', reason: 'user' }]);
    take(f, 'A', 'user');
    ask(f, 'B');
    ask(f, 'C');
    f.endTurn();
    const b = take(f, 'B', 'ask');
    expect(b.askedBy).toBe('A');
    expect(b.message).toBe('please B');
    f.endTurn();
    take(f, 'C', 'ask');
    f.endTurn();
    const followup = take(f, 'A', 'followup');
    expect(followup.askedBots).toEqual(['B', 'C']);
    f.endTurn();
    expect(f.next()).toBeNull();
  });

  it('A→B→C: C answers before A follows up, and B (not an owner) gets no follow-up', () => {
    const f = floor(['A', 'B', 'C']);
    f.start([{ botId: 'A', reason: 'user' }]);
    take(f, 'A', 'user');
    ask(f, 'B');
    f.endTurn();
    take(f, 'B', 'ask');
    ask(f, 'C');
    f.endTurn();
    const c = take(f, 'C', 'ask');
    expect(c.askerChain).toEqual(['A', 'B']);
    expect(c.depth).toBe(2);
    f.endTurn();
    take(f, 'A', 'followup');
    f.endTurn();
    expect(f.next()).toBeNull();
  });

  it('refuses ping-pong (the asker is up the chain) and repeats within a chain', () => {
    const f = floor(['A', 'B', 'C']);
    f.start([{ botId: 'A', reason: 'user' }]);
    take(f, 'A', 'user');
    ask(f, 'B');
    f.endTurn();
    take(f, 'B', 'ask');
    expect(f.checkAsk('A')).toBe('cycle');
    expect(f.checkAsk('B')).toBe('self');
    ask(f, 'C');
    expect(f.checkAsk('C')).toBe('repeat');
  });

  it('refuses asks beyond depth 2 or outside the conversation', () => {
    const f = floor(['A', 'B', 'C', 'D']);
    f.start([{ botId: 'A', reason: 'user' }]);
    take(f, 'A', 'user');
    ask(f, 'B');
    f.endTurn();
    take(f, 'B', 'ask');
    ask(f, 'C');
    f.endTurn();
    take(f, 'C', 'ask');
    expect(f.checkAsk('D')).toBe('depth');
    expect(f.checkAsk('Z')).toBe('not_member');
  });

  it('caps asks per chain at 4', () => {
    const f = floor(['A', 'B', 'C', 'D', 'E', 'F']);
    f.start([{ botId: 'A', reason: 'user' }]);
    take(f, 'A', 'user');
    for (const to of ['B', 'C', 'D', 'E']) ask(f, to);
    expect(f.asksUsed).toBe(CHAIN_LIMITS.asks);
    expect(f.checkAsk('F')).toBe('asks');
  });

  it('never accepts an ask the turn budget could not answer AND follow up', () => {
    // Budget 3: A (1) + B (2) + A follow-up (3) fits; a second ask would not.
    const f = floor(['A', 'B', 'C'], { turnBudget: 3 });
    f.start([{ botId: 'A', reason: 'user' }]);
    take(f, 'A', 'user');
    ask(f, 'B');
    expect(f.checkAsk('C')).toBe('turns');
    f.endTurn();
    take(f, 'B', 'ask');
    f.endTurn();
    take(f, 'A', 'followup');
  });

  it('after a budget hit only the reserved follow-up still runs', () => {
    const f = floor(['A', 'B', 'C']);
    f.start([{ botId: 'A', reason: 'user' }]);
    take(f, 'A', 'user');
    ask(f, 'B');
    ask(f, 'C');
    f.endTurn();
    take(f, 'B', 'ask');
    f.endTurn();
    f.hitLimit(); // e.g. tokens ran out during B's turn
    take(f, 'A', 'followup');
    // The follow-up wraps up: a fresh hand-off is refused (C is a member that
    // was never asked in this chain, so only the limit can refuse it).
    const fresh = floor(['A', 'B', 'C']);
    fresh.start([{ botId: 'A', reason: 'user' }]);
    take(fresh, 'A', 'user');
    ask(fresh, 'B');
    fresh.endTurn();
    take(fresh, 'B', 'ask');
    fresh.endTurn();
    fresh.hitLimit();
    take(fresh, 'A', 'followup');
    expect(fresh.checkAsk('C')).toBe('budget');
    // Even a forced accept never yields a new turn once the chain is limited.
    fresh.acceptAsk('C', 'force');
    fresh.endTurn();
    expect(fresh.next()).toBeNull();
    f.endTurn();
    expect(f.next()).toBeNull();
  });

  it('a turn-budget exhaustion also stops new hand-offs from the follow-up', () => {
    const f = floor(['A', 'B', 'C'], { turnBudget: 2 });
    f.start([
      { botId: 'A', reason: 'mention' },
      { botId: 'B', reason: 'mention' },
      { botId: 'C', reason: 'mention' },
    ]);
    take(f, 'A', 'mention');
    f.endTurn();
    take(f, 'B', 'mention');
    f.endTurn();
    expect(f.next()).toBe('turns');
    expect(f.isLimited).toBe(true);
  });

  it('refuses handing work to a Bot the member also addressed that has not spoken yet', () => {
    const f = floor(['A', 'D']);
    f.start([
      { botId: 'A', reason: 'mention' },
      { botId: 'D', reason: 'mention' },
    ]);
    take(f, 'A', 'mention');
    expect(f.checkAsk('D')).toBe('queued');
    f.endTurn();
    // No hand-off happened: D answers the member once, A gets no follow-up.
    take(f, 'D', 'mention');
    f.endTurn();
    expect(f.next()).toBeNull();
  });

  it('still accepts asking an addressee that has already spoken', () => {
    const f = floor(['A', 'D']);
    f.start([
      { botId: 'D', reason: 'mention' },
      { botId: 'A', reason: 'mention' },
    ]);
    take(f, 'D', 'mention');
    f.endTurn();
    take(f, 'A', 'mention');
    expect(f.checkAsk('D')).toBeNull();
  });

  it('hand-offs need no switch; a Bot joining mid-chain is a valid target at once', () => {
    const members = new Set(['A']);
    const f = new FloorController({ members });
    f.start([{ botId: 'A', reason: 'user' }]);
    take(f, 'A', 'user');
    expect(f.checkAsk('B')).toBe('not_member');
    members.add('B'); // team.add — the run refreshes the live set in place
    expect(f.checkAsk('B')).toBeNull();
  });

  it('an exhausted turn budget reports `turns` and keeps only follow-ups', () => {
    const f = floor(['A', 'B'], { turnBudget: 1 });
    f.start([
      { botId: 'A', reason: 'mention' },
      { botId: 'B', reason: 'mention' },
    ]);
    take(f, 'A', 'mention');
    f.endTurn();
    expect(f.next()).toBe('turns');
    expect(f.next()).toBeNull();
  });

  it('mentions keep their order; a guest only speaks when addressed or asked', () => {
    const f = floor(['owner', 'guest']);
    f.start([
      { botId: 'guest', reason: 'mention' },
      { botId: 'owner', reason: 'mention' },
      { botId: 'guest', reason: 'mention' },
      { botId: 'stranger', reason: 'mention' },
    ]);
    take(f, 'guest', 'mention');
    f.endTurn();
    take(f, 'owner', 'mention');
    f.endTurn();
    expect(f.next()).toBeNull();
  });

  it('clear() drops everything queued, follow-ups included (stop / interjection)', () => {
    const f = floor(['A', 'B']);
    f.start([{ botId: 'A', reason: 'user' }]);
    take(f, 'A', 'user');
    ask(f, 'B');
    f.endTurn();
    expect(f.pending).toHaveLength(2);
    expect(f.clear()).toEqual([]);
    expect(f.next()).toBeNull();
  });

  it('clear() hands back the continue wake-ups that never ran', () => {
    const f = floor(['A', 'B']);
    f.start([{ botId: 'A', reason: 'user' }]);
    f.addContinue('B', 'handed back');
    expect(f.clear()).toEqual([{ botId: 'B', note: 'handed back' }]);
  });

  it('continues join the end of the queue', () => {
    const f = floor(['A', 'B']);
    f.start([{ botId: 'A', reason: 'user' }]);
    f.addContinue('B', 'handed back');
    take(f, 'A', 'user');
    f.endTurn();
    const next = take(f, 'B', 'continue');
    expect(next.message).toBe('handed back');
  });
});
