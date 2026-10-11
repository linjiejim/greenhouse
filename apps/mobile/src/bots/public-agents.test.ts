/**
 * Other members' public Agents on the phone (./public-agents.ts, spec 20261011-agent-first-class
 * P4): the stand-in directory entry, who can still reply, read-only, which replies take a rating,
 * the feedback body, why a start failed, the Browse list's search. Root vitest — no React Native.
 */

import { describe, expect, it } from 'vitest';
import type { BotMessage, SharedBotView } from '../shared/bots';
import {
  FEEDBACK_COMMENT_MAX,
  computerOffered,
  directoryRows,
  feedbackBody,
  rateableReply,
  replyableIds,
  sharedAsBot,
  sharedById,
  sharedOwnerOf,
  sharedReadOnly,
  startFailure,
  withConversation,
  withPageRatings,
} from './public-agents';

function shared(id: string, partial: Partial<SharedBotView> = {}): SharedBotView {
  return {
    id,
    name: id,
    role: 'Helper',
    description: 'Answers questions about the handbook',
    avatar: { plant: 'fern' },
    template_key: 'writer',
    owner: { id: 'u_owner', nickname: 'Jim' },
    dm_session_id: null,
    available: true,
    computer: false,
    ...partial,
  };
}

function message(partial: Partial<BotMessage> = {}): BotMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'Here you go',
    bot_id: 'b_pub',
    bot_event: null,
    pipeline: [],
    references: [],
    reasoning: null,
    model: null,
    images: [],
    created_at: '2026-10-12T00:00:00.000Z',
    seq: 3,
    ...partial,
  };
}

const PUB = shared('b_pub', { name: 'Handbook', dm_session_id: 's_pub' });
const GONE = shared('b_gone', { name: 'Old Helper', available: false, dm_session_id: 's_gone' });
const SHARED = { [PUB.id]: PUB, [GONE.id]: GONE };

describe('sharedAsBot', () => {
  it('is who it is and whose — nothing of its definition, always active', () => {
    const bot = sharedAsBot(GONE);
    expect(bot).toMatchObject({
      id: 'b_gone',
      name: 'Old Helper',
      role: 'Helper',
      avatar: { plant: 'fern' },
      template_key: 'writer',
      status: 'active',
      dm_session_id: 's_gone',
      user_id: 'u_owner',
      visibility: 'public',
      instructions: '',
      tools: null,
      connectors: null,
      model_id: null,
    });
  });

  it('is never the member’s main Agent', () => {
    expect(sharedAsBot(shared('b_x', { template_key: 'sprouty' })).template_key).toBeNull();
  });
});

describe('sharedById', () => {
  it('keys by id and never shadows the member’s own Agents', () => {
    expect(Object.keys(sharedById([PUB, GONE], new Set(['b_gone'])))).toEqual(['b_pub']);
    expect(sharedById(undefined, new Set())).toEqual({});
  });
});

describe('replyableIds', () => {
  it('own active Agents and the shared ones still offered', () => {
    expect([...replyableIds([{ id: 'b_mine' }], SHARED)].sort()).toEqual(['b_mine', 'b_pub']);
    expect([...replyableIds([{ id: 'b_mine' }], undefined)]).toEqual(['b_mine']);
  });
});

describe('sharedOwnerOf / sharedReadOnly', () => {
  it('a DM with someone else’s Agent; read-only once it is no longer offered', () => {
    expect(sharedOwnerOf({ owner_bot_id: 'b_pub' }, SHARED)).toBe(PUB);
    expect(sharedOwnerOf({ owner_bot_id: 'b_mine' }, SHARED)).toBeNull();
    expect(sharedOwnerOf(null, SHARED)).toBeNull();
    expect(sharedReadOnly({ owner_bot_id: 'b_pub' }, SHARED)).toBeNull();
    expect(sharedReadOnly({ owner_bot_id: 'b_gone' }, SHARED)).toBe('agent_unavailable');
    expect(sharedReadOnly({ owner_bot_id: 'b_gone' }, undefined)).toBeNull();
  });
});

