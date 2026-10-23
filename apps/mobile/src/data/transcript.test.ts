import { describe, expect, it } from 'vitest';
import { holdsReplyAfter, lastSeq, withLatest, withOlder, type MessagePage, type TranscriptMessage } from './transcript';

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
    const loaded = withLatest(null, page([1, 2], false));
    const saved = withLatest(loaded, { messages: [m(2, 'user', 'edited')], has_more: true, next_before_seq: 2 });
    expect(saved.messages.find((x) => x.seq === 2)?.content).toBe('edited');
    expect(lastSeq(saved)).toBe(2);
    expect(lastSeq(null)).toBe(-1);
  });

  it('keeps a streamed reply until the saved transcript holds it', () => {
    expect(holdsReplyAfter(page([100, 101], false), 101)).toBe(false);
    expect(holdsReplyAfter({ messages: [m(102, 'user')], has_more: false, next_before_seq: null }, 101)).toBe(false);
    expect(holdsReplyAfter({ messages: [m(102, 'user'), m(103, 'assistant')], has_more: false, next_before_seq: null }, 101)).toBe(true);
  });
});
