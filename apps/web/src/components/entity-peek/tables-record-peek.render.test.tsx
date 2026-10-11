/** @vitest-environment happy-dom */

/**
 * The `tables_record` peek: a Tables record link opens the record drawer's own
 * content (Fields + Activity) in the peek frame — read-only, without the
 * drawer's close button (the frame has one) — and "not found" for a record the
 * viewer cannot read.
 */

import { act, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import type { TableRecord, TableSchema } from '../../lib/api/tables';
import { renderEntityPeekBody } from './registry';

const api = vi.hoisted(() => ({
  getTableSchema: vi.fn(),
  getTableRecord: vi.fn(),
  listTableUsers: vi.fn(),
  listTableRecordActivity: vi.fn(),
}));
vi.mock('../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/tables')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stamp = '2026-10-11T08:00:00.000Z';
const schema: TableSchema = {
  table: {
    id: 7,
    base_id: 3,
    name: 'Deals',
    description: null,
    position: 0,
    schema_revision: 1,
    created_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    archived_at: null,
  },
  fields: [
    {
      id: 1,
      table_id: 7,
      name: 'Name',
      type: 'text',
      required: true,
      is_primary: true,
      config: '{}',
      position: 0,
      created_by: 'u1',
      created_at: stamp,
      updated_at: stamp,
      archived_at: null,
    },
  ],
  views: [],
};
const record: TableRecord = {
  id: 42,
  table_id: 7,
  values: { 1: 'Acme Ltd' },
  computed_values: {},
  revision: 2,
  created_by: 'u1',
  updated_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
  deleted_at: null,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function flush() {
  for (let index = 0; index < 10; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountPeek() {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <Suspense fallback={<span>loading</span>}>
          {renderEntityPeekBody({ kind: 'tables_record', baseId: 3, tableId: 7, id: 42 })}
        </Suspense>
      </I18nProvider>,
    );
  });
  // The body is lazy: wait for its module graph, then for its requests.
  for (let tries = 0; tries < 200 && container.textContent?.includes('loading'); tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  await flush();
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getTableSchema.mockResolvedValue(schema);
  api.getTableRecord.mockResolvedValue(record);
  api.listTableUsers.mockResolvedValue([{ id: 'u1', nickname: 'Jim', email: 'jim@example.com', role: 'team' }]);
  api.listTableRecordActivity.mockResolvedValue({
    items: [],
    nextCursor: null,
    viewer: { userId: 'u1', canComment: true, canModerate: false },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

describe('Tables record peek', () => {
  it('shows the record drawer content, read-only, with its Activity tab', async () => {
    await mountPeek();
    expect(api.getTableRecord).toHaveBeenCalledWith(7, 42);
    expect(container.textContent).toContain('Record #42');
    expect(container.textContent).toContain('Acme Ltd');
    expect(container.querySelector('[aria-label="Edit record"]')).toBeNull();
    expect(container.querySelector('[aria-label="Close record details"]')).toBeNull();

    const activityTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) =>
      tab.textContent?.includes('Activity'),
    );
    expect(activityTab).toBeDefined();
    await act(async () => activityTab!.click());
    await flush();
    expect(api.listTableRecordActivity).toHaveBeenCalledWith(7, 42);
    expect(container.querySelector('textarea')).not.toBeNull();
  });

  it('says "not found" for a record the viewer cannot read', async () => {
    api.getTableRecord.mockRejectedValue(new Error('Record not found'));
    await mountPeek();
    expect(container.textContent).toContain("Not found, or you don't have access to it.");
  });
});
