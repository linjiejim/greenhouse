/**
 * @vitest-environment happy-dom
 *
 * The conversations sidebar is one list (spec 20261011-agent-first-class §3.1): with Agent
 * threads, the chats panel carries the threads and the Background group above the chats, one
 * search box feeds every section, and each section owns its actions; without them it
 * is just the chats, as before. The chats panel itself is stubbed here — its own tests cover it.
 */

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../lib/i18n';
import { useAuthStore } from '../../../stores';
import { useBotsStore } from '../../bots/bots-store';
import { ConversationsSidebarPanel } from './conversations-panel';

interface StubProps {
  leading?: ReactNode;
  chatsTitle?: string;
  searchPlaceholder?: string;
  onQueryChange?: (query: string) => void;
  agentChats?: { currentId: string | null; onOpen: (sessionId: string) => void };
}

vi.mock('./chat-history-panel', () => ({
  ChatHistoryPanel: (props: StubProps) =>
    createElement(
      'div',
      {
        'data-testid': 'chats',
        'data-title': props.chatsTitle ?? '',
        'data-placeholder': props.searchPlaceholder ?? '',
        'data-agent-chats': props.agentChats ? `current:${props.agentChats.currentId ?? ''}` : '',
      },
      createElement('button', {
        'data-testid': 'open-agent-chat',
        onClick: () => props.agentChats?.onOpen('task-1'),
      }),
      createElement('input', {
        'data-testid': 'search',
        onChange: (event: { target: { value: string } }) => props.onQueryChange?.(event.target.value),
      }),
      createElement('div', { 'data-testid': 'leading' }, props.leading ?? null),
    ),
}));
vi.mock('../../bots/bots-sidebar-panel', () => ({
  BotsThreadsSection: ({ query }: { query: string }) => createElement('div', { 'data-testid': 'threads' }, query),
}));
vi.mock('../../bots/background-tasks-section', () => ({
  BackgroundTasksSection: ({ query }: { query: string }) =>
    createElement('div', { 'data-testid': 'background' }, query),
}));
vi.mock('../../bots/bots-dialogs', () => ({
  BotsDialogs: () => createElement('div', { 'data-testid': 'bots-dialogs' }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useBotsStore.setState({ ...useBotsStore.getInitialState() });
});

function mount(features: Record<string, boolean>, hostDialogs = false) {
  useAuthStore.setState({ currentUser: { id: 'u1', role: 'team', nickname: 'Mia', features } as never });
  act(() =>
    root.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ConversationsSidebarPanel, {
          currentSessionId: null,
          onSelectSession: () => {},
          hostDialogs,
        }),
      }),
    ),
  );
}

const get = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

describe('<ConversationsSidebarPanel/>', () => {
  it('with Agent threads: threads + Background above the chats, one search for all, no unrelated actions beside search', () => {
    mount({ bots: true });
    const chats = get('chats')!;
    expect(chats.dataset.title).toBe('Chats');
    expect(chats.dataset.placeholder).toBe('Search…');
    expect(get('leading')!.querySelector('[data-testid="threads"]')).not.toBeNull();
    expect(get('leading')!.querySelector('[data-testid="background"]')).not.toBeNull();

    const input = get('search') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sage');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(get('threads')!.textContent).toBe('sage');
    expect(get('background')!.textContent).toBe('sage');

    expect(host.querySelector('button[aria-label="New Agent"]')).toBeNull();
  });

  it('lists separate Agent chats among the chats, highlighted and opened at their own address', async () => {
    const settleHash = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    window.location.hash = '#/bots?c=task-1';
    await settleHash();
    mount({ bots: true });
    expect(get('chats')!.dataset.agentChats).toBe('current:task-1');
    window.location.hash = '#/chat';
    await settleHash();
    act(() => get('open-agent-chat')!.click());
    await settleHash();
    expect(window.location.hash).toBe('#/bots?c=task-1');
    expect(get('chats')!.dataset.agentChats).toBe('current:task-1');
  });

  it('hosts the "new Agent" dialog only where the threads page does not (the chats route)', () => {
    mount({ bots: true }, false);
    expect(get('bots-dialogs')).toBeNull();
    mount({ bots: true }, true);
    expect(get('bots-dialogs')).not.toBeNull();
  });

  it('without Agent threads it is just the chats', () => {
    mount({ bots: false }, true);
    const chats = get('chats')!;
    expect(chats.dataset.title).toBe('');
    expect(chats.dataset.placeholder).toBe('');
    expect(chats.dataset.agentChats).toBe('');
    expect(get('threads')).toBeNull();
    expect(get('background')).toBeNull();
    expect(host.querySelector('button[aria-label="New Agent"]')).toBeNull();
    expect(get('bots-dialogs')).toBeNull();
  });
});
