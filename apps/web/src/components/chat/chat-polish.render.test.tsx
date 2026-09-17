import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Profile } from '../../lib/api';
import { I18nProvider } from '../../lib/i18n';
import { MessageBubble } from './message';
import { NoteInputDialog } from './note-input-dialog';
import { AgentIdentity } from './agent-avatar-picker';
import { ReasoningToggle } from './reasoning-panel';

vi.mock('../rich-markdown', () => ({
  RichMarkdown: ({ content }: { content: string }) => createElement('p', null, content),
}));

vi.mock('./user-message-content', () => ({
  UserMessageContent: ({ content }: { content: string }) => createElement('p', null, content),
}));

function inEnglish(node: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'en', children: node }));
}

describe('chat presentation polish', () => {
  it('keeps completed thinking and live paragraphs free of a token-by-token side preview', () => {
    const live = inEnglish(
      createElement(ReasoningToggle, {
        reasoning: 'Completed paragraph\n\nCurrent paragraph',
        expanded: false,
        active: true,
        onToggle: vi.fn(),
      }),
    );
    const done = inEnglish(
      createElement(ReasoningToggle, {
        reasoning: 'Completed paragraph\n\nFinal paragraph',
        expanded: false,
        active: false,
        onToggle: vi.fn(),
      }),
    );

    expect(live).toContain('Thinking…');
    expect(live).toContain('Completed paragraph');
    expect(live).not.toContain('Current paragraph');
    expect(done).toContain('Thought');
    expect(done).not.toContain('Thinking…');
    expect(done).not.toContain('Final paragraph');
  });

  it('hides reference chips until the references control is expanded', () => {
    const html = inEnglish(
      createElement(MessageBubble, {
        role: 'assistant',
        content: 'Answer',
        references: [{ slug: 'secret-source', title: 'Hidden source', type: 'wiki' }],
      }),
    );

    expect(html).toContain('Show all 1 references');
    expect(html).not.toContain('Hidden source');
  });

  it('uses the shared muted surface for user turns without a bright primary outline', () => {
    const html = inEnglish(createElement(MessageBubble, { role: 'user', content: 'A quieter bubble' }));

    expect(html).toContain('bg-surface-muted');
    expect(html).toContain('border-edge');
    expect(html).not.toContain('border-primary-edge');
  });

  it('does not add a standalone analyzed-image badge above the tool trace', () => {
    const html = inEnglish(
      createElement(MessageBubble, {
        role: 'assistant',
        content: 'Done',
        pipeline: [{ tool: 'analyze_image', input: {}, output: { ok: true }, duration_ms: 10, step: 1 }],
      }),
    );

    expect(html).not.toContain('Analyzed image');
  });

  it('renders a durable Mission outcome as a continuation inside its dispatch turn', () => {
    const html = inEnglish(
      createElement(MessageBubble, {
        role: 'assistant',
        content: 'Task ready',
        missionOutcome: {
          messageId: 'cloud-agent-outcome:car_1',
          content: 'Mission done',
          createdAt: '2026-08-13T07:05:00Z',
        },
      }),
    );

    expect(html).toContain('data-mission-outcome-continuation="true"');
    expect(html).toContain('Result');
    expect(html).toContain('Task ready');
    expect(html).toContain('Mission done');
  });

  it('fails closed on token, timing and cost metrics unless the caller is super', () => {
    const hidden = inEnglish(
      createElement(MessageBubble, {
        role: 'assistant',
        content: 'Done',
        model: 'flash',
        inputTokens: 38_079,
        outputTokens: 876,
        durationMs: 11_090,
      }),
    );
    const visible = inEnglish(
      createElement(MessageBubble, {
        role: 'assistant',
        content: 'Done',
        model: 'flash',
        inputTokens: 38_079,
        outputTokens: 876,
        durationMs: 11_090,
        canViewMetrics: true,
      }),
    );

    expect(hidden).not.toContain('flash');
    expect(hidden).not.toContain('11.09s');
    // The collapsed footer shows elapsed time, while the exact model name is
    // reserved for the super-only expanded diagnostics.
    expect(visible).not.toContain('flash');
    expect(visible).toContain('11.09s');
    expect(visible).toContain('message-actions-host');
    expect(visible).toContain('message-hover-actions');
  });

  it('uses a one-line, three-line-capped annotation composer', () => {
    const html = inEnglish(
      createElement(NoteInputDialog, {
        quote: 'Selected quote',
        anchorRect: { top: 20, right: 120 } as DOMRect,
        onSubmit: vi.fn(),
        onDismiss: vi.fn(),
      }),
    );

    expect(html).toContain('rows="1"');
    expect(html).toContain('max-h-[72px]');
    expect(html).toContain('h-9 w-9');
  });

  it('shows the chosen coworker identity in existing conversations without a picker', () => {
    const profiles = [
      { id: 'sprouty', name: 'Sprouty' },
      { id: 'custom:1', name: 'Analyst' },
    ] as Profile[];
    const html = inEnglish(createElement(AgentIdentity, { profiles, profileId: 'custom:1@2' }));
    expect(html).toContain('title="Analyst"');
    expect(html).not.toContain('<button');
  });
});
