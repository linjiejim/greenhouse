/**
 * `self.propose_instructions`: raises an instructions_update card with the
 * full proposal, the reason and the text it was made against; refuses empty,
 * oversized or unchanged proposals; never writes anything itself.
 */

import { describe, expect, it } from 'vitest';
import type { BotInstructionsUpdatePayload } from '@greenhouse/types/bots';
import { BOT_INSTRUCTIONS_MAX } from '@greenhouse/types/bots';
import { testTurn } from '../../__tests__/helpers/turn.js';
import { createSelfTool, INSTRUCTIONS_PROPOSAL_TTL_MS } from '../self.js';

type Execute = (input: unknown, options: unknown) => Promise<Record<string, unknown>>;

describe('self tool', () => {
  it('proposes new instructions as a card the member decides', async () => {
    const ctx = testTurn();
    ctx.bot.instructions = 'Write clearly.';
    const self = createSelfTool(ctx) as unknown as { execute: Execute };
    const result = await self.execute(
      {
        action: 'propose_instructions',
        instructions: 'Write clearly. Cite sources.',
        reason: 'The member asked for sources twice.',
      },
      {},
    );
    expect(result.status).toBe('proposed');
    expect(ctx.createRequest).toHaveBeenCalledTimes(1);
    const [kind, payload, opts] = ctx.createRequest.mock.calls[0] as [
      string,
      BotInstructionsUpdatePayload,
      { expiresInMs: number },
    ];
    expect(kind).toBe('instructions_update');
    expect(payload).toEqual({
      instructions: 'Write clearly. Cite sources.',
      reason: 'The member asked for sources twice.',
      current: 'Write clearly.',
    });
    expect(opts.expiresInMs).toBe(INSTRUCTIONS_PROPOSAL_TTL_MS);
  });

  it('refuses an unchanged, empty-reason or oversized proposal without raising a card', async () => {
    const ctx = testTurn();
    ctx.bot.instructions = 'Write clearly.';
    const self = createSelfTool(ctx) as unknown as { execute: Execute };
    expect(
      (await self.execute({ action: 'propose_instructions', instructions: 'Write clearly.', reason: 'same' }, {}))
        .status,
    ).toBe('refused');
    expect(
      (await self.execute({ action: 'propose_instructions', instructions: 'New rules.', reason: '   ' }, {})).status,
    ).toBe('refused');
    expect(
      (
        await self.execute(
          { action: 'propose_instructions', instructions: 'x'.repeat(BOT_INSTRUCTIONS_MAX + 1), reason: 'too long' },
          {},
        )
      ).status,
    ).toBe('refused');
    expect(ctx.createRequest).not.toHaveBeenCalled();
  });
});
