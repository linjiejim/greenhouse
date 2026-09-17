import { beforeEach, describe, expect, it, vi } from 'vitest';
const { detail, page } = vi.hoisted(() => ({ detail: vi.fn(), page: vi.fn() }));
vi.mock('./client', () => ({ rpc: { api: { sessions: { ':id': { $get: detail, messages: { $get: page } } } } } }));
import { getSession } from './sessions';
const response = (data: object) => ({ ok: true, json: async () => data });
const messages = (start: number, length: number) =>
  Array.from({ length }, (_, index) => ({ id: `message-${start + index}`, seq: start + index }));

describe('complete conversation history', () => {
  beforeEach(() => vi.resetAllMocks());
  it('uses the detail response for a short topic', async () => {
    detail.mockResolvedValue(response({ messages: messages(1, 2), session: { id: 'topic' } }));
    expect((await getSession('topic')).messages).toHaveLength(2);
    expect(page).not.toHaveBeenCalled();
  });
  it('retains both old history and newest unread replies beyond the legacy 100-message window', async () => {
    detail.mockResolvedValue(response({ messages: messages(1, 100), session: { id: 'topic' } }));
    page
      .mockResolvedValueOnce(response({ messages: messages(151, 100), has_more: true, next_before_seq: 151 }))
      .mockResolvedValueOnce(response({ messages: messages(51, 100), has_more: true, next_before_seq: 51 }))
      .mockResolvedValueOnce(response({ messages: messages(1, 50), has_more: false, next_before_seq: null }));
    const result = await getSession('topic');
    expect(result.messages.map((m) => m.id)).toEqual(messages(1, 250).map((m) => m.id));
    expect(page.mock.calls.map(([args]) => args.query.before_seq)).toEqual([undefined, '151', '51']);
  });
  it('reports incomplete history instead of silently discarding a failed older page', async () => {
    detail.mockResolvedValue(response({ messages: messages(1, 100) }));
    page.mockResolvedValue({ ok: false, status: 503 });
    await expect(getSession('topic')).rejects.toThrow('503');
  });
});
