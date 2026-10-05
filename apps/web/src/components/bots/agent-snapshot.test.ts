import { describe, expect, it } from 'vitest';
import { legacyToPlant } from '@greenhouse/types';
import { botDraftFromAgent } from './agent-snapshot';

describe('botDraftFromAgent', () => {
  it('snapshots name, a short role, instructions and the look', () => {
    expect(
      botDraftFromAgent({
        id: 'custom:12',
        name: 'Support Triage',
        description: 'Sorts incoming tickets by urgency. Drafts first replies.',
        system_prompt: 'You triage support tickets.',
        avatar: { plant: 'echeveria', faceStyle: 'happy', accessories: ['headset'] },
      }),
    ).toEqual({
      name: 'Support Triage',
      role: 'Sorts incoming tickets by urgency',
      instructions: 'You triage support tickets.',
      // Plant + nearest legacy colour + mood as faceStyle; retired accessories are not carried over.
      avatar: { plant: 'echeveria', color: 'ocean', faceStyle: 'happy' },
      model_id: null,
    });
  });

  it("pins a legacy Agent's plant as resolved under the Agent's own id, not the Bot's", () => {
    // forest + no role cue resolves by a hash of the stable id; a Bot re-resolving the
    // copied legacy keys under its own id could land on another forest plant.
    const avatar = { color: 'forest', leafStyle: 'normal' as const };
    const draft = botDraftFromAgent({ id: 'custom:41', name: 'Ops', avatar });
    expect(draft.avatar.plant).toBe(legacyToPlant(avatar, null, 'custom:41'));
    expect(draft.avatar.color).toBe('forest');
    expect(draft.avatar).not.toHaveProperty('leafStyle');
  });

  it('carries the resting mood from any legacy key', () => {
    expect(botDraftFromAgent({ id: 'custom:1', name: 'A', avatar: { eyeStyle: 'focused' } }).avatar.faceStyle).toBe(
      'sleepy',
    );
    expect(botDraftFromAgent({ id: 'custom:1', name: 'A', avatar: { mood: 'bright' } }).avatar.faceStyle).toBe(
      'sparkle',
    );
    expect(botDraftFromAgent({ id: 'custom:1', name: 'A' }).avatar.faceStyle).toBe('default');
  });

  it('cleans characters a Bot name may not hold and clips to the limits', () => {
    const draft = botDraftFromAgent({
      id: 'custom:7',
      name: '[Ops]: night\nshift helper with a very long name',
      description: null,
    });
    expect(draft.name).toBe('Ops night shift helper w');
    expect([...draft.name].length).toBeLessThanOrEqual(24);
    expect(draft.role).toBe('');
    // An Agent with no avatar still renders as a plant (never the reserved sprout); the Bot keeps it.
    expect(draft.avatar.plant).toBe(legacyToPlant({}, null, 'custom:7'));
    expect(draft.avatar.plant).not.toBe('sprout');
  });

  it('prefers the stated purpose over the description', () => {
    expect(
      botDraftFromAgent({ id: 'custom:2', name: 'A', purpose: '研究竞品。并整理表格', description: 'other' }).role,
    ).toBe('研究竞品');
  });
});
