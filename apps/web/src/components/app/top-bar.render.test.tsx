/**
 * @vitest-environment happy-dom
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { useSidePaneStore } from '../../stores/side-pane-store';
import { ChatTopBarSessionActions, EditableChatTitle, TopBar } from './top-bar';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  listSessionTags: vi.fn().mockResolvedValue([]),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderTopBar(route: 'chat' | 'projects' | 'executions' | 'tasks') {
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: 'en',
      children: createElement(TopBar, {
        route,
        onSelectSession: vi.fn(),
      }),
    }),
  );
}

describe('TopBar mobile chat actions', () => {
  beforeEach(() => {
    useSidePaneStore.setState({ stack: [], isOpen: false, hostMounted: false });
  });

  it('shows mobile session history without the global Assistant action', () => {
    const html = renderTopBar('chat');

    expect(html).toContain('aria-label="Session history"');
    expect(html).toContain('aria-label="Open side panel"');
    expect(html).not.toContain('aria-label="Assistant"');
  });

  it('keeps the history shortcut scoped to Chat', () => {
    const html = renderTopBar('projects');

    expect(html).not.toContain('aria-label="Session history"');
  });

  it('names the durable work page Execution Center rather than the prompt library', () => {
    const html = renderTopBar('executions');
    expect(html).toContain('>Execution Center<');
    expect(html).not.toContain('>Prompts<');
  });

  it('names the independent prompt library Tasks', () => {
    expect(renderTopBar('tasks')).toContain('>Tasks<');
  });

  it('renders sharing as an icon-only conversation action', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ChatTopBarSessionActions, {
          feedback: null,
          share: { shareCount: 2, onOpen: vi.fn() },
        }),
      }),
    );

    const shareButton = html.match(/<button[^>]*aria-label="Share this conversation"[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(shareButton).not.toBe('');
    expect(shareButton).not.toContain('>Share<');
    expect(shareButton).toContain('>2<');
  });

  it('keeps TopBar feedback to the single Star entry', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ChatTopBarSessionActions, {
          feedback: {
            sessionId: 'session-1',
            initialRating: null,
            initialComment: null,
            readonly: false,
          },
          share: null,
        }),
      }),
    );

    expect(html).toContain('aria-label="Rate this response"');
    expect(html).not.toContain('aria-label="Good response"');
    expect(html).not.toContain('aria-label="Bad response"');
  });

  it('edits a saved conversation title inline and commits on Enter', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(EditableChatTitle, {
            title: 'Ocean image',
            controls: { readonly: false, onRename },
          }),
        }),
      );
    });

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Rename"]')?.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename"]');
    expect(input).not.toBeNull();
    await act(async () => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Ocean research');
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    await act(async () => {
      if (!input) return;
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(onRename).toHaveBeenCalledWith('Ocean research');
    await act(async () => root.unmount());
    container.remove();
  });

  it('collapses and restores retained side-pane content from the chat toolbar', async () => {
    useSidePaneStore.getState().open({ kind: 'html', code: '<p>Preview</p>' });
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = async () => {
      await act(async () => {
        root.render(
          createElement(I18nProvider, {
            initialLocale: 'en',
            children: createElement(TopBar, { route: 'chat', onSelectSession: vi.fn() }),
          }),
        );
      });
    };
    await render();
    expect(container.innerHTML).toContain('aria-label="Collapse side panel"');

    await act(async () => useSidePaneStore.getState().collapse());
    expect(container.innerHTML).toContain('aria-label="Open side panel"');
    await act(async () => root.unmount());
  });

  it('opens an empty side pane before the conversation supplies content', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(TopBar, { route: 'chat', onSelectSession: vi.fn() }),
        }),
      );
    });

    const openButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open side panel"]');
    expect(openButton).not.toBeNull();
    await act(async () => openButton?.click());
    expect(useSidePaneStore.getState().isOpen).toBe(true);
    expect(container.innerHTML).toContain('aria-label="Collapse side panel"');
    await act(async () => root.unmount());
  });
});
