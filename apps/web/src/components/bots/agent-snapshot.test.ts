import { describe, expect, it } from 'vitest';
import { botDraftFromAgent } from './agent-snapshot';

describe('botDraftFromAgent', () => {
  it('snapshots name, a short role, instructions and the look', () => {
    expect(
      botDraftFromAgent({
        name: 'Support Triage',
        description: 'Sorts incoming tickets by urgency. Drafts first replies.',
        system_prompt: 'You triage support tickets.',
        avatar: { color: 'ocean', accessories: ['headset', 'coffee', 'crown'], leafStyle: 'big' },
      }),
    ).toEqual({
      name: 'Support Triage',
      role: 'Sorts incoming tickets by urgency',
      instructions: 'You triage support tickets.',
      avatar: { color: 'ocean', accessories: ['headset', 'coffee'], leafStyle: 'big' },
      model_id: null,
    });
  });

  it('cleans characters a Bot name may not hold and clips to the limits', () => {
    const draft = botDraftFromAgent({ name: '[Ops]: night\nshift helper with a very long name', description: null });
    expect(draft.name).toBe('Ops night shift helper w');
    expect([...draft.name].length).toBeLessThanOrEqual(24);
    expect(draft.role).toBe('');
    expect(draft.avatar).toEqual({});
  });

  it('prefers the stated purpose over the description', () => {
    expect(botDraftFromAgent({ name: 'A', purpose: '研究竞品。并整理表格', description: 'other' }).role).toBe(
      '研究竞品',
    );
  });
});
