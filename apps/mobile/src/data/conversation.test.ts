import { describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api/client';
import type { ChatEvent } from './chat-stream';
import { Conversation, type ConversationDeps, type StreamOutcome } from './conversation';
import type { MessagePage, TranscriptMessage } from './transcript';

const m = (seq: number, role: string, content = `m${seq}`): TranscriptMessage => ({ id: `msg_${seq}`, role, content, seq });
const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const miss = (status: number): ApiResult<never> => ({ ok: false, status, code: 'x', message: status === 409 ? 'busy' : '' });

/** A fake station: a transcript, an optional reply being written, and scripted answers. */
function station() {
  const saved: TranscriptMessage[] = [m(1, 'user'), m(2, 'assistant'), m(3, 'user'), m(4, 'assistant')];
  let active = false;
  let failReads = 0;
  const deps: ConversationDeps & { saved: TranscriptMessage[] } = {
    saved,
    title: async () => ok({ title: 'Q4' }),
    latestPage: async () => {
      if (failReads > 0) {
        failReads -= 1;
        return miss(0);
      }
      const page = saved.slice(-2);
      return ok<MessagePage>({ messages: page, has_more: saved.length > 2, next_before_seq: page[0]!.seq });
    },
    olderPage: async (before) => {
      const older = saved.filter((x) => x.seq < before).slice(-2);
      return ok<MessagePage>({ messages: older, has_more: (older[0]?.seq ?? 1) > 1, next_before_seq: older[0]?.seq ?? null });
    },
    send: vi.fn(async (text: string, onEvent: (e: ChatEvent) => void): Promise<StreamOutcome> => {
      const seq = saved.length + 1;
      saved.push(m(seq, 'user', text));
      onEvent({ type: 'text-delta', text: 'Hello' });
      onEvent({ type: 'finish' });
      saved.push(m(seq + 1, 'assistant', 'Hello'));
      return { ok: true, finished: true };
    }),
    runActive: async () => ok({ active }),
    follow: vi.fn(async (onEvent: (e: ChatEvent) => void): Promise<StreamOutcome> => {
      onEvent({ type: 'text-delta', text: 'Still writing' });
      onEvent({ type: 'finish' });
      active = false;
      saved.push(m(saved.length + 1, 'assistant', 'Still writing'));
      return { ok: true, finished: true };
    }),
    stillCurrent: () => true,
    wait: async () => {},
  };
  return {
    deps,
    setActive: (value: boolean) => {
      active = value;
    },
    failNextReads: (n: number) => {
      failReads = n;
    },
  };
}
const seqs = (c: Conversation) => c.state.transcript?.messages.map((x) => x.seq);

describe('an open conversation', () => {
  it('opens on the most recent messages and pages older ones in front', async () => {
    const s = station();
    const c = new Conversation(s.deps);
    await c.open();
    expect(seqs(c)).toEqual([3, 4]);
    expect(c.state.title).toBe('Q4');
    await c.loadOlder();
    expect(seqs(c)).toEqual([1, 2, 3, 4]);
    expect(c.state.transcript?.before).toBeNull();
  });

  it('merges the saved reply after a send without dropping older history', async () => {
    const s = station();
    const c = new Conversation(s.deps);
    await c.open();
    await c.loadOlder();
    expect(await c.send('Hi')).toEqual({ sent: true });
    expect(seqs(c)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(c.state.pending).toBeNull();
    expect(c.state.reply).toBeNull();
    expect(c.state.busy).toBe(false);
  });

  it('keeps the streamed exchange with a retry when the final read fails, and replaces it once it succeeds', async () => {
    const s = station();
    const c = new Conversation(s.deps);
    await c.open();
    s.failNextReads(1);
    await c.send('Hi');
    expect(c.state.unreconciled).toBe(true);
    expect(c.state.pending).toBe('Hi');
    expect(c.state.reply?.text).toBe('Hello');
    expect(seqs(c)).toEqual([3, 4]);
    await c.reconcile();
    expect(c.state.unreconciled).toBe(false);
    expect(c.state.pending).toBeNull();
    expect(seqs(c)).toEqual([3, 4, 5, 6]);
  });

  it('keeps the streamed reply when the saved transcript does not hold it yet', async () => {
    const s = station();
    s.deps.send = async (_text, onEvent) => {
      onEvent({ type: 'text-delta', text: 'Partly' });
      return { ok: true, finished: true };
    };
    const c = new Conversation(s.deps);
    await c.open();
    await c.send('Hi');
    expect(c.state.reply?.text).toBe('Partly');
    expect(c.state.unreconciled).toBe(true);
    expect(seqs(c)).toEqual([3, 4]);
  });

  it('gives my words back on 409 and follows the reply that is still being written', async () => {
    const s = station();
    s.deps.send = async () => miss(409) as StreamOutcome;
    const c = new Conversation(s.deps);
    await c.open();
    s.setActive(true);
    const result = await c.send('Again');
    expect(result).toEqual({ sent: false, restore: 'Again', notice: 'busy', message: 'busy' });
    await vi.waitFor(() => expect(c.state.busy).toBe(false));
    expect(s.deps.follow).toHaveBeenCalledOnce();
    expect(c.state.transcript?.messages.at(-1)?.content).toBe('Still writing');
  });

  it('gives my words back when sending fails', async () => {
    const s = station();
    s.deps.send = async () => miss(500) as StreamOutcome;
    const c = new Conversation(s.deps);
    await c.open();
    expect(await c.send('Hi')).toMatchObject({ sent: false, restore: 'Hi', notice: 'failed' });
    expect(c.state.pending).toBeNull();
  });

  it('follows a reply being written when it opens, and reloads when it ends', async () => {
    const s = station();
    s.setActive(true);
    const c = new Conversation(s.deps);
    await c.open();
    expect(s.deps.follow).toHaveBeenCalledOnce();
    expect(c.state.transcript?.messages.at(-1)?.content).toBe('Still writing');
    expect(c.state.reply).toBeNull();
  });

  it('catches up on refocus with a reply written meanwhile', async () => {
    const s = station();
    const c = new Conversation(s.deps);
    await c.open();
    s.setActive(true);
    await c.refocus();
    expect(s.deps.follow).toHaveBeenCalledOnce();
    expect(c.state.busy).toBe(false);
  });

  it('says a conversation is gone', async () => {
    const s = station();
    s.deps.title = async () => miss(404);
    const c = new Conversation(s.deps);
    await c.open();
    expect(c.state.missing).toBe(true);
  });

  it('stops quietly after a station or account switch', async () => {
    const s = station();
    let current = true;
    s.deps.stillCurrent = () => current;
    const c = new Conversation(s.deps);
    await c.open();
    s.deps.send = async (_text, onEvent) => {
      current = false;
      onEvent({ type: 'text-delta', text: 'late' });
      return { ok: true, finished: true };
    };
    await c.send('Hi');
    expect(c.state.reply?.text).toBe('');
    expect(seqs(c)).toEqual([3, 4]);
  });
});
