/**
 * @vitest-environment happy-dom
 */

/**
 * The browser editor: Markdown in and out unchanged, and the three menus (`/`, `[[`, `@`) write
 * what the server reads (blocks, `[Title](#/knowledge/<id>)`, `[@Name](member:<id>)`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BLOCKS, createDocEditor, filterBlocks, type DocEditor, type SuggestionView } from './editor.js';

const member = 'mbr_01JABCDEFGHJKMNPQRSTVWXYZ0';
const doc = 'doc_01JABCDEFGHJKMNPQRSTVWXYZ0';
const file = 'fil_01JABCDEFGHJKMNPQRSTVWXYZ0';

const blocks = BLOCKS.map((id) => ({ id, label: id === 'heading2' ? '标题 2' : id, keywords: id }));

let open: DocEditor | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
  document.body.innerHTML = '';
});

function make(markdown = '', overrides: Partial<Parameters<typeof createDocEditor>[0]> = {}) {
  const element = document.createElement('div');
  document.body.append(element);
  const menus: Array<SuggestionView | null> = [];
  const editor = createDocEditor({
    element,
    markdown,
    placeholder: 'Write here',
    uploadingLabel: 'Uploading',
    blocks,
    findDocs: async (query) => [{ id: doc, title: query ? `Plan ${query}` : 'Plan' }],
    findMembers: async () => [{ id: member, name: 'Mei' }],
    uploadImage: async () => `/api/files/${file}/content?sig=abc`,
    requestImage: vi.fn(),
    onSuggest: (view) => menus.push(view),
    ...overrides,
  });
  open = editor;
  return { editor, menus, element, last: () => menus[menus.length - 1] ?? null };
}

/** Lets the suggestion plugin find its items (it awaits them, and some are debounced). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

describe('createDocEditor', () => {
  it('gives back the Markdown it was given', () => {
    const markdown = [
      '# Plan',
      '',
      `Ask [@Mei](member:${member}) about [Launch](#/knowledge/${doc}), ~~not~~ **now**.`,
      '',
      '| Owner | Due |',
      '| --- | --- |',
      '| Mei | Friday |',
      '',
      '```bash',
      'pnpm install',
      '```',
      '',
      `![chart](/api/files/${file}/content)`,
    ].join('\n');
    const { editor } = make(markdown);
    expect(editor.markdown()).toBe(markdown);
    // And again: saving twice changes nothing.
    const again = make(editor.markdown());
    expect(again.editor.markdown()).toBe(markdown);
  });

  it('shows the placeholder only while the doc is empty', () => {
    const { editor, element } = make('');
    expect(element.querySelector('[data-placeholder="Write here"]')).not.toBeNull();
    editor.editor.commands.insertContent('Hello');
    expect(element.querySelector('[data-placeholder]')).toBeNull();
  });

  it('`/` offers the blocks matching what follows it and turns the line into one', async () => {
    const { editor, last } = make('');
    editor.editor.commands.insertContent('/标题');
    await settle();
    expect(last()).toMatchObject({ kind: 'block', query: '标题' });
    expect(last()!.items.map((item) => (item as { id: string }).id)).toEqual(['heading2']);
    editor.choose(0);
    editor.editor.commands.insertContent('Goals');
    expect(editor.markdown()).toBe('## Goals');
    expect(last()).toBeNull();
  });

  it('the `/` picture block asks the app for a file', async () => {
    const requestImage = vi.fn();
    const { editor } = make('', { requestImage });
    editor.editor.commands.insertContent('/image');
    await settle();
    editor.choose(0);
    expect(requestImage).toHaveBeenCalledOnce();
    expect(editor.markdown()).toBe('');
  });

  it('`[[` links a doc the way backlinks are read', async () => {
    const findDocs = vi.fn(async (query: string) => [{ id: doc, title: `Launch ${query}`.trim() }]);
    const { editor, last } = make('See', { findDocs });
    editor.editor.commands.focus('end');
    editor.editor.commands.insertContent(' [[road');
    await settle();
    expect(findDocs).toHaveBeenLastCalledWith('road', expect.anything());
    expect(last()).toMatchObject({ kind: 'doc', query: 'road' });
    editor.choose(0);
    expect(editor.markdown()).toBe(`See [Launch road](#/knowledge/${doc})`);
  });

  it('`@` mentions a member the way notifications are read', async () => {
    const { editor, last } = make('Ask');
    editor.editor.commands.focus('end');
    editor.editor.commands.insertContent(' @me');
    await settle();
    expect(last()).toMatchObject({ kind: 'mention', query: 'me' });
    editor.choose(0);
    expect(editor.markdown()).toBe(`Ask [@Mei](member:${member})`);
  });

  it('arrows move the highlight and the app can move it too', async () => {
    const { editor, last } = make('');
    editor.editor.commands.insertContent('/');
    await settle();
    expect(last()).toMatchObject({ kind: 'block', active: 0 });
    editor.highlight(2);
    expect(last()).toMatchObject({ active: 2 });
  });

  it('puts an uploaded picture where it was dropped, and nothing when the upload failed', async () => {
    const { editor } = make('Before');
    editor.editor.commands.focus('end');
    editor.insertImages([new File([new Uint8Array([1])], 'chart.png', { type: 'image/png' })]);
    await settle();
    expect(editor.markdown()).toBe(`Before\n\n![chart](/api/files/${file}/content?sig=abc)`);

    const failing = make('Text', { uploadImage: async () => null });
    failing.editor.insertImages([new File([new Uint8Array([1])], 'x.png', { type: 'image/png' })]);
    await settle();
    expect(failing.editor.markdown()).toBe('Text');
    expect(failing.element.querySelector('.kb-uploading')).toBeNull();
  });
});

describe('filterBlocks', () => {
  it('matches labels, ids and keywords, and keeps the order', () => {
    expect(filterBlocks(blocks, '').length).toBe(BLOCKS.length);
    expect(filterBlocks(blocks, 'LIST').map((block) => block.id)).toEqual(['bulletList', 'orderedList']);
    expect(filterBlocks(blocks, 'nothing like it')).toEqual([]);
  });
});
