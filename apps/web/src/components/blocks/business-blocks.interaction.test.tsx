/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { RichMarkdown } from '../rich-markdown';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mountedRoot: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (mountedRoot) await act(async () => mountedRoot?.unmount());
  container?.remove();
  mountedRoot = null;
  container = null;
});

const fence = (type: string, payload: unknown) => `\`\`\`${type}\n${JSON.stringify(payload)}\n\`\`\``;

async function render(content: string, props: { onConfirmAction?: (v: string) => void; resolved?: string } = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  mountedRoot = createRoot(container);
  await act(async () => {
    mountedRoot?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(RichMarkdown, {
          compact: true,
          content,
          onConfirmAction: props.onConfirmAction,
          resolvedConfirmValue: props.resolved,
        }),
      }),
    );
  });
  return container;
}

const actions = [
  { label: 'By industry', value: 'Split October customers by industry', variant: 'primary' },
  { label: 'By region', value: 'Split October customers by region' },
];

describe('stats / cards / steps blocks', () => {
  it('draws stats with direction and colour apart, and sends a button as the next message', async () => {
    const onAction = vi.fn();
    const root = await render(
      'Here is October.\n\n' +
        fence('stats', {
          title: 'October',
          items: [
            { label: 'Cost', value: 12000, unit: '$', delta: '+8%', trend: 'up', tone: 'negative' },
            { label: 'Customers', value: 128, delta: '+12%', trend: 'up', tone: 'positive', hint: 'vs Sep' },
          ],
          actions,
        }),
      { onConfirmAction: onAction },
    );
    const stats = root.querySelector('[data-testid="rich-stats"]')!;
    expect(stats.textContent).toContain('12,000$');
    expect(stats.textContent).toContain('vs Sep');
    expect(stats.querySelector('.text-danger')?.textContent).toContain('+8%');
    expect(stats.querySelector('.text-success')?.textContent).toContain('+12%');

    const buttons = Array.from(root.querySelectorAll('button')).filter((b) => b.textContent?.startsWith('By '));
    await act(async () => buttons[0]!.click());
    expect(onAction).toHaveBeenCalledWith('Split October customers by industry');
    await act(async () => buttons[1]!.click());
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  it('keeps buttons unchosen while no send can be accepted, and commits once it can', async () => {
    const content = fence('stats', { items: [{ label: 'Customers', value: 128 }], actions });
    // a reply is running: the pane passes no sender
    const root = await render(content);
    const buttons = () => Array.from(root.querySelectorAll('button')).filter((b) => b.textContent?.startsWith('By '));
    expect(buttons().every((b) => b.disabled)).toBe(true);
    await act(async () => buttons()[0]!.click());
    expect(root.querySelector('button[aria-pressed="true"]')).toBeNull();

    // the reply finished: the same block takes the press
    const onAction = vi.fn();
    await act(async () => {
      mountedRoot?.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(RichMarkdown, { compact: true, content, onConfirmAction: onAction }),
        }),
      );
    });
    expect(buttons().every((b) => !b.disabled)).toBe(true);
    await act(async () => buttons()[1]!.click());
    expect(onAction).toHaveBeenCalledWith('Split October customers by region');
    expect(root.querySelector('button[aria-pressed="true"]')?.textContent).toBe('By region');
  });

  it('shows the pressed button from the follow-up message after a reload', async () => {
    const root = await render(fence('steps', { items: [{ title: 'Review', status: 'done' }], actions }), {
      onConfirmAction: vi.fn(),
      resolved: 'Split October customers by region',
    });
    const pressed = root.querySelector('button[aria-pressed="true"]');
    expect(pressed?.textContent).toBe('By region');
  });

  it('draws steps with their states and cards with links and badges', async () => {
    const root = await render(
      fence('steps', {
        title: 'Launch plan',
        items: [
          { title: 'Review', status: 'done', time: '10-02' },
          { title: 'Build', status: 'active', detail: 'front end 60%' },
          { title: 'Legal', status: 'blocked' },
        ],
      }) +
        '\n\n' +
        fence('cards', {
          items: [
            {
              title: 'Site redesign',
              url: '#/projects/42',
              subtitle: 'Owner Ann',
              badges: [{ label: '3 days late', tone: 'danger' }],
              fields: [{ label: 'Due', value: '10-15' }],
            },
            { title: 'Docs', url: 'https://example.com/docs' },
          ],
        }),
    );
    const steps = root.querySelector('[data-testid="rich-steps"]')!;
    expect(steps.textContent).toContain('In progress');
    expect(steps.textContent).toContain('Blocked');
    expect(steps.textContent).toContain('front end 60%');

    const cards = root.querySelector('[data-testid="rich-cards"]')!;
    const links = Array.from(cards.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#/projects/42', 'https://example.com/docs']);
    expect(links[0]!.getAttribute('target')).toBeNull();
    expect(links[1]!.getAttribute('target')).toBe('_blank');
    expect(cards.textContent).toContain('3 days late');
    expect(cards.textContent).toContain('Due10-15');
  });

  it('leaves an invalid block as a code block', async () => {
    const root = await render(fence('steps', { items: [{ title: 'Build', status: 'doing' }] }));
    expect(root.querySelector('[data-testid="rich-steps"]')).toBeNull();
    expect(root.querySelector('pre')?.textContent).toContain('"doing"');
  });
});
