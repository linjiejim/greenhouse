/**
 * Bots rows → chat messages (./adapters.ts): the status mapping of persisted rows, sends in
 * flight and live segments, and the per-input-object cache the memoised rows rely on.
 */

import { describe, expect, it } from 'vitest';
import type { BotMessage } from '../../shared/bots';
import type { BotStreamSegment } from '../../shared/bots-wire';
import type { PendingSend } from '../vendor/transcript';
import { fromBotMessage, fromPending, fromSegment } from './adapters';

function message(partial: Partial<BotMessage> = {}): BotMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'Hello',
    bot_id: 'b_sage',
    bot_event: null,
    pipeline: [],
    references: [],
    reasoning: null,
    model: null,
    images: [],
    created_at: '2026-10-08T10:00:00.000Z',
    seq: 1,
    ...partial,
  };
}

function segment(partial: Partial<BotStreamSegment> = {}): BotStreamSegment {
  return { botId: 'b_sage', reason: 'user', status: 'streaming', text: '', reasoning: '', toolCalls: [], ...partial };
}

const OPTS = { id: 's1:r1#0', errorText: 'Sage couldn’t reply' };

describe('fromBotMessage', () => {
  it('a member message is a user bubble with its images', () => {
    const msg = fromBotMessage(
      message({ role: 'user', content: 'Hi', bot_id: null, images: [{ id: 'i1', url: '/api/upload/i1' }] }),
    );
    expect(msg).toMatchObject({ id: 'm1', serverId: 'm1', role: 'user', text: 'Hi', wire: 'Hi', status: 'done' });
    expect(msg.images).toEqual([{ id: 'i1', url: '/api/upload/i1' }]);
  });

  it('a Bot reply carries its tool pipeline, references and reasoning', () => {
    const msg = fromBotMessage(
      message({
        reasoning: 'Thinking it over',
        pipeline: [
          {
            step: 0,
            tool: 'web_search',
            input: { q: 'x' },
            output: { results: [{ title: 'Doc', url: 'https://a.io/x' }] },
            duration_ms: 120,
          },
          { step: 1, tool: 'knowledge', input: {}, output: { error: 'nope' }, duration_ms: 5 },
        ],
        references: [{ slug: 'guide', title: 'Guide', type: 'kb_doc' }],
      }),
    );
    expect(msg.role).toBe('assistant');
    expect(msg.status).toBe('done');
    expect(msg.reasoning).toBe('Thinking it over');
    expect(msg.tools?.map((s) => [s.tool, s.status, s.ms])).toEqual([
      ['web_search', 'done', 120],
      ['knowledge', 'error', 5],
    ]);
    expect(msg.web).toEqual([{ title: 'Doc', url: 'https://a.io/x', host: 'a.io' }]);
    expect(msg.sources).toEqual([{ slug: 'guide', title: 'Guide', category: undefined }]);
  });

  it('a system row (a task report body) renders as a reply', () => {
    expect(fromBotMessage(message({ role: 'system' })).role).toBe('assistant');
  });

  it('is cached by the message object', () => {
    const m = message();
    expect(fromBotMessage(m)).toBe(fromBotMessage(m));
    expect(fromBotMessage({ ...m })).not.toBe(fromBotMessage(m));
  });
});

describe('fromPending', () => {
  it('a send in flight is a fresh user bubble keyed by its client id', () => {
    const p: PendingSend = { clientId: 'c1', content: 'Hey', images: [], status: 'sending', afterSegment: 0 };
    const msg = fromPending(p);
    expect(msg).toMatchObject({ id: 'pending:c1', role: 'user', text: 'Hey', fresh: true });
    expect(fromPending(p)).toBe(msg);
    expect(fromPending({ ...p, status: 'queued' })).not.toBe(msg);
  });
});

describe('fromSegment', () => {
  it('no words, no tools yet → thinking (also a segment behind the reveal front)', () => {
    expect(fromSegment(segment(), OPTS).status).toBe('thinking');
    expect(fromSegment(segment({ reasoning: 'Hmm' }), OPTS)).toMatchObject({ status: 'thinking', reasoning: 'Hmm' });
  });

  it('words or a tool call → streaming; calls map to running / done / error steps', () => {
    expect(fromSegment(segment({ text: 'Hi' }), OPTS).status).toBe('streaming');
    const msg = fromSegment(
      segment({
        toolCalls: [
          { id: 'c1', name: 'browser', input: '{"url":"https://a', status: 'calling' },
          {
            id: 'c2',
            name: 'web_search',
            input: '{}',
            status: 'done',
            output: [{ title: 'Hit', url: 'https://b.io/' }],
          },
          { id: 'c3', name: 'knowledge', input: '{}', status: 'done', output: { error: 'x' } },
        ],
      }),
      OPTS,
    );
    expect(msg.status).toBe('streaming');
    expect(msg.tools?.map((s) => [s.id, s.tool, s.status])).toEqual([
      ['c1', 'browser', 'running'],
      ['c2', 'web_search', 'done'],
      ['c3', 'knowledge', 'error'],
    ]);
    expect(msg.web).toEqual([{ title: 'Hit', url: 'https://b.io/', host: 'b.io' }]);
  });

  it('ended: completed / stopped / error (the server’s reason, else the fallback); skipped ends quietly', () => {
    expect(fromSegment(segment({ text: 'Done', status: 'completed' }), OPTS)).toMatchObject({
      status: 'done',
      stopped: undefined,
      error: undefined,
    });
    expect(fromSegment(segment({ text: 'Part', status: 'stopped' }), OPTS)).toMatchObject({
      status: 'done',
      stopped: true,
    });
    expect(fromSegment(segment({ status: 'error', error: 'Model timeout' }), OPTS).error).toBe('Model timeout');
    expect(fromSegment(segment({ status: 'error' }), OPTS).error).toBe('Sage couldn’t reply');
  });

  it('uses the given id (unique across runs) and is cached by the segment object', () => {
    const s = segment({ text: 'Hi' });
    const msg = fromSegment(s, OPTS);
    expect(msg.id).toBe('s1:r1#0');
    expect(fromSegment(s, OPTS)).toBe(msg);
    // the engine replaces a segment only when it changed
    expect(fromSegment({ ...s, text: 'Hi there' }, OPTS)).not.toBe(msg);
    // another id or fallback text for the same object is another message
    expect(fromSegment(s, { ...OPTS, id: 's1:r2#0' }).id).toBe('s1:r2#0');
  });
});
