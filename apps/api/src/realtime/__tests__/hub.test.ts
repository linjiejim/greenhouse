import { describe, expect, it } from 'vitest';
import type { Message, RealtimeEvent } from '@greenhouse/contract';
import { createHub, type NotifyTransport } from '../hub.js';

/** Every NOTIFY one hub sends, delivered to every other hub on the same channel. */
function bus() {
  const listeners = new Set<(payload: string) => void>();
  const sent: string[] = [];
  const transport: NotifyTransport = {
    async notify(_channel, payload) {
      sent.push(payload);
      for (const listener of listeners) listener(payload);
    },
    async listen(_channel, onPayload) {
      listeners.add(onPayload);
      return async () => {
        listeners.delete(onPayload);
      };
    },
  };
  return { transport, sent };
}

const message = (content: string): Message =>
  ({
    id: 'msg_1',
    conversation_id: 'cnv_1',
    seq: 12,
    role: 'assistant',
    content,
  }) as Message;

describe('the hub between processes', () => {
  it('splits a long recipient list so every payload fits, and reaches each person once', async () => {
    const { transport, sent } = bus();
    const a = createHub();
    const b = createHub();
    await a.connect(transport);
    await b.connect(transport);
    const people = Array.from({ length: 400 }, (_, index) => `mbr_${String(index).padStart(26, '0')}`);
    const got = new Map<string, number>();
    for (const id of people) b.subscribe(id, () => got.set(id, (got.get(id) ?? 0) + 1));
    a.publish(people, {
      type: 'read.updated',
      data: { conversation_id: 'cnv_1', member_id: 'mbr_x', last_read_seq: 3 },
    });
    expect(sent.length).toBeGreaterThan(1);
    for (const payload of sent) expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(7000);
    expect(got.size).toBe(400);
    expect([...got.values()].every((count) => count === 1)).toBe(true);
  });

  it('sends a message too big to share as a resync hint, and the full event only to its own sockets', async () => {
    const { transport } = bus();
    const a = createHub();
    const b = createHub();
    await a.connect(transport);
    await b.connect(transport);
    const here: RealtimeEvent[] = [];
    const there: RealtimeEvent[] = [];
    a.subscribe('mbr_lin', (event) => here.push(event));
    b.subscribe('mbr_lin', (event) => there.push(event));
    const final: RealtimeEvent = { type: 'message.updated', data: { message: message('长'.repeat(4000)) } };
    a.publish(['mbr_lin'], final);
    expect(here).toEqual([final]);
    expect(there).toEqual([{ type: 'conversation.resync', data: { conversation_id: 'cnv_1', after_seq: 11 } }]);
  });

  it('shows observers every event, published here or received', async () => {
    const { transport } = bus();
    const a = createHub();
    const b = createHub();
    await a.connect(transport);
    await b.connect(transport);
    const seen: string[] = [];
    const stop = b.observe((event) => seen.push(event.type));
    a.publish(['mbr_nobody_here'], { type: 'conversation.updated', data: { conversation_id: 'cnv_1', changes: {} } });
    b.publish(['mbr_lin'], { type: 'notes.updated', data: { conversation_id: 'cnv_1', note_id: 'nte_1' } });
    stop();
    a.publish(['mbr_lin'], { type: 'notes.updated', data: { conversation_id: 'cnv_1', note_id: 'nte_2' } });
    expect(seen).toEqual(['conversation.updated', 'notes.updated']);
  });
});
