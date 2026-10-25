import { beforeEach, describe, expect, it, vi } from 'vitest';

// an in-memory disk whose reads take a turn, so saves can overlap
const disk = new Map<string, unknown>();
vi.mock('./offline', () => ({
  readOffline: async (kind: string) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return structuredClone(disk.get(kind) ?? null);
  },
  writeOffline: (kind: string, value: unknown) => disk.set(kind, structuredClone(value)),
  removeOffline: (kind: string) => disk.delete(kind),
}));

const { readChatCopy, saveChatCopy } = await import('./chat-copies');

const page = (id: string) => ({ messages: [{ id, seq: 1, content: id, role: 'user' }], has_more: false, next_before_seq: null });

describe('kept conversation copies', () => {
  beforeEach(() => disk.clear());

  it('keeps whose it is when a later copy does not know', async () => {
    await saveChatCopy('s', { title: 'T', page: page('a') as never, shared: { by: 'Leo' } });
    await saveChatCopy('s', { title: 'T', page: page('b') as never });
    const copy = await readChatCopy('s');
    expect(copy?.shared).toEqual({ by: 'Leo' });
    expect(copy?.page.messages[0]?.id).toBe('b');
  });

  it('lands overlapping saves in the order asked', async () => {
    void saveChatCopy('s', { title: 'T', page: page('a') as never });
    await saveChatCopy('s', { title: 'T', page: page('a') as never, shared: null });
    expect((await readChatCopy('s'))?.shared).toBeNull();
  });
});
