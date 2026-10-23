import { describe, expect, it } from 'vitest';
import { applyEvent, EMPTY_REPLY, NdjsonLines, visibleMessages, type ChatEvent } from './chat-stream';

describe('the reply stream', () => {
  it('reads events split anywhere across chunks', () => {
    const lines = new NdjsonLines();
    const body = '{"type":"text-delta","text":"Hel"}\n{"type":"text-del' + 'ta","text":"lo"}\n{"type":"finish"}';
    const events: ChatEvent[] = [];
    for (let i = 0; i < body.length; i += 7) events.push(...lines.push(body.slice(i, i + 7)));
    events.push(...lines.flush());
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'text-delta', 'finish']);
  });

  it('skips broken lines and keepalives carry nothing', () => {
    const lines = new NdjsonLines();
    expect(lines.push('nope\n{"type":"ping"}\n{"no":"type"}\n')).toEqual([{ type: 'ping' }]);
  });

  it('folds events into the live reply', () => {
    const events: ChatEvent[] = [
      { type: 'text-delta', text: 'Looking' },
      { type: 'tool-call-start', id: '1', toolName: 'search_docs' },
      { type: 'tool-result', id: '1', toolName: 'search_docs', output: {} },
      { type: 'text-delta', text: ' it up.' },
      { type: 'title', title: 'Q4' },
      { type: 'finish' },
    ];
    const states = events.reduce<(typeof EMPTY_REPLY)[]>((all, e) => [...all, applyEvent(all.at(-1) ?? EMPTY_REPLY, e)], []);
    expect(states[1]!.tool).toBe('search_docs');
    expect(states[2]!.tool).toBeNull();
    expect(states.at(-1)).toEqual({ text: 'Looking it up.', tool: null, finished: true, error: null, title: 'Q4' });
  });

  it('keeps the error', () => {
    expect(applyEvent(EMPTY_REPLY, { type: 'error', error: 'quota' }).error).toBe('quota');
    expect(applyEvent(EMPTY_REPLY, { type: 'error' }).error).toBe('error');
  });

  it('shows only the conversation’s words', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: '{}' },
      { role: 'assistant', content: '  ' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(visibleMessages(messages).map((m) => m.content)).toEqual(['hi', 'hello']);
  });
});
