/**
 * The implicit take-over card (tools/takeover.ts implicitTakeoverFor): raised
 * once per conversation and Bot however many tool calls the take-over
 * stopped, expiring with the computer hold, withdrawn when the member already
 * handed back, and never for a background turn.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BotRequestRow, DatabaseProvider } from '@greenhouse/db';
import { HUMAN_WAIT_HOLD_MS } from '../../computer/limits.js';
import { implicitTakeoverFor } from '../takeover.js';
import { testTurn } from '../../__tests__/helpers/turn.js';

function withRequests(pending: Array<Partial<BotRequestRow>> = []) {
  const settleRequest = vi.fn(async (_userId: string, id: string) => ({ id }) as BotRequestRow);
  const listRequests = vi.fn(async () => pending as BotRequestRow[]);
  const ctx = testTurn({ db: { bots: { listRequests, settleRequest } } as unknown as DatabaseProvider });
  return { ctx, listRequests, settleRequest };
}

const memberHolds = { currentLease: async () => ({ controller: 'user' as const, epoch: 3 }) };

describe('implicit take-over card', () => {
  it('is never raised for a background turn', () => {
    expect(implicitTakeoverFor(testTurn({ background: true }), memberHolds)).toBeUndefined();
  });

  it('raises one card for parallel calls the take-over stopped, expiring with the hold, and ends the turn', async () => {
    const { ctx, listRequests } = withRequests();
    const raise = implicitTakeoverFor(ctx, memberHolds)!;
    const outcomes = await Promise.all([
      raise({ reason: 'interrupted', host: 'github.com', title: 'Pull requests' }),
      raise({ reason: 'interrupted' }),
    ]);
    expect(outcomes).toEqual(['card', 'card']);
    expect(ctx.createRequest).toHaveBeenCalledTimes(1);
    expect(ctx.createRequest).toHaveBeenCalledWith(
      'takeover',
      { implicit: true, reason: 'interrupted', host: 'github.com', title: 'Pull requests' },
      { expiresInMs: HUMAN_WAIT_HOLD_MS },
    );
    expect(listRequests).toHaveBeenCalledWith('u1', { sessionId: 'sess_1', status: 'pending', kinds: ['takeover'] });
    expect(ctx.stopAfterStep).toHaveBeenCalledWith('takeover');
  });

  it("reuses this Bot's pending take-over card in the conversation, not another Bot's", async () => {
    const mine = withRequests([{ id: 'brq_asked', bot_id: 'bot_test', kind: 'takeover' }]);
    expect(await implicitTakeoverFor(mine.ctx, memberHolds)!({ reason: 'waiting' })).toBe('card');
    expect(mine.ctx.createRequest).not.toHaveBeenCalled();
    expect(mine.ctx.stopAfterStep).toHaveBeenCalledWith('takeover');

    const theirs = withRequests([{ id: 'brq_other', bot_id: 'bot_other', kind: 'takeover' }]);
    await implicitTakeoverFor(theirs.ctx, memberHolds)!({ reason: 'waiting' });
    expect(theirs.ctx.createRequest).toHaveBeenCalledWith(
      'takeover',
      { implicit: true, reason: 'waiting' },
      { expiresInMs: HUMAN_WAIT_HOLD_MS },
    );
  });

  it('withdraws its card when the member handed back before it existed (nothing would ever settle it)', async () => {
    const { ctx, settleRequest } = withRequests();
    const outcome = await implicitTakeoverFor(ctx, {
      currentLease: async () => ({ controller: 'bot', epoch: 4 }),
    })!({ reason: 'interrupted' });
    expect(outcome).toBe('handed_back');
    expect(settleRequest).toHaveBeenCalledWith('u1', 'brq_1', 'canceled', { by: 'system', reason: 'handed_back' });
    expect(ctx.stopAfterStep).not.toHaveBeenCalled();

    // A hand-back that settled the new card first already woke the Bot: keep the promise.
    const raced = withRequests();
    raced.settleRequest.mockResolvedValueOnce(undefined as never);
    expect(
      await implicitTakeoverFor(raced.ctx, { currentLease: async () => ({ controller: 'bot', epoch: 4 }) })!({
        reason: 'interrupted',
      }),
    ).toBe('card');
  });
});
