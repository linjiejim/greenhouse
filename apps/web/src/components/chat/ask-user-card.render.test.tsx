import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AskUserCard } from './ask-user-card';

describe('AskUserCard submitted summary', () => {
  it('uses the semantic card surface while the question is active', () => {
    const html = renderToStaticMarkup(
      createElement(AskUserCard, {
        data: {
          type: 'ask_user',
          status: 'pending',
          title: 'Project background',
          questions: [{ id: 'goal', label: 'What is the goal?', type: 'text' }],
        },
        onSubmit: vi.fn(),
      }),
    );

    expect(html).toContain('data-chat-artifact-card="true"');
    expect(html).toContain('rounded-lg');
    expect(html).toContain('bg-surface-sunken');
  });

  it('collapses submitted choices into a compact durable receipt', () => {
    const html = renderToStaticMarkup(
      createElement(AskUserCard, {
        data: {
          type: 'ask_user',
          status: 'done',
          title: 'Project background',
          questions: [
            {
              id: 'direction',
              label: 'Which direction?',
              type: 'single_choice',
              options: [
                { value: 'product', label: 'Product' },
                { value: 'research', label: 'Research' },
              ],
            },
            {
              id: 'goal',
              label: 'What is the goal?',
              type: 'text',
            },
          ],
        },
        onSubmit: vi.fn(),
        submitted: true,
        submittedMessage:
          'Here are my answers to your questions:\n\n**1. Which direction?**: Product\n**2. What is the goal?**: Ship this week',
      }),
    );

    expect(html).toContain('Submitted');
    expect(html).toContain('2 answers');
    expect(html).not.toContain('Which direction?');
    expect(html).not.toContain('Product');
    expect(html).not.toContain('Ship this week');
    expect(html).not.toContain('Research');
    expect(html).not.toContain('Submit answers');
  });
});
