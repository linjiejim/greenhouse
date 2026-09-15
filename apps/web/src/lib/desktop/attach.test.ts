import { describe, expect, it, vi } from 'vitest';
import { onAttachment, publishAttachment } from './attach';

describe('desktop attachment routing', () => {
  it('keeps a pending Chat handoff until the Chat consumer subscribes', () => {
    const assistant = vi.fn();
    const chat = vi.fn();

    publishAttachment({ target: 'chat', sessionId: 'session-a' });
    const stopAssistant = onAttachment(assistant, 'assistant');
    expect(assistant).not.toHaveBeenCalled();

    const stopChat = onAttachment(chat, 'chat');
    expect(chat).toHaveBeenCalledWith({ target: 'chat', sessionId: 'session-a' });
    stopAssistant();
    stopChat();
  });

  it('routes legacy handoffs only to the Assistant consumer', () => {
    const assistant = vi.fn();
    const chat = vi.fn();
    const stopAssistant = onAttachment(assistant, 'assistant');
    const stopChat = onAttachment(chat, 'chat');

    publishAttachment({ draft: 'selection' });
    expect(assistant).toHaveBeenCalledWith({ draft: 'selection' });
    expect(chat).not.toHaveBeenCalled();
    stopAssistant();
    stopChat();
  });
});
