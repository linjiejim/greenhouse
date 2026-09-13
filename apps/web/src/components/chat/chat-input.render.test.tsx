import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import type { UserPrompt } from '@greenhouse/types/api';
import { ChatInput } from './chat-input';

const task: UserPrompt = {
  id: 1,
  user_id: 'user-1',
  title: 'Market research',
  content: 'Research {{market}} for {{region}}.',
  shortcut: 'market-research',
  sort_order: 0,
  is_global: false,
  description: 'Research a market in depth.',
  variables: JSON.stringify([
    { key: 'market', label: 'Market', required: true, example: 'Smart gardens' },
    { key: 'region', label: 'Region', required: false, example: 'Europe' },
  ]),
  expected_tools: '[]',
  source_session_id: null,
  created_via: 'manual',
  created_at: '2026-08-07T00:00:00.000Z',
  updated_at: '2026-08-07T00:00:00.000Z',
};

function renderComposer() {
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: 'en',
      children: createElement(ChatInput, {
        input: '',
        setInput: vi.fn(),
        isStreaming: false,
        pendingImages: [],
        onSend: vi.fn(),
        onStop: vi.fn(),
        onImageSelect: vi.fn(),
        onRemoveImage: vi.fn(),
        rightSlot: createElement('span', null, 'Profile'),
      }),
    }),
  );
}

describe('ChatInput responsive layout', () => {
  it('places a mobile send action inside the textarea and keeps the desktop action in the toolbar', () => {
    const html = renderComposer();

    expect(html).toContain('absolute bottom-2 right-3 md:hidden');
    expect(html).toContain('pr-16');
    expect(html.match(/aria-label="Send"/g)).toHaveLength(2);
  });

  it('does not render the removed voice input control', () => {
    const html = renderComposer();

    expect(html).not.toContain('Voice input');
    expect(html).toContain('Profile');
  });

  it('keeps desktop clearance beneath the floating composer', () => {
    const html = renderComposer();

    expect(html).toContain('md:pb-4');
    expect(html).not.toContain('md:pb-0');
  });

  it('lets the mobile keyboard lift only the composer shell', () => {
    const html = renderComposer();

    expect(html).toContain('mobile-keyboard-lift');
  });

  it('draws the focus highlight around the complete composer instead of the textarea', () => {
    const html = renderComposer();

    expect(html).toContain('focus-within:border-primary-500');
    expect(html).toContain('focus-within:ring-2');
    expect(html).toContain('chat-composer-textarea');
    expect(html).toContain('focus:ring-0');
  });

  it('keeps the placeholder concise and advertises only enabled pickers', () => {
    expect(renderComposer()).toContain('placeholder="Message…"');

    const taskOnly = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ChatInput, {
          input: '',
          setInput: vi.fn(),
          isStreaming: false,
          pendingImages: [],
          onSend: vi.fn(),
          onStop: vi.fn(),
          onImageSelect: vi.fn(),
          onRemoveImage: vi.fn(),
          slashPrompts: [task],
        }),
      }),
    );
    expect(taskOnly).toContain('placeholder="Message… · / Task"');

    const agentOnly = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ChatInput, {
          input: '',
          setInput: vi.fn(),
          isStreaming: false,
          pendingImages: [],
          onSend: vi.fn(),
          onStop: vi.fn(),
          onImageSelect: vi.fn(),
          onRemoveImage: vi.fn(),
          profiles: [{ id: 'team', name: 'Sprouty', tools: [] }],
          mentionEnabled: true,
        }),
      }),
    );
    expect(agentOnly).toContain('placeholder="Message… · @ Agent"');
  });

  it('lets a shared-session host replace the send control with a Fork action', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ChatInput, {
          input: '',
          setInput: vi.fn(),
          isStreaming: false,
          pendingImages: [],
          onSend: vi.fn(),
          onStop: vi.fn(),
          onImageSelect: vi.fn(),
          onRemoveImage: vi.fn(),
          hideSendButton: true,
          placeholder: 'Fork this conversation to continue',
          rightSlot: createElement('button', null, 'Fork'),
        }),
      }),
    );

    expect(html).toContain('Fork this conversation to continue');
    expect(html).toContain('Fork');
    expect(html).not.toContain('aria-label="Send"');
  });

  it('renders a selected Task as a structured row followed by tab-ordered variable inputs', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ChatInput, {
          input: '',
          setInput: vi.fn(),
          isStreaming: false,
          pendingImages: [],
          onSend: vi.fn(),
          onStop: vi.fn(),
          onImageSelect: vi.fn(),
          onRemoveImage: vi.fn(),
          selectedPrompt: task,
          taskValues: {},
          onTaskValueChange: vi.fn(),
          onRemovePrompt: vi.fn(),
        }),
      }),
    );

    expect(html).toContain('Market research');
    expect(html).toContain('Research {{market}} for {{region}}.');
    expect(html).toContain('data-selected-task="true"');
    expect(html).toContain('data-task-variable-form="true"');
    expect(html.indexOf('data-task-variable-input="market"')).toBeLessThan(
      html.indexOf('data-task-variable-input="region"'),
    );
    expect(html.indexOf('data-task-variable-input="region"')).toBeLessThan(html.indexOf('<textarea'));
    expect(html).toContain('bottom-full');
    expect(html).toContain('aria-label="Remove Task Market research"');
    expect(html.match(/aria-label="Send"/g)).toHaveLength(2);
  });

  it('shows an explicit Mission target inside the reused composer', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ChatInput, {
          input: 'Continue with the comparison',
          setInput: vi.fn(),
          isStreaming: false,
          pendingImages: [],
          onSend: vi.fn(),
          onStop: vi.fn(),
          onImageSelect: vi.fn(),
          onRemoveImage: vi.fn(),
          missionInstruction: true,
          onRemoveMissionInstruction: vi.fn(),
        }),
      }),
    );

    expect(html).toContain('data-mission-instruction="true"');
    expect(html).toContain('Mission');
    expect(html).not.toContain('Competitor research');
    expect(html).toContain('Remove Mission instruction target');
  });
});
