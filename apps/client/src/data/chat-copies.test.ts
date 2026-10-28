import { describe, expect, it } from 'vitest';
import { KEPT_CHATS, parseChatCopy, parseChatList, withOpenedChat } from './chat-copies';

describe('conversations kept on the phone', () => {
  it('keeps the last opened ones and says which fell off', () => {
    let list: string[] = [];
    let dropped: string[] = [];
    for (let i = 0; i <= KEPT_CHATS; i += 1) ({ list, dropped } = withOpenedChat(list, `s${i}`));
    expect(list).toHaveLength(KEPT_CHATS);
    expect(list[0]).toBe(`s${KEPT_CHATS}`);
    expect(dropped).toEqual(['s0']);
    expect(withOpenedChat(['a', 'b'], 'b').list).toEqual(['b', 'a']);
  });

  it('reads a saved copy, or nothing', () => {
    const copy = parseChatCopy({ title: 'Q4', page: { messages: [{ id: 'm', seq: 1, content: 'hi', role: 'user' }, { id: 2 }], has_more: true, next_before_seq: 1 } });
    expect(copy?.page.messages).toHaveLength(1);
    expect(copy?.title).toBe('Q4');
    expect(parseChatCopy({ page: {} })).toBeNull();
    expect(parseChatList(['a', 3, 'b'])).toEqual(['a', 'b']);
  });

  it('keeps whose conversation it is, and leaves it unknown in older copies', () => {
    const page = { messages: [] };
    expect(parseChatCopy({ page, shared: null })?.shared).toBeNull();
    expect(parseChatCopy({ page, shared: { by: 'Leo' } })?.shared).toEqual({ by: 'Leo' });
    expect(parseChatCopy({ page, shared: { by: 7 } })?.shared).toEqual({ by: null });
    expect(parseChatCopy({ page })).not.toHaveProperty('shared');
  });
});
