import { describe, expect, it } from 'vitest';
import type { Message, MessageItem, NeedsYou } from '../shared/contract';
import {
  editableId,
  lastSeq,
  mergeMessages,
  mergeRequests,
  placeRequests,
  regenerableId,
  removeMessages,
  startsGroup,
} from './thread';

const ME = 'me';

function msg(id: string, seq: number, partial: Partial<MessageItem> = {}): MessageItem {
  return {
    id,
    conversation_id: 'c1',
    seq,
    role: 'assistant',
    author_member_id: null,
    agent_id: 'greeny',
    content: id,
    blocks: [],
    attachments: [],
    quote: null,
    mentions: [],
    skill: null,
    citations: [],
    steps: [],
    reasoning: null,
    event: null,
    run_id: null,
    status: 'complete',
    edited_at: null,
    created_at: '2026-10-10T08:00:00.000Z',
    my_rating: null,
    ...partial,
  };
}
const mine = (id: string, seq: number, partial: Partial<MessageItem> = {}) =>
  msg(id, seq, { role: 'user', author_member_id: ME, agent_id: null, ...partial });

function card(id: string, partial: Partial<NeedsYou> = {}): NeedsYou {
  return {
    id,
    kind: 'approval',
    subject: 'tool_write',
    status: 'pending',
    conversation_id: 'c1',
    run_id: null,
    agent_id: 'greeny',
    title: id,
    payload: {},
    result: null,
    expires_at: null,
    decided_at: null,
    created_at: '2026-10-10T08:00:00.000Z',
    ...partial,
  };
}

describe('the transcript', () => {
  it('merges pages and events by id, oldest first, the newer copy winning', () => {
    const page = [msg('b', 2), msg('a', 1)];
    const list = mergeMessages([], page);
    expect(list.map((m) => m.id)).toEqual(['a', 'b']);
    const edited = mergeMessages(list, [msg('b', 2, { content: 'edited' }), msg('c', 3)]);
    expect(edited.map((m) => [m.id, m.content])).toEqual([
      ['a', 'a'],
      ['b', 'edited'],
      ['c', 'c'],
    ]);
    expect(lastSeq(edited)).toBe(3);
    expect(lastSeq([])).toBe(0);
    expect(removeMessages(edited, ['b']).map((m) => m.id)).toEqual(['a', 'c']);
  });

  it('keeps my rating when a realtime copy (which has none) replaces a message', () => {
    const rated = mergeMessages([], [msg('a', 1, { my_rating: 1 })]);
    const { my_rating: _drop, ...event } = msg('a', 1, { content: 'settled' });
    const after = mergeMessages(rated, [event as Message]);
    expect(after[0]).toMatchObject({ content: 'settled', my_rating: 1 });
  });
});

describe('edit and regenerate', () => {
  it('only my last message, while nobody else has spoken since', () => {
    const list = [mine('q1', 1), msg('r1', 2), mine('q2', 3), msg('r2', 4)];
    expect(editableId(list, ME)).toBe('q2');
    expect(regenerableId(list, ME)).toBe('r2');
    // someone else spoke last
    expect(editableId([...list, mine('x', 5, { author_member_id: 'ana' })], ME)).toBeNull();
    // the reply is still being written
    expect(regenerableId([mine('q', 1), msg('r', 2, { status: 'streaming' })], ME)).toBeNull();
    // an event line after the reply does not count
    expect(regenerableId([mine('q', 1), msg('r', 2), msg('e', 3, { role: 'event', agent_id: null })], ME)).toBe('r');
    expect(editableId([], ME)).toBeNull();
  });
});

describe('author lines', () => {
  it('show when the author changes or after five quiet minutes', () => {
    const first = msg('a', 1, { created_at: '2026-10-10T08:00:00.000Z' });
    expect(startsGroup(first, undefined)).toBe(true);
    expect(startsGroup(msg('b', 2, { created_at: '2026-10-10T08:04:00.000Z' }), first)).toBe(false);
    expect(startsGroup(msg('c', 2, { created_at: '2026-10-10T08:06:00.000Z' }), first)).toBe(true);
    expect(startsGroup(msg('d', 2, { agent_id: 'sage' }), first)).toBe(true);
    expect(startsGroup(mine('e', 2), first)).toBe(true);
  });
});

describe('cards in the transcript', () => {
  it('sit under the reply of their run; pending ones without a shown reply go to the end', () => {
    const messages = [mine('q', 1), msg('r', 2, { run_id: 'run-1' })];
    const { byRun, loose } = placeRequests(
      [card('k1', { run_id: 'run-1' }), card('k2', { run_id: 'run-x' }), card('k3', { run_id: 'run-y', status: 'approved' })],
      messages,
    );
    expect(byRun.get('run-1')?.map((c) => c.id)).toEqual(['k1']);
    expect(loose.map((c) => c.id)).toEqual(['k2']);
  });

  it('a decided card never goes back to pending', () => {
    const decided = mergeRequests([], [card('k1', { status: 'approved' })]);
    expect(mergeRequests(decided, [card('k1')])[0]!.status).toBe('approved');
    expect(mergeRequests([card('k1')], [card('k1', { status: 'rejected' })])[0]!.status).toBe('rejected');
    const ordered = mergeRequests([card('late', { created_at: '2026-10-10T09:00:00.000Z' })], [card('early')]);
    expect(ordered.map((c) => c.id)).toEqual(['early', 'late']);
  });
});
