import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageItem } from '@greenhouse/contract';
import { keys } from '../query';
import { afterReconnect, applyEvent, fetchMessagePage, type MessagePages } from '../realtime';
import { appendDelta, clearStreams, liveText, readStream } from '../streams';

const messages = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', () => ({ api: { conversations: { messages } } }));

const item = (seq: number, content: string, status: MessageItem['status'] = 'complete'): MessageItem =>
  ({
    id: `msg_${seq}`,
    conversation_id: 'cnv_1',
    seq,
    role: seq % 2 ? 'user' : 'assistant',
    content,
    status,
    my_rating: null,
  }) as MessageItem;

const page = (items: MessageItem[]): MessagePages => ({
  pages: [{ items, next_cursor: null }],
  pageParams: [undefined],
});

const shown = (client: QueryClient) =>
  (client.getQueryData<MessagePages>(keys.messages('cnv_1'))?.pages.flatMap((entry) => entry.items) ?? [])
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => [entry.seq, entry.content, entry.status]);

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  messages.mockReset();
});
afterEach(() => {
  client.clear();
  clearStreams();
});

describe('catching up', () => {
  it('on a resync hint, fetches the messages after it and puts the final reply in place', async () => {
    client.setQueryData(keys.messages('cnv_1'), page([item(1, 'hi'), item(2, 'Once upon', 'streaming')]));
    appendDelta('msg_2', 'Once upon a time', 0);
    messages.mockResolvedValue({ items: [item(2, 'Once upon a time, the end.'), item(3, 'thanks')], next_cursor: null });
    applyEvent(client, { type: 'conversation.resync', data: { conversation_id: 'cnv_1', after_seq: 1 } });
    await vi.waitFor(() => expect(shown(client)).toHaveLength(3));
    expect(messages).toHaveBeenCalledWith('cnv_1', { after: 1, limit: 200 });
    expect(shown(client)).toEqual([
      [1, 'hi', 'complete'],
      [2, 'Once upon a time, the end.', 'complete'],
      [3, 'thanks', 'complete'],
    ]);
    // The live piece of the finished reply is gone: the saved text is the reply now.
    expect(readStream('msg_2')).toBeUndefined();
  });

  it('after a reconnect, catches the open conversation up and only marks the rest stale', async () => {
    client.setQueryData(keys.messages('cnv_1'), page([item(1, 'hi'), item(2, 'Thinking', 'streaming'), item(3, 'more')]));
    const open = new QueryObserver(client, {
      queryKey: keys.messages('cnv_1'),
      queryFn: () => page([]),
      staleTime: Infinity,
    });
    const stop = open.subscribe(() => undefined);
    const conversation = vi.fn(async () => ({ id: 'cnv_1', working: false }));
    const detail = new QueryObserver(client, { queryKey: keys.conversation('cnv_1'), queryFn: conversation });
    const stopDetail = detail.subscribe(() => undefined);
    await vi.waitFor(() => expect(client.getQueryState(keys.conversation('cnv_1'))?.status).toBe('success'));
    const list = vi.fn(async () => ({ pages: [], pageParams: [] }));
    const others = new QueryObserver(client, { queryKey: keys.conversations, queryFn: list, staleTime: Infinity });
    const stopOthers = others.subscribe(() => undefined);
    await vi.waitFor(() => expect(client.getQueryState(keys.conversations)?.status).toBe('success'));
    // Meanwhile the reply finished, and an edit elsewhere replaced the latest one.
    messages.mockResolvedValue({
      items: [item(1, 'hi'), item(2, 'Thinking done.'), item(4, 'the new answer')],
      next_cursor: null,
    });

    afterReconnect(client);
    // From before the newest messages and the reply that was still being written.
    await vi.waitFor(() => expect(messages).toHaveBeenCalledWith('cnv_1', { after: 0, limit: 200 }));
    await vi.waitFor(() =>
      expect(shown(client)).toEqual([
        [1, 'hi', 'complete'],
        [2, 'Thinking done.', 'complete'],
        [4, 'the new answer', 'complete'],
      ]),
    );
    // The open conversation's own queries refetch; the rest are stale, not refetched, even later.
    await vi.waitFor(() => expect(conversation).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(list).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(keys.conversations)?.isInvalidated).toBe(true);
    stop();
    stopDetail();
    stopOthers();
  });

  it('keeps what arrived while it fetched, and never takes a finished reply back to partial text', async () => {
    client.setQueryData(keys.messages('cnv_1'), page([item(1, 'hi'), item(2, 'Writ', 'streaming')]));
    let answer!: (value: { items: MessageItem[]; next_cursor: null }) => void;
    messages.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    applyEvent(client, { type: 'conversation.resync', data: { conversation_id: 'cnv_1', after_seq: 1 } });
    // While the answer is on its way, the reply finishes and the next message comes in.
    applyEvent(client, { type: 'message.updated', data: { message: item(2, 'Written in full.') } });
    applyEvent(client, { type: 'message.created', data: { message: item(3, 'next one') } });
    answer({ items: [item(2, 'Written', 'streaming')], next_cursor: null });
    await vi.waitFor(() => expect(messages).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown(client)).toEqual([
      [1, 'hi', 'complete'],
      [2, 'Written in full.', 'complete'],
      [3, 'next one', 'complete'],
    ]);
  });
});

