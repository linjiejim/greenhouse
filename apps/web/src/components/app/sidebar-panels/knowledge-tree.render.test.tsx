/**
 * @vitest-environment happy-dom
 *
 * What the knowledge sidebar tree shows on the very first render.
 *
 * That first render is the whole point of the collapsed default: a deep tree
 * used to arrive fully expanded and stretch the sidebar into a long scroll.
 * Static markup is enough — the initial state is read straight from storage — so
 * these assertions cost a render and nothing else. `localStorage` has to be
 * real, since it is what decides the state.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../lib/i18n';
import type { DriveFolder } from '../../../lib/api/drive';
import type { KnowledgeDoc } from '@greenhouse/types/api';
import { KnowledgeTree } from './knowledge-nav-panel';
import { expandedKey, legacyCollapsedKey } from './knowledge-tree-expansion';

const folder = (id: number, name: string, parent_id: number | null = null): DriveFolder =>
  ({ id, name, parent_id, scope: 'kb', visibility: 'team' }) as DriveFolder;

const doc = (id: number, title: string, folder_id: number | null): KnowledgeDoc =>
  ({ id, title, slug: `doc-${id}`, visibility: 'team', folder_id, status: 'published' }) as KnowledgeDoc;

// brand ─ guidelines ─ "Nested doc"
//       └ "Guideline doc"
// "Root doc"
const FOLDERS = [folder(1, 'brand'), folder(2, 'guidelines', 1), folder(3, 'empty')];
const DOCS = [doc(10, 'Root doc', null), doc(11, 'Guideline doc', 1), doc(12, 'Nested doc', 2)];

function render(activeSlug: string | null = null) {
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: 'en',
      children: createElement(KnowledgeTree, {
        scope: 'team',
        folders: FOLDERS,
        docs: DOCS,
        activeSlug,
        revealFolderId: null,
        onRevealed: vi.fn(),
        onOpenDoc: vi.fn(),
        onDocMenu: vi.fn(),
        onFolderMenu: vi.fn(),
        onMoveDoc: vi.fn(),
        onMoveFolder: vi.fn(),
        onReorder: vi.fn(),
      }),
    }),
  );
}

beforeEach(() => localStorage.clear());

describe('KnowledgeTree first render', () => {
  it('collapses every folder when nothing is stored', () => {
    const html = render();

    expect(html).toContain('brand');
    expect(html).toContain('Root doc');
    expect(html).not.toContain('Guideline doc');
    expect(html).not.toContain('guidelines');
    expect(html).toContain('title="Expand"');
    expect(html).not.toContain('title="Collapse"');
    expect(html).toContain('-rotate-90');
    expect(html).toContain('lucide-folder ');
    expect(html).not.toContain('lucide-folder-open');
  });

  it('opens exactly the stored folders, one level at a time', () => {
    localStorage.setItem(expandedKey('team'), JSON.stringify([1]));
    const html = render();

    expect(html).toContain('Guideline doc');
    expect(html).toContain('guidelines');
    // `guidelines` is expanded's child, not expanded itself.
    expect(html).not.toContain('Nested doc');
    expect(html).toContain('title="Collapse"');
    expect(html).toContain('lucide-folder-open');
  });

  it('renders a chevron only for folders that have children', () => {
    localStorage.setItem(expandedKey('team'), JSON.stringify([1, 2]));
    const html = render();

    expect(html).toContain('Nested doc');
    // brand + guidelines have children; `empty` gets the spacer instead.
    expect(html.match(/lucide-chevron-down/g)).toHaveLength(2);
    expect(html).toContain('<span class="w-4 flex-shrink-0"></span>');
  });

  it('keeps a legacy browser fully expanded until the migration can run', () => {
    // Pre-flip semantics: `guidelines` was the only collapsed folder. The set
    // can't be recomputed during render, so nothing is hidden meanwhile.
    localStorage.setItem(legacyCollapsedKey('team'), JSON.stringify([2]));
    const html = render();

    expect(html).toContain('Guideline doc');
    expect(html).toContain('Nested doc');
    // The signal must survive the render — the migration effect still needs it.
    expect(localStorage.getItem(legacyCollapsedKey('team'))).toBe('[2]');
    expect(localStorage.getItem(expandedKey('team'))).toBeNull();
  });
});
