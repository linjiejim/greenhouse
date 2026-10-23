import { describe, expect, it } from 'vitest';
import { exchangeStart, holdsNewReply, withLatest, withOlder, type MessagePage, type TranscriptMessage } from './transcript';

const m = (seq: number, role = seq % 2 ? 'assistant' : 'user', content = `m${seq}`): TranscriptMessage => ({
  id: `msg_${seq}`,
  role,
  content,
  seq,
});
const page = (seqs: number[], hasMore: boolean): MessagePage => ({
  messages: seqs.map((seq) => m(seq)),
  has_more: hasMore,
  next_before_seq: hasMore ? seqs[0]! : null,
});

describe('a conversation’s transcript', () => {
  it('opens on the latest page and pages older history in front', () => {
    const latest = withLatest(null, page([100, 101, 102], true));
    expect(latest.before).toBe(100);
    const more = withOlder(latest, page([97, 98, 99], false));
    expect(more.messages.map((x) => x.seq)).toEqual([97, 98, 99, 100, 101, 102]);
    expect(more.before).toBeNull();
  });

  it('merges a reload after a reply instead of replacing earlier history', () => {
    const loaded = withOlder(withLatest(null, page([100, 101], true)), page([98, 99], true));
    // the reload's latest page only reaches back to 101
    const reloaded = withLatest(loaded, page([101, 102, 103], true));
    expect(reloaded.messages.map((x) => x.seq)).toEqual([98, 99, 100, 101, 102, 103]);
    expect(reloaded.before).toBe(98);
  });

  it('pages from the latest page when it does not reach what is loaded', () => {
    const loaded = withLatest(null, page([10, 11], false));
    const far = withLatest(loaded, page([200, 201], true));
    expect(far.before).toBe(200);
  });

  it('takes the saved version of a message it already shows', () => {
    const loaded = withLatest(null, page([1, 2], true));
    const saved = withLatest(loaded, { messages: [m(2, 'user', 'edited')], has_more: true, next_before_seq: 2 });
    expect(saved.messages.find((x) => x.seq === 2)?.content).toBe('edited');
  });

  it('drops a tail the server no longer has (edited and re-run on the web) but keeps older history', () => {
    const loaded = withOlder(withLatest(null, page([10, 11, 12, 13], true)), page([8, 9], true));
    // on the web, message 11 was edited: 12 and 13 are gone, a new reply replaced 11's answer
    const latest: MessagePage = {
      messages: [m(10), { id: 'msg_11b', role: 'assistant', content: 'new answer', seq: 11 }],
      has_more: true,
      next_before_seq: 10,
    };
    const reloaded = withLatest(loaded, latest);
    expect(reloaded.messages.map((x) => [x.seq, x.id])).toEqual([
      [8, 'msg_8'],
      [9, 'msg_9'],
      [10, 'msg_10'],
      [11, 'msg_11b'],
    ]);
    expect(reloaded.before).toBe(8);
  });

  it('replaces everything with a page that is the whole conversation', () => {
    const loaded = withLatest(null, page([1, 2, 3, 4], false));
    expect(withLatest(loaded, page([1, 2], false)).messages.map((x) => x.seq)).toEqual([1, 2]);
    expect(withLatest(loaded, { messages: [], has_more: false, next_before_seq: null }).messages).toEqual([]);
  });

  it('keeps a streamed reply until the saved transcript holds it', () => {
    const before = withLatest(null, page([100, 101], false));
    const known = exchangeStart(before);
    expect(holdsNewReply(page([100, 101], false), known)).toBe(false);
    expect(holdsNewReply({ messages: [m(102, 'user')], has_more: false, next_before_seq: null }, known)).toBe(false);
    expect(holdsNewReply({ messages: [m(102, 'user'), m(103, 'assistant')], has_more: false, next_before_seq: null }, known)).toBe(true);
  });

  it('recognises a reply that replaced an assistant message under the same seq', () => {
    const known = exchangeStart(withLatest(null, page([100, 101], false)));
    const replaced: MessagePage = {
      messages: [m(100, 'user'), { id: 'msg_101_regenerated', role: 'assistant', content: 'again', seq: 101 }],
      has_more: false,
      next_before_seq: null,
    };
    expect(holdsNewReply(replaced, known)).toBe(true);
  });

  it('never takes an older message that merely was not loaded for the reply', () => {
    // loaded 50–99; the server's latest page now reaches back to 49, which was never loaded
    const loaded = withLatest(null, page(Array.from({ length: 50 }, (_, i) => 50 + i), true));
    const start = exchangeStart(loaded);
    const truncated: MessagePage = {
      messages: Array.from({ length: 50 }, (_, i) => m(49 + i)),
      has_more: true,
      next_before_seq: 49,
    };
    expect(holdsNewReply(truncated, start)).toBe(false);
  });
});
