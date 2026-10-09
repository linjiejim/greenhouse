/**
 * The stats / cards / steps blocks render what the shared parser accepted, and
 * their buttons follow the one rule every block shares: a handler makes them
 * live, the member's next message marks the pressed one.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CardsBlock } from './cards-block';
import { StatsBlock } from './stats-block';
import { StepsBlock } from './steps-block';

const COPY = {
  status: { done: 'Done', active: 'In progress', pending: 'To do', blocked: 'Blocked', skipped: 'Skipped' },
};
const ACTIONS = [
  { label: 'Break down', value: 'Break it down by team' },
  { label: 'Export', value: 'Export it as CSV' },
];
const live = /<button[^>]*\sdisabled(?:=|>)/;

describe('StatsBlock', () => {
  it('formats figures and colours only what has a tone', () => {
    const html = renderToStaticMarkup(
      createElement(StatsBlock, {
        data: {
          title: 'October',
          items: [
            { label: 'Cost', value: 42000, unit: 'USD', delta: '+8%', trend: 'up', tone: 'negative' },
            { label: 'Tickets', value: 17, delta: '0', trend: 'flat' },
          ],
        },
      }),
    );
    expect(html).toContain('October');
    expect(html).toMatch(/42,000|42 000|42\.000/);
    expect(html).toContain('text-danger');
    expect(html).toContain('text-fg-muted');
  });

  it('shows the pressed button from the follow-up message', () => {
    const html = renderToStaticMarkup(
      createElement(StatsBlock, {
        data: { items: [{ label: 'a', value: 1 }], actions: ACTIONS },
        onAction: () => {},
        resolvedValue: 'Export it as CSV',
      }),
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toMatch(live);
  });

  it('restores the choice whatever whitespace the stored message kept (same rule as mobile)', () => {
    const html = renderToStaticMarkup(
      createElement(StatsBlock, {
        data: { items: [{ label: 'a', value: 1 }], actions: ACTIONS },
        onAction: () => {},
        resolvedValue: '  Export it as CSV\n',
      }),
    );
    expect(html).toContain('aria-pressed="true"');
  });
});

describe('CardsBlock', () => {
  it('makes a card a button only when the host can open it', () => {
    const data = {
      items: [{ title: 'Site redesign', url: '#/projects/42', badges: [{ label: 'Late', tone: 'danger' as const }] }],
    };
    expect(renderToStaticMarkup(createElement(CardsBlock, { data, onOpenUrl: () => {} }))).toContain('<button');
    const plain = renderToStaticMarkup(createElement(CardsBlock, { data }));
    expect(plain).not.toContain('<button');
    expect(plain).toContain('Late');
  });
});

describe('StepsBlock', () => {
  it('labels the states worth a word and tells screen readers every state', () => {
    const html = renderToStaticMarkup(
      createElement(StepsBlock, {
        copy: COPY,
        data: {
          items: [
            { title: 'Review', status: 'done', time: '10-02' },
            { title: 'Build', status: 'active' },
            { title: 'Sign-off', status: 'blocked' },
          ],
          actions: ACTIONS,
        },
        onAction: () => {},
      }),
    );
    expect(html).toContain('data-step-status="active"');
    expect(html).toContain('In progress');
    expect(html).toContain('Blocked');
    expect(html).toContain('(Done)');
    expect(html).not.toMatch(live);
  });
});