describe('rateableReply', () => {
  it('a persisted reply of a shared Agent — not a greeting, not the member’s own Agent', () => {
    expect(rateableReply(message(), SHARED)).toBe(true);
    // still rateable once it is no longer offered: the rating is about a reply it gave
    expect(rateableReply(message({ bot_id: 'b_gone' }), SHARED)).toBe(true);
    expect(rateableReply(message({ bot_id: 'b_mine' }), SHARED)).toBe(false);
    expect(rateableReply(message({ bot_event: { kind: 'greeting', bot_id: 'b_pub' } }), SHARED)).toBe(false);
    expect(rateableReply(message({ role: 'user', bot_id: null }), SHARED)).toBe(false);
    expect(rateableReply(message({ bot_id: null }), SHARED)).toBe(false);
    expect(rateableReply(undefined, SHARED)).toBe(false);
    expect(rateableReply(message(), undefined)).toBe(false);
  });
});

describe('computerOffered', () => {
  it('the member’s own Agents always; someone else’s only when granted and still offered', () => {
    expect(computerOffered(null)).toBe(true);
    expect(computerOffered(PUB)).toBe(false);
    expect(computerOffered({ ...PUB, computer: true })).toBe(true);
    expect(computerOffered({ ...GONE, computer: true })).toBe(false);
  });
});

describe('withPageRatings', () => {
  const reply = (id: string) => message({ id });
  it('sets and clears the page’s replies only; system lines and member messages are not rated', () => {
    const before = { m_old: -1 as const, m2: 1 as const };
    const after = withPageRatings(
      before,
      [
        reply('m1'),
        reply('m2'),
        message({ id: 'm_greet', bot_event: { kind: 'greeting', bot_id: 'b_pub' } }),
        message({ id: 'u1', role: 'user', bot_id: null }),
      ],
      { m1: -1, u1: 1 },
      new Set(),
    );
    // m_old is on another page; m2 is unrated now; a member message never gets one.
    expect(after).toEqual({ m_old: -1, m1: -1 });
    expect(before).toEqual({ m_old: -1, m2: 1 });
  });

  it('keeps the object when nothing changed, and what was chosen on this device', () => {
    const ratings = { m1: 1 as const };
    expect(withPageRatings(ratings, [reply('m1')], { m1: 1 }, new Set())).toBe(ratings);
    expect(withPageRatings(ratings, [reply('m1'), reply('m2')], { m2: -1 }, new Set(['m1']))).toEqual({
      m1: 1,
      m2: -1,
    });
    // An older server sends no ratings at all.
    expect(withPageRatings(ratings, [reply('m1')], undefined, new Set())).toEqual({});
  });
});

describe('feedbackBody', () => {
  it('a trimmed note when there is one, capped at the server’s 1000 characters', () => {
    expect(feedbackBody(1)).toEqual({ rating: 1 });
    expect(feedbackBody(-1, null)).toEqual({ rating: -1 });
    expect(feedbackBody(-1, '   ')).toEqual({ rating: -1 });
    expect(feedbackBody(-1, '  Wrong policy year  ')).toEqual({ rating: -1, comment: 'Wrong policy year' });
    expect(feedbackBody(-1, 'x'.repeat(1200)).comment).toHaveLength(FEEDBACK_COMMENT_MAX);
  });
});

describe('startFailure', () => {
  it('404 = no longer offered; no answer = offline; anything else = failed', () => {
    expect(startFailure({ status: 404 })).toBe('gone');
    expect(startFailure({ status: 0 })).toBe('offline');
    expect(startFailure({ status: 500 })).toBe('failed');
    expect(startFailure({ status: 403 })).toBe('failed');
  });
});

describe('directoryRows', () => {
  const list = [
    shared('b1', { name: 'Handbook', owner: { id: 'u1', nickname: 'Jim' } }),
    shared('b2', { name: 'Legal', role: 'Contracts', description: 'NDAs', owner: { id: 'u2', nickname: 'Ana' } }),
  ];

  it('keeps the server’s order', () => {
    expect(directoryRows(list).map((a) => a.id)).toEqual(['b1', 'b2']);
  });

  it('searches name, role, description and owner, case-insensitively', () => {
    expect(directoryRows(list, 'legal').map((a) => a.id)).toEqual(['b2']);
    expect(directoryRows(list, ' contracts ').map((a) => a.id)).toEqual(['b2']);
    expect(directoryRows(list, 'nda').map((a) => a.id)).toEqual(['b2']);
    expect(directoryRows(list, 'jim').map((a) => a.id)).toEqual(['b1']);
    expect(directoryRows(list, 'nobody')).toEqual([]);
  });
});

describe('withConversation', () => {
  it('the Agent with its new DM, offered', () => {
    expect(withConversation(shared('b1'), 's_new')).toMatchObject({
      id: 'b1',
      dm_session_id: 's_new',
      available: true,
    });
  });
});
