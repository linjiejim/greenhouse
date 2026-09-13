import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Search } from '../lib/icons';
import { Button, EmptyState } from './ui';

describe('EmptyState', () => {
  it('uses the standard section rhythm and accessible labelling by default', () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        icon: Search,
        title: 'No results',
        description: 'Try another search.',
      }),
    );

    expect(html).toContain('data-empty-state="section"');
    expect(html).toContain('py-14');
    expect(html).toContain('bg-primary-subtle');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('aria-hidden="true"');
  });

  it('keeps overlay empty states compact and visually neutral', () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        icon: Search,
        title: 'No notifications',
        variant: 'compact',
        tone: 'neutral',
      }),
    );

    expect(html).toContain('data-empty-state="compact"');
    expect(html).toContain('py-8');
    expect(html).toContain('h-10');
    expect(html).toContain('bg-surface-muted');
    expect(html).not.toContain('aria-describedby=');
  });

  it('renders a page reading height and keeps contextual actions inside the component', () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        icon: Search,
        title: 'Content unavailable',
        variant: 'page',
        tone: 'danger',
        action: createElement(Button, { size: 'sm' }, 'Try again'),
      }),
    );

    expect(html).toContain('data-empty-state="page"');
    expect(html).toContain('min-h-[min(28rem,55dvh)]');
    expect(html).toContain('bg-danger-subtle');
    expect(html).toContain('Try again');
    expect(html).toContain('mt-4 flex flex-wrap');
  });
});
