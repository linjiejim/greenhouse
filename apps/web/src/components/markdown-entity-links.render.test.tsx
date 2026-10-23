/**
 * @vitest-environment happy-dom
 *
 * How rendered Markdown classifies links.
 *
 * Needs a real DOM: the sanitizer parses marked's HTML with `DOMParser` and
 * rewrites nodes, which is exactly the step under test here.
 *
 * Three outcomes, and getting them wrong is user-visible in different ways: a
 * record reference that is not recognised navigates the reader out of their
 * chat; an ordinary link mistaken for a record opens an overlay that can never
 * load; and a chat link without `target` costs the conversation.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, beforeEach } from 'vitest';
import { Markdown } from './markdown';
import { useEntityPeekStore } from '../stores/entity-peek-store';

function render(content: string, linkTarget?: 'in-place' | 'new-window') {
  return renderToStaticMarkup(createElement(Markdown, { content, linkTarget }));
}

function anchor(html: string): string {
  const match = html.match(/<a[^>]*>/);
  if (!match) throw new Error(`no anchor in markup: ${html}`);
  return match[0];
}

describe('markdown link classification', () => {
  it('tags record references and leaves them navigable for cmd-click', () => {
    const tag = anchor(render('See [Website relaunch](#/projects/42) for details.'));
    expect(tag).toContain('entity-link');
    expect(tag).toContain('data-entity-kind="project"');
    expect(tag).toContain('data-entity-label="Website relaunch"');
    expect(tag).toContain('href="#/projects/42"');
    // Never a new tab: a plain click is intercepted into a peek instead.
    expect(tag).not.toContain('target=');
  });

  it('recognises every linkable kind', () => {
    const cases: Array<[string, string]> = [
      ['#/projects/4', 'project'],
      ['#/knowledge/doc/5-brand-logo', 'kb_doc'],
      ['#/tables/1/table/2?record=3', 'tables_record'],
    ];
    for (const [href, kind] of cases) {
      expect(anchor(render(`[x](${href})`))).toContain(`data-entity-kind="${kind}"`);
    }
  });

  it('rescues a record link the model wrote without the leading #', () => {
    const tag = anchor(render('[Relaunch](/projects/42)'));
    expect(tag).toContain('data-entity-kind="project"');
    expect(tag).toContain('href="#/projects/42"');
    // The bug this replaces: treated as external, so it opened a new tab at a
    // path the hash router does not serve.
    expect(tag).not.toContain('target=');
  });

  it('leaves list routes and other in-app links alone', () => {
    for (const href of ['#/projects', '#/knowledge', '#/projects/abc']) {
      const tag = anchor(render(`[x](${href})`));
      expect(tag).not.toContain('entity-link');
      expect(tag).not.toContain('data-entity-kind');
    }
  });

  it('opens plain links in a new window only on chat surfaces', () => {
    expect(anchor(render('[docs](#/knowledge)', 'in-place'))).not.toContain('target=');
    expect(anchor(render('[docs](#/knowledge)', 'new-window'))).toContain('target="_blank"');
    // External links open in a new tab either way.
    expect(anchor(render('[site](https://example.com)', 'in-place'))).toContain('target="_blank"');
    expect(anchor(render('[site](https://example.com)', 'new-window'))).toContain('target="_blank"');
  });

  it('still renders @-mentions as inert chips', () => {
    const tag = anchor(render('[@Jim](user:abc)'));
    expect(tag).toContain('kb-mention');
    expect(tag).toContain('href="#"');
  });

  it('does not turn javascript: links into records', () => {
    const tag = anchor(render('[x](javascript:alert(1))'));
    expect(tag).not.toContain('entity-link');
    expect(tag).toContain('href="#"');
  });
});

describe('entity peek stack', () => {
  beforeEach(() => useEntityPeekStore.getState().close());

  it('pushes, drills down, and pops back', () => {
    const { openEntity, back } = useEntityPeekStore.getState();
    openEntity({ ref: { kind: 'project', id: 1 }, label: 'Acme' });
    expect(useEntityPeekStore.getState().stack).toHaveLength(1);

    openEntity({ ref: { kind: 'kb_doc', id: 9, slug: 'notes' } });
    expect(useEntityPeekStore.getState().stack).toHaveLength(2);

    back();
    expect(useEntityPeekStore.getState().stack).toHaveLength(1);
    expect(useEntityPeekStore.getState().stack[0].label).toBe('Acme');
  });

  it('ignores a re-click on the record already on top', () => {
    const { openEntity } = useEntityPeekStore.getState();
    openEntity({ ref: { kind: 'project', id: 3 } });
    openEntity({ ref: { kind: 'project', id: 3 } });
    expect(useEntityPeekStore.getState().stack).toHaveLength(1);
  });

  it('closing clears the whole stack', () => {
    const { openEntity, close } = useEntityPeekStore.getState();
    openEntity({ ref: { kind: 'project', id: 1 } });
    openEntity({ ref: { kind: 'project', id: 2 } });
    close();
    expect(useEntityPeekStore.getState().stack).toEqual([]);
  });
});
