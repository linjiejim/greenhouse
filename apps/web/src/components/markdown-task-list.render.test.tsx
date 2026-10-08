/**
 * @vitest-environment happy-dom
 *
 * GFM task lists survive the sanitizer as read-only checkboxes — and nothing
 * else an <input> can be does. Needs a real DOM: the sanitizer runs on
 * DOMParser output.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown';

const render = (content: string) => renderToStaticMarkup(createElement(Markdown, { content }));

describe('Markdown task lists', () => {
  it('renders - [x] / - [ ] as disabled checkboxes', () => {
    const html = render('- [x] shipped\n- [ ] verify');

    expect(html.match(/<input[^>]*>/g)).toHaveLength(2);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""[^>]*checked=""/);
    expect(html).toContain('class="task-list-checkbox"');
  });

  it('still strips every other input', () => {
    const html = render('<input type="text" value="x" onfocus="alert(1)"> <input type="checkbox" onclick="alert(1)">');

    expect(html).not.toContain('type="text"');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onfocus');
  });
});