describe('a conversation opened while messages arrive', () => {
  it('keeps realtime replies when the initial page returns an older snapshot', async () => {
    let finish!: (value: { items: MessageItem[]; next_cursor: null }) => void;
    messages.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const observer = new QueryObserver(client, { queryKey: keys.messages('cnv_1'), queryFn: async () => page((await fetchMessagePage(client, 'cnv_1')).items) });
    const stop = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(messages).toHaveBeenCalled());
    applyEvent(client, { type: 'message.created', data: { message: item(2, '', 'streaming') } });
    applyEvent(client, { type: 'message.updated', data: { message: item(2, 'Finished') } });
    finish({ items: [item(1, 'Question')], next_cursor: null });
    await vi.waitFor(() => expect(client.getQueryState(keys.messages('cnv_1'))?.fetchStatus).toBe('idle'));
    expect(shown(client)).toEqual([[1, 'Question', 'complete'], [2, 'Finished', 'complete']]);
    stop();
  });
  it('keeps an interjection already incorporated while its page was in flight', async () => {
    const before = { ...item(3, 'More context'), event: { type: 'interjection', state: 'queued' } };
    let finish!: (value: { items: MessageItem[]; next_cursor: null }) => void;
    messages.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    client.setQueryData(keys.messages('cnv_1'), page([before]));
    const fetch = fetchMessagePage(client, 'cnv_1');
    applyEvent(client, { type: 'message.updated', data: { message: { ...before, event: { type: 'interjection', state: 'incorporated' } } } });
    finish({ items: [before], next_cursor: null });
    expect((await fetch).items[0]?.event?.state).toBe('incorporated');
  });

});

it('discards an unfinished suffix before resumed deltas, even for a prefix too large for NOTIFY', () => {
  const prefix = 'saved '.repeat(2000);
  client.setQueryData(keys.messages('cnv_1'), page([item(2, prefix + 'unfinished', 'streaming')]));
  appendDelta('msg_2', 'unfinished', prefix.length);
  applyEvent(client, {type:'message.resumed', data:{conversation_id:'cnv_1',message_id:'msg_2',offset:prefix.length}});
  expect(readStream('msg_2')).toBeUndefined();
  expect(shown(client)).toEqual([[2,prefix,'streaming']]);
  applyEvent(client,{type:'message.delta',data:{conversation_id:'cnv_1',message_id:'msg_2',offset:prefix.length,text:'continued'}});
  expect(liveText(prefix,readStream('msg_2'))).toBe(prefix+'continued');
  applyEvent(client,{type:'message.updated',data:{message:item(2,prefix+'continued')}});
  // A delayed resume hint never takes an answer that is already complete back to a partial one.
  applyEvent(client, {type:'message.resumed', data:{conversation_id:'cnv_1',message_id:'msg_2',offset:prefix.length}});
  expect(shown(client)).toEqual([[2,prefix+'continued','complete']]);
});
