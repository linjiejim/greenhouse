/**
 * New-group picking (./group-model.ts — the pure half of ./use-group-form.ts;
 * spec docs/specs/20261008-mobile-bots.md §8 E): the first pick leads, 2–6
 * Bots, tap order kept, the main Bot listed first.
 */

import { describe, expect, it } from 'vitest';
import type { BotView } from '../../shared/bots';
import {
  GROUP_MIN_BOTS,
  MAX_BOTS_PER_CONVERSATION,
  groupCanCreate,
  groupCandidates,
  pickNumber,
  pickedLead,
  togglePick,
} from './group-model';

const bot = (id: string, template_key: string | null = null) => ({ id, template_key }) as BotView;

describe('togglePick', () => {
  it('keeps tap order and makes the first pick the lead', () => {
    let selected: string[] = [];
    for (const id of ['c', 'a', 'b']) selected = togglePick(selected, id);
    expect(selected).toEqual(['c', 'a', 'b']);
    expect(pickedLead(selected)).toBe('c');
    expect(pickNumber(selected, 'a')).toBe(2);
    expect(pickNumber(selected, 'z')).toBeNull();
  });

  it('a second tap drops the pick; dropping the lead hands the lead to the next pick', () => {
    const selected = togglePick(['c', 'a', 'b'], 'c');
    expect(selected).toEqual(['a', 'b']);
    expect(pickedLead(selected)).toBe('a');
    expect(pickedLead([])).toBeNull();
  });

  it('ignores a pick past six', () => {
    const six = ['1', '2', '3', '4', '5', '6'];
    expect(togglePick(six, '7')).toEqual(six);
    expect(togglePick(six, '3')).toEqual(['1', '2', '4', '5', '6']);
  });
});

describe('groupCanCreate', () => {
  it('needs two to six Bots', () => {
    expect(GROUP_MIN_BOTS).toBe(2);
    expect(MAX_BOTS_PER_CONVERSATION).toBe(6);
    expect(groupCanCreate([])).toBe(false);
    expect(groupCanCreate(['a'])).toBe(false);
    expect(groupCanCreate(['a', 'b'])).toBe(true);
    expect(groupCanCreate(['1', '2', '3', '4', '5', '6'])).toBe(true);
    expect(groupCanCreate(['1', '2', '3', '4', '5', '6', '7'])).toBe(false);
  });
});

describe('groupCandidates', () => {
  it('lists the main Bot first, the rest in directory order', () => {
    const list = groupCandidates([bot('fern'), bot('sprouty', 'sprouty'), bot('clover')]);
    expect(list.map((b) => b.id)).toEqual(['sprouty', 'fern', 'clover']);
  });
});
