/** @vitest-environment happy-dom */

/**
 * The record drawer's Activity tab under real interaction: the timeline draws
 * comments and field changes with the shared FieldValue and actor badges; the
 * composer's `@` picker turns a picked person into a mention link on send;
 * the author edits and deletes their own comment and only what `viewer`
 * allows is offered; older pages load on demand and a records-changed event
 * re-reads the feed.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableRecordActivityItem,
  TableRecordActivityPage,
  TableRecordCommentView,
} from '@greenhouse/types/tables';
import { I18nProvider } from '../../../lib/i18n';
import { ToastContainer } from '../../../components/ui';
import type { TableField, TableRecord, TableUserOption } from '../../../lib/api/tables';
import { RecordActivityPanel } from './activity-panel';

const api = vi.hoisted(() => ({
  listTableRecordActivity: vi.fn(),
  createTableRecordComment: vi.fn(),
  updateTableRecordComment: vi.fn(),
  deleteTableRecordComment: vi.fn(),
}));
vi.mock('../../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api/tables')>()),
  ...api,
}));

const recordsChanged = vi.hoisted(() => ({ callback: null as null | (() => void) }));
vi.mock('../../../hooks/use-tables-records-changed', () => ({
  useTablesRecordsChanged: (_filter: unknown, onChange: () => void) => {
    recordsChanged.callback = onChange;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stamp = '2026-10-11T08:00:00.000Z';

function field(id: number, name: string, type: TableField['type'], config: unknown = {}): TableField {
  return {
    id,
    table_id: 7,
    name,
    type,
    required: false,
    is_primary: id === 1,
    config: JSON.stringify(config),
    position: id,
    created_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    archived_at: null,
  };
}

const fields = [
  field(1, 'Name', 'text'),
  field(2, 'Stage', 'single_select', {
    options: [
      { id: 'todo', label: 'To do' },
      { id: 'done', label: 'Done' },
    ],
  }),
  field(3, 'Owner', 'user'),
];

const record: TableRecord = {
  id: 42,
  table_id: 7,
  values: { 1: 'Acme' },
  computed_values: {},
  revision: 3,
  created_by: 'u3',
  updated_by: 'u2',
  created_at: stamp,
  updated_at: stamp,
  deleted_at: null,
};

const users: TableUserOption[] = [
  { id: 'u1', nickname: 'Jim', email: 'jim@example.com' },
  { id: 'u2', nickname: 'Eddie', email: 'eddie@example.com' },
  { id: 'u3', nickname: 'Fern', email: 'fern@example.com' },
];

function comment(id: number, authorId: string, body: string, edited = false): TableRecordCommentView {
  return {
    kind: 'comment',
    id,
    recordId: 42,
    authorId,
    body,
    mentions: [],
    createdAt: stamp,
    updatedAt: stamp,
    edited,
  };
}

const FEED: TableRecordActivityItem[] = [
  comment(33, 'u1', '[@Eddie](user:u2) please review', true),
  {
    kind: 'event',
    id: 12,
    recordId: 42,
    actorId: 'u2',
    actorKind: 'automation',
    type: 'updated',
    changes: [{ fieldId: 2, before: 'todo', after: 'done' }],
    meta: { ruleId: 12 },
    createdAt: stamp,
  },
  comment(31, 'u2', 'hello from Eddie'),
  {
    kind: 'event',
    id: 11,
    recordId: 42,
    actorId: 'u3',
    actorKind: 'form',
    type: 'created',
    changes: [
      { fieldId: 1, before: null, after: 'Acme' },
      { fieldId: 3, before: null, after: 'u2' },
    ],
    meta: { formId: 3 },
    createdAt: stamp,
  },
];

function page(items: TableRecordActivityItem[], extra: Partial<TableRecordActivityPage> = {}): TableRecordActivityPage {
  return {
    items,
    nextCursor: null,
    viewer: { userId: 'u1', canComment: true, canModerate: false },
    ...extra,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount() {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <RecordActivityPanel
          table={{ id: 7, base_id: 3, name: 'Deals' }}
          record={record}
          fields={fields}
          users={users}
          usersById={new Map(users.map((user) => [user.id, user]))}
          canEdit
          onRecordChanged={() => undefined}
        />
        <ToastContainer />
      </I18nProvider>,
    );
  });
  await flush();
}

function composer(): HTMLTextAreaElement {
  const all = document.querySelectorAll<HTMLTextAreaElement>('textarea');
  const el = all[all.length - 1];
  if (!el) throw new Error('no composer');
  return el;
}

async function type(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.setSelectionRange(value.length, value.length);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
  await flush();
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label,
  );
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.listTableRecordActivity.mockResolvedValue(page(FEED));
  recordsChanged.callback = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

describe('Record activity tab', () => {
  it('draws comments and field changes with the shared renderer and actor badges', async () => {
    await mount();
    expect(api.listTableRecordActivity).toHaveBeenCalledWith(7, 42);
    const text = container.textContent ?? '';
    // Field changes go through FieldValue: option labels and people's names, not raw ids.
    expect(text).toContain('Eddie changed this record');
    expect(text).toContain('To do');
    expect(text).toContain('Done');
    expect(text).toContain('Automation');
    expect(text).toContain('by rule #12');
    expect(text).toContain('Fern created this record');
    expect(text).toContain('Form');
    expect(text).toContain('via form #3');
    expect(text).toContain('Acme');
    expect(text).not.toContain('todo');
    // Comments: Markdown with mention chips, the edited marker.
    expect(container.querySelector('a.kb-mention')?.textContent).toBe('@Eddie');
    expect(text).toContain('edited');
    expect(text).toContain('hello from Eddie');
  });

  it('turns a picked @person into a mention link and shows the new comment on top', async () => {
    api.createTableRecordComment.mockResolvedValue(comment(34, 'u1', '[@Eddie](user:u2) looks good'));
    await mount();
    await type(composer(), '@Ed');
    const option = document.querySelector('[role="option"]');
    expect(option?.textContent).toContain('Eddie');
    await press(composer(), 'Enter');
    expect(composer().value).toBe('@Eddie ');
    expect(api.createTableRecordComment).not.toHaveBeenCalled();

    await type(composer(), '@Eddie looks good');
    await press(composer(), 'Enter', { ctrlKey: true });
    expect(api.createTableRecordComment).toHaveBeenCalledWith(7, 42, '[@Eddie](user:u2) looks good');
    expect(composer().value).toBe('');
    expect(container.querySelector('ol li')?.textContent).toContain('looks good');
  });

  it('lets the author edit and delete their own comment, and nothing more', async () => {
    api.updateTableRecordComment.mockResolvedValue(comment(33, 'u1', '[@Eddie](user:u2) please review now', true));
    api.deleteTableRecordComment.mockResolvedValue(undefined);
    await mount();
    // Only the viewer's own comment offers edit / delete (no moderation right).
    expect(document.querySelectorAll('[aria-label="Edit comment"]')).toHaveLength(1);
    expect(document.querySelectorAll('[aria-label="Delete comment"]')).toHaveLength(1);

    await click(button('Edit comment'));
    const editor = container.querySelector('ol textarea') as HTMLTextAreaElement;
    expect(editor.value).toBe('@Eddie please review');
    await type(editor, '@Eddie please review now');
    await click(button('Save'));
    expect(api.updateTableRecordComment).toHaveBeenCalledWith(33, '[@Eddie](user:u2) please review now');
    expect(container.textContent).toContain('please review now');

    await click(button('Delete comment'));
    await click(document.querySelector('[data-testid="confirm-dialog-confirm"]'));
    expect(api.deleteTableRecordComment).toHaveBeenCalledWith(33);
    expect(container.textContent).not.toContain('please review now');
  });

  it('cancels a comment edit on Escape without closing the drawer around it', async () => {
    await mount();
    // The drawer / peek closes on a window keydown Escape (useOverlayBehavior).
    const drawerEscape = vi.fn();
    window.addEventListener('keydown', drawerEscape);
    try {
      await click(button('Edit comment'));
      await press(container.querySelector('ol textarea') as HTMLTextAreaElement, 'Escape');
      expect(container.querySelector('ol textarea')).toBeNull();
      expect(drawerEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', drawerEscape);
    }
  });

  it('offers a moderator delete on everyone’s comments', async () => {
    api.listTableRecordActivity.mockResolvedValue(
      page(FEED, { viewer: { userId: 'u1', canComment: true, canModerate: true } }),
    );
    await mount();
    expect(document.querySelectorAll('[aria-label="Delete comment"]')).toHaveLength(2);
    expect(document.querySelectorAll('[aria-label="Edit comment"]')).toHaveLength(1);
  });

  it('hides the composer from someone who may not comment', async () => {
    api.listTableRecordActivity.mockResolvedValue(
      page(
        FEED.filter((item) => item.kind === 'event'),
        {
          viewer: { userId: 'u1', canComment: false, canModerate: false },
        },
      ),
    );
    await mount();
    expect(document.querySelector('textarea')).toBeNull();
    expect(container.textContent).toContain("You can't comment on this record.");
  });

  it('loads older activity on demand and re-reads when the record changes', async () => {
    api.listTableRecordActivity
      .mockResolvedValueOnce(page(FEED.slice(0, 2), { nextCursor: 'cursor-2' }))
      .mockResolvedValueOnce(page(FEED.slice(2)))
      .mockResolvedValueOnce(page(FEED));
    await mount();
    expect(container.textContent).not.toContain('hello from Eddie');
    await click(button('Show older activity'));
    expect(api.listTableRecordActivity).toHaveBeenLastCalledWith(7, 42, 'cursor-2');
    expect(container.textContent).toContain('hello from Eddie');
    expect(button('Show older activity')).toBeUndefined();

    await act(async () => recordsChanged.callback?.());
    await flush();
    expect(api.listTableRecordActivity).toHaveBeenCalledTimes(3);
    expect(api.listTableRecordActivity).toHaveBeenLastCalledWith(7, 42);
  });
});
