/**
 * @vitest-environment happy-dom
 *
 * Knowledge tree expansion behaviour that only exists once the component is
 * mounted — the sibling `.render.test.tsx` covers the first paint, but the parts
 * that write to storage are effects, and effects don't run in static markup.
 *
 * Three of them are worth a real mount:
 *  - the migration off the legacy key waits for the folder list (which arrives a
 *    request later) and must not persist anything before it can compute the set;
 *  - toggling has to survive a reload, which is the whole point of persisting;
 *  - a folder created inside a collapsed parent is invisible unless the parent is
 *    revealed — a regression this default introduced.
 */

import { act, createElement, useEffect, useState, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../lib/i18n';
import type { DriveFolder } from '../../../lib/api/drive';
import type { KnowledgeDoc } from '@greenhouse/types/api';
import { KnowledgeTree } from './knowledge-nav-panel';
import { expandedKey, legacyCollapsedKey } from './knowledge-tree-expansion';

// React's flag for "updates are wrapped in act()" — without it every render logs.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const folder = (id: number, name: string, parent_id: number | null = null): DriveFolder =>
  ({ id, name, parent_id, scope: 'kb', visibility: 'team' }) as DriveFolder;

const doc = (id: number, title: string, folder_id: number | null): KnowledgeDoc =>
  ({ id, title, slug: `doc-${id}`, visibility: 'team', folder_id, status: 'published' }) as KnowledgeDoc;

// brand ─ guidelines ─ "Nested doc"
const FOLDERS = [folder(1, 'brand'), folder(2, 'guidelines', 1), folder(3, 'empty')];
const DOCS = [doc(10, 'Root doc', null), doc(12, 'Nested doc', 2)];

type TreeProps = ComponentProps<typeof KnowledgeTree>;

function mount(overrides: Partial<TreeProps> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (props: Partial<TreeProps>) => {
    const merged: TreeProps = {
      scope: 'team',
      folders: FOLDERS,
      docs: DOCS,
      activeSlug: null,
      revealFolderId: null,
      onRevealed: vi.fn(),
      onOpenDoc: vi.fn(),
      onDocMenu: vi.fn(),
      onFolderMenu: vi.fn(),
      onMoveDoc: vi.fn(),
      onMoveFolder: vi.fn(),
      onReorder: vi.fn(),
      ...overrides,
      ...props,
    };
    act(() =>
      root.render(createElement(I18nProvider, { initialLocale: 'en', children: createElement(KnowledgeTree, merged) })),
    );
  };
  render({});
  return { container, rerender: render, unmount: () => act(() => root.unmount()) };
}

/** The row `<div>` of a folder, found through its truncation tooltip. */
function row(container: HTMLElement, name: string): HTMLElement {
  const label = container.querySelector(`span[title="${name}"]`);
  if (!label) throw new Error(`no row for ${name}: ${container.textContent}`);
  return label.closest('div')!;
}

function chevron(container: HTMLElement, name: string): HTMLButtonElement {
  const button = row(container, name).querySelector<HTMLButtonElement>(
    'button[title="Expand"], button[title="Collapse"]',
  );
  if (!button) throw new Error(`no chevron for ${name}`);
  return button;
}

const stored = (scope: 'team' | 'private') => localStorage.getItem(expandedKey(scope));

beforeEach(() => localStorage.clear());

describe('KnowledgeTree expansion', () => {
  it('persists a toggle in both directions', () => {
    const { container, unmount } = mount();
    expect(stored('team')).toBe('[]');

    act(() => chevron(container, 'brand').click());
    expect(JSON.parse(stored('team')!)).toEqual([1]);
    expect(container.textContent).toContain('guidelines');

    act(() => chevron(container, 'brand').click());
    expect(JSON.parse(stored('team')!)).toEqual([]);
    expect(container.textContent).not.toContain('guidelines');
    unmount();
  });

  it('waits for the folder list before migrating a legacy browser', () => {
    localStorage.setItem(legacyCollapsedKey('team'), JSON.stringify([2]));

    // The folder request hasn't come back yet: nothing may be written, and the
    // legacy key must survive — it is the only record of the old preference.
    const { container, rerender, unmount } = mount({ folders: [], docs: [] });
    expect(stored('team')).toBeNull();
    expect(localStorage.getItem(legacyCollapsedKey('team'))).toBe('[2]');

    rerender({ folders: FOLDERS, docs: DOCS });
    // Old semantics carried over: everything expanded except `guidelines`.
    expect(JSON.parse(stored('team')!).sort()).toEqual([1, 3]);
    expect(localStorage.getItem(legacyCollapsedKey('team'))).toBeNull();
    expect(container.textContent).toContain('guidelines');
    expect(container.textContent).not.toContain('Nested doc');
    unmount();

    // Migration runs once: a remount reads the new key rather than resetting it.
    const second = mount();
    expect(JSON.parse(stored('team')!).sort()).toEqual([1, 3]);
    second.unmount();
  });

  it('reveals the ancestors of a freshly created subfolder, once', () => {
    const onRevealed = vi.fn();
    const { container, rerender, unmount } = mount({ onRevealed });
    expect(container.textContent).not.toContain('guidelines');

    // A subfolder was just created under `guidelines`, two collapsed levels down.
    rerender({ revealFolderId: 2 });
    expect(onRevealed).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stored('team')!).sort()).toEqual([1, 2]);
    expect(container.textContent).toContain('Nested doc');

    // Consumed: collapsing the parent again sticks.
    rerender({ revealFolderId: null });
    act(() => chevron(container, 'brand').click());
    expect(container.textContent).not.toContain('guidelines');
    expect(onRevealed).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('reveals the ancestors of the doc the route points at', () => {
    const { container, unmount } = mount({ activeSlug: 'doc-12' });

    expect(container.textContent).toContain('Nested doc');
    expect(JSON.parse(stored('team')!).sort()).toEqual([1, 2]);
    unmount();
  });

  // Regression: while the legacy set is still resolving, `revealChain` drops the
  // request on purpose. Switching to a scope that still carries a legacy key
  // sets `ids` to null and re-runs the doc reveal in that same commit, so the
  // reveal is dropped; migration lands one commit later without re-running it.
  // A deep link into a folder the user had collapsed pre-flip then stays hidden
  // — and that hidden state is persisted under the new key.
  it('reveals the active doc after a scope switch triggers a legacy migration', () => {
    localStorage.setItem(expandedKey('team'), JSON.stringify([]));
    localStorage.setItem(legacyCollapsedKey('private'), JSON.stringify([1, 2]));

    // Start on `team`, then switch to the un-migrated `private` scope while the
    // route already points at a doc nested under a legacy-collapsed folder.
    const { container, rerender, unmount } = mount({ activeSlug: null });
    rerender({ scope: 'private', activeSlug: 'doc-12' });

    expect(container.textContent).toContain('Nested doc');
    expect(JSON.parse(stored('private')!).sort()).toEqual([1, 2, 3]);
    expect(localStorage.getItem(legacyCollapsedKey('private'))).toBeNull();
    unmount();
  });

  // Regression: the panel replaces this tree with a spinner while it refetches
  // after a folder is created (`renderTree` returns `loadingBlock` on
  // `docsLoading`). The reveal and that unmount land in the SAME commit, so a
  // reveal that only lived in component state was discarded along with the save
  // effect, and the freshly created subfolder came back hidden. This harness
  // reproduces the panel's own sequencing: set the reveal + bump the version,
  // and let a version-keyed effect flip on the spinner.
  it('keeps the reveal when the panel swaps the tree for its refetch spinner', () => {
    function Harness() {
      const [revealFolderId, setRevealFolderId] = useState<number | null>(null);
      const [version, setVersion] = useState(0);
      const [loading, setLoading] = useState(false);
      // KnowledgeNavPanel does exactly this: bump() → the docsVersion effect
      // turns on docsLoading → renderTree returns loadingBlock.
      useEffect(() => {
        if (version > 0) setLoading(true);
      }, [version]);
      return createElement(
        'div',
        null,
        createElement(
          'button',
          {
            type: 'button',
            id: 'create',
            onClick: () => {
              setRevealFolderId(2);
              setVersion((v) => v + 1);
            },
          },
          'create',
        ),
        loading
          ? createElement('div', null, 'loading…')
          : createElement(KnowledgeTree, {
              scope: 'team',
              folders: FOLDERS,
              docs: DOCS,
              activeSlug: null,
              revealFolderId,
              onRevealed: () => setRevealFolderId(null),
              onOpenDoc: vi.fn(),
              onDocMenu: vi.fn(),
              onFolderMenu: vi.fn(),
              onMoveDoc: vi.fn(),
              onMoveFolder: vi.fn(),
              onReorder: vi.fn(),
            } as TreeProps),
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(I18nProvider, { initialLocale: 'en', children: createElement(Harness) })));
    expect(container.textContent).not.toContain('guidelines');

    act(() => container.querySelector<HTMLButtonElement>('#create')!.click());
    expect(container.textContent).toContain('loading…'); // the tree is gone

    // The reveal must have outlived the unmount, or the refetched tree hides it.
    expect(JSON.parse(stored('team')!).sort()).toEqual([1, 2]);
    act(() => root.unmount());
  });

  it('keeps every scope set under its own key when the tab switches', () => {
    localStorage.setItem(expandedKey('private'), JSON.stringify([1]));
    const { container, rerender, unmount } = mount();
    expect(container.textContent).not.toContain('guidelines');

    rerender({ scope: 'private' });
    expect(container.textContent).toContain('guidelines');
    expect(JSON.parse(stored('private')!)).toEqual([1]);
    expect(JSON.parse(stored('team')!)).toEqual([]);
    unmount();
  });
});
