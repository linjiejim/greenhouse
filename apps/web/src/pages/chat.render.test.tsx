import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatPage } from './chat';

vi.mock('../components/conversation/conversation-pane', () => ({
  ConversationPane: () => <div data-testid="conversation" />,
}));

vi.mock('../components/side-pane/chat-side-pane', () => ({
  ChatSidePane: () => <aside data-testid="side-pane" />,
  useSidePaneHost: vi.fn(),
}));

describe('ChatPage layout host', () => {
  it('lets the conversation consume all width until a side pane is rendered', () => {
    const html = renderToStaticMarkup(<ChatPage initialSessionId="session-1" />);

    expect(html).toContain('class="min-w-0 flex-1"');
    expect(html.indexOf('data-testid="conversation"')).toBeLessThan(html.indexOf('data-testid="side-pane"'));
  });
});
