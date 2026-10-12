/**
 * Which computer (./target.ts) — one per Agent, spec 20261011-agent-first-class P3a: the main
 * Agent's needs no `?bot=`, a push only moves the view it is about, and the thread's 🖥 tint.
 */

import { describe, expect, it } from 'vitest';
import type { BotView } from '../../shared/bots';
import {
  cardComputer,
  computerAgent,
  computerBotFor,
  computerButtonTone,
  computerEventMatches,
  conversationComputer,
  viewMatches,
} from './target';

const bot = (id: string, template_key: string | null = null): BotView =>
  ({ id, name: id.toUpperCase(), template_key, status: 'active' }) as BotView;
const sprouty = bot('bot_main', 'sprouty');
const fern = bot('bot_fern', 'researcher');
const byId: Record<string, BotView> = { bot_main: sprouty, bot_fern: fern };
const lookup = (id: string) => byId[id];

describe('computerBotFor', () => {
  it('the main Agent and no Agent mean the main computer; any other Agent its own', () => {
    expect(computerBotFor('bot_main', lookup)).toBeNull();
    expect(computerBotFor(null, lookup)).toBeNull();
    expect(computerBotFor(undefined, lookup)).toBeNull();
    expect(computerBotFor('', lookup)).toBeNull();
    expect(computerBotFor('bot_fern', lookup)).toBe('bot_fern');
  });

  it('an Agent the list does not know yet keeps its id (the server maps Sprouty itself)', () => {
    expect(computerBotFor('bot_new', lookup)).toBe('bot_new');
  });

  it('a conversation means its owner Agent; a card the Agent that raised it', () => {
    expect(conversationComputer({ owner_bot_id: 'bot_fern' }, lookup)).toBe('bot_fern');
    expect(conversationComputer({ owner_bot_id: 'bot_main' }, lookup)).toBeNull();
    expect(conversationComputer({ owner_bot_id: null }, lookup)).toBeNull();
    expect(conversationComputer(null, lookup)).toBeNull();
    expect(cardComputer({ bot_id: 'bot_fern' }, lookup)).toBe('bot_fern');
    expect(cardComputer({ bot_id: null }, lookup)).toBeNull();
  });

  it('whose computer: the main Agent for null, the named one otherwise', () => {
    const s = { bots: [fern, sprouty], byId };
    expect(computerAgent(s, null)).toBe(sprouty);
    expect(computerAgent(s, 'bot_fern')).toBe(fern);
    expect(computerAgent(s, 'bot_gone')).toBeNull();
    expect(computerAgent({ bots: [], byId: {} }, null)).toBeNull();
  });
});

describe('computerEventMatches', () => {
  it('once the view knows its computer id, only that id matches', () => {
    const known = { computer_id: 'u1.bot_fern', bot_id: 'bot_fern' };
    expect(computerEventMatches({ computer_id: 'u1.bot_fern', bot_id: 'bot_fern' }, 'bot_fern', known)).toBe(true);
    expect(computerEventMatches({ computer_id: 'u1', bot_id: null }, 'bot_fern', known)).toBe(false);
    expect(computerEventMatches({ computer_id: 'u1.bot_other', bot_id: 'bot_other' }, 'bot_fern', known)).toBe(false);
  });

  it('asked for by Sprouty’s own id: the main computer’s pushes match once its id is known', () => {
    const known = { computer_id: 'u1', bot_id: null };
    expect(computerEventMatches({ computer_id: 'u1', bot_id: null }, 'bot_main', known)).toBe(true);
  });

  it('before the first read, the Agent decides (null = main)', () => {
    expect(computerEventMatches({ computer_id: 'u1', bot_id: null }, null, null)).toBe(true);
    expect(computerEventMatches({ computer_id: 'u1.bot_fern', bot_id: 'bot_fern' }, null, null)).toBe(false);
    expect(computerEventMatches({ computer_id: 'u1.bot_fern', bot_id: 'bot_fern' }, 'bot_fern', null)).toBe(true);
  });

  it('an older server names no computer: it has the main one only', () => {
    expect(computerEventMatches({}, null, null)).toBe(true);
    expect(computerEventMatches({}, 'bot_fern', null)).toBe(false);
    // it answered for its one computer whatever was asked: the view follows it
    expect(computerEventMatches({}, 'bot_fern', {})).toBe(true);
    expect(computerEventMatches({}, 'bot_fern', { computer_id: 'u1.bot_fern', bot_id: 'bot_fern' })).toBe(false);
  });
});

describe('viewMatches', () => {
  it('keeps a view of the asked computer, the main one for Sprouty’s id, and old-server views', () => {
    expect(viewMatches({ bot_id: 'bot_fern' }, 'bot_fern')).toBe(true);
    expect(viewMatches({ bot_id: null }, 'bot_main')).toBe(true);
    expect(viewMatches({}, 'bot_fern')).toBe(true);
    expect(viewMatches({ bot_id: 'bot_fern' }, null)).toBe(false);
    expect(viewMatches({ bot_id: 'bot_fern' }, 'bot_other')).toBe(false);
  });
});

describe('computerButtonTone', () => {
  it('tints the 🖥 while running (accent in the member’s hands) or failed; plain otherwise', () => {
    expect(computerButtonTone({ kind: 'running', controller: 'bot' })).toBe('green');
    expect(computerButtonTone({ kind: 'running', controller: 'user' })).toBe('accent');
    expect(computerButtonTone({ kind: 'error' })).toBe('red');
    expect(computerButtonTone({ kind: 'asleep' })).toBeNull();
    expect(computerButtonTone({ kind: 'starting' })).toBeNull();
    expect(computerButtonTone(null)).toBeNull();
  });
});
