/**
 * Stream event parsing and dispatch tests.
 *
 * Tests readNdjsonStream (NDJSON parser) and handleStreamEvent (dispatcher).
 * These are critical for the chat UI — any bug here means broken streaming.
 */

import { describe, it, expect, vi } from 'vitest';
import { readNdjsonStream, handleStreamEvent } from '@greenhouse/types/api';
import type { StreamingEvent, StreamEventCallbacks } from '@greenhouse/types/api';

// ─── Helper: create a ReadableStream from string lines ───

function createStream(lines: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = lines.map((l) => encoder.encode(l));
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
  });
  return stream.getReader();
}

// ─── readNdjsonStream ────────────────────────────────────

describe('readNdjsonStream', () => {
  it('parses single-line NDJSON', async () => {
    const reader = createStream(['{"type":"text-delta","text":"hello"}\n']);
    const events: unknown[] = [];
    for await (const event of readNdjsonStream(reader)) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'text-delta', text: 'hello' }]);
  });

  it('parses multiple lines in one chunk', async () => {
    const reader = createStream([
      '{"type":"text-delta","text":"a"}\n{"type":"text-delta","text":"b"}\n',
    ]);
    const events: unknown[] = [];
    for await (const event of readNdjsonStream(reader)) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect((events[0] as any).text).toBe('a');
    expect((events[1] as any).text).toBe('b');
  });

  it('handles events split across chunks', async () => {
    const reader = createStream([
      '{"type":"text-del',
      'ta","text":"split"}\n',
    ]);
    const events: unknown[] = [];
    for await (const event of readNdjsonStream(reader)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect((events[0] as any).text).toBe('split');
  });

  it('handles trailing content without newline', async () => {
    const reader = createStream(['{"type":"finish","finishReason":"stop"}']);
    const events: unknown[] = [];
    for await (const event of readNdjsonStream(reader)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect((events[0] as any).finishReason).toBe('stop');
  });

  it('skips empty lines', async () => {
    const reader = createStream(['\n\n{"type":"text-delta","text":"ok"}\n\n']);
    const events: unknown[] = [];
    for await (const event of readNdjsonStream(reader)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
  });

  it('skips malformed JSON lines', async () => {
    const reader = createStream([
      '{"type":"text-delta","text":"good"}\n',
      'this is not json\n',
      '{"type":"finish","finishReason":"stop"}\n',
    ]);
    const events: unknown[] = [];
    for await (const event of readNdjsonStream(reader)) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect((events[0] as any).text).toBe('good');
    expect((events[1] as any).finishReason).toBe('stop');
  });

  it('handles empty stream', async () => {
    const reader = createStream([]);
    const events: unknown[] = [];
    for await (const event of readNdjsonStream(reader)) {
      events.push(event);
    }
    expect(events).toHaveLength(0);
  });
});

// ─── handleStreamEvent ──────────────────────────────────

describe('handleStreamEvent', () => {
  it('dispatches text-delta', () => {
    const onTextDelta = vi.fn();
    handleStreamEvent({ type: 'text-delta', text: 'hello' } as StreamingEvent, { onTextDelta });
    expect(onTextDelta).toHaveBeenCalledWith('hello');
  });

  it('dispatches reasoning-delta', () => {
    const onReasoningDelta = vi.fn();
    handleStreamEvent({ type: 'reasoning-delta', text: 'thinking...' } as StreamingEvent, { onReasoningDelta });
    expect(onReasoningDelta).toHaveBeenCalledWith('thinking...');
  });

  it('dispatches tool-call-start', () => {
    const onToolCallStart = vi.fn();
    handleStreamEvent(
      { type: 'tool-call-start', id: 'tc1', toolName: 'search' } as StreamingEvent,
      { onToolCallStart },
    );
    expect(onToolCallStart).toHaveBeenCalledWith('tc1', 'search');
  });

  it('dispatches tool-call-delta', () => {
    const onToolCallDelta = vi.fn();
    handleStreamEvent(
      { type: 'tool-call-delta', id: 'tc1', delta: '{"query":' } as StreamingEvent,
      { onToolCallDelta },
    );
    expect(onToolCallDelta).toHaveBeenCalledWith('tc1', '{"query":');
  });

  it('dispatches tool-call-end', () => {
    const onToolCallEnd = vi.fn();
    handleStreamEvent({ type: 'tool-call-end', id: 'tc1' } as StreamingEvent, { onToolCallEnd });
    expect(onToolCallEnd).toHaveBeenCalledWith('tc1');
  });

  it('dispatches tool-result', () => {
    const onToolResult = vi.fn();
    const output = { results: [{ title: 'Test' }] };
    handleStreamEvent(
      { type: 'tool-result', id: 'tc1', toolName: 'search', output } as StreamingEvent,
      { onToolResult },
    );
    expect(onToolResult).toHaveBeenCalledWith('tc1', 'search', output);
  });

  it('dispatches finish', () => {
    const onFinish = vi.fn();
    const usage = { inputTokens: 100, outputTokens: 50 };
    handleStreamEvent(
      { type: 'finish', finishReason: 'stop', usage } as StreamingEvent,
      { onFinish },
    );
    expect(onFinish).toHaveBeenCalledWith('stop', usage);
  });

  it('dispatches error', () => {
    const onError = vi.fn();
    handleStreamEvent({ type: 'error', error: 'boom' } as StreamingEvent, { onError });
    expect(onError).toHaveBeenCalledWith('boom');
  });

  it('dispatches title', () => {
    const onTitle = vi.fn();
    handleStreamEvent({ type: 'title', title: 'Chat Title' } as StreamingEvent, { onTitle });
    expect(onTitle).toHaveBeenCalledWith('Chat Title');
  });

  it('dispatches step-start and step-finish', () => {
    const onStepStart = vi.fn();
    const onStepFinish = vi.fn();
    handleStreamEvent({ type: 'step-start' } as StreamingEvent, { onStepStart });
    handleStreamEvent(
      { type: 'step-finish', finishReason: 'tool-calls', usage: { inputTokens: 10 } } as StreamingEvent,
      { onStepFinish },
    );
    expect(onStepStart).toHaveBeenCalled();
    expect(onStepFinish).toHaveBeenCalledWith('tool-calls', { inputTokens: 10 });
  });

  it('ignores events without matching callback', () => {
    // Should not throw
    handleStreamEvent({ type: 'text-delta', text: 'test' } as StreamingEvent, {});
    handleStreamEvent({ type: 'finish', finishReason: 'stop' } as StreamingEvent, {});
    handleStreamEvent({ type: 'error', error: 'test' } as StreamingEvent, {});
  });

  it('dispatches all event types in a realistic sequence', () => {
    const cbs: StreamEventCallbacks = {
      onTextDelta: vi.fn(),
      onToolCallStart: vi.fn(),
      onToolCallDelta: vi.fn(),
      onToolCallEnd: vi.fn(),
      onToolResult: vi.fn(),
      onStepStart: vi.fn(),
      onStepFinish: vi.fn(),
      onFinish: vi.fn(),
      onTitle: vi.fn(),
    };

    const events: StreamingEvent[] = [
      { type: 'title', title: 'Test Chat' },
      { type: 'step-start' },
      { type: 'tool-call-start', id: 'tc1', toolName: 'knowledge_query' },
      { type: 'tool-call-delta', id: 'tc1', delta: '{"action":"search","query":"basil"}' },
      { type: 'tool-call-end', id: 'tc1' },
      { type: 'tool-result', id: 'tc1', toolName: 'knowledge_query', output: { action: 'search', results: [] } },
      { type: 'step-finish', finishReason: 'tool-calls', usage: { inputTokens: 50, outputTokens: 10 } },
      { type: 'step-start' },
      { type: 'text-delta', text: 'Here is' },
      { type: 'text-delta', text: ' the answer.' },
      { type: 'step-finish', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 40 } },
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 150, outputTokens: 50 } },
    ] as StreamingEvent[];

    for (const event of events) {
      handleStreamEvent(event, cbs);
    }

    expect(cbs.onTitle).toHaveBeenCalledWith('Test Chat');
    expect(cbs.onStepStart).toHaveBeenCalledTimes(2);
    expect(cbs.onToolCallStart).toHaveBeenCalledWith('tc1', 'knowledge_query');
    expect(cbs.onTextDelta).toHaveBeenCalledTimes(2);
    expect(cbs.onFinish).toHaveBeenCalledTimes(1);
  });
});
