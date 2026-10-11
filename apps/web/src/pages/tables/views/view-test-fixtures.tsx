/**
 * Test fixtures for the view bodies: a table, fields, records, a mounted body
 * with every container callback stubbed, and the pointer gesture the drag
 * tests replay (synthetic PointerEvents — the same path a real drag takes
 * through `useDragGesture`). Imported by tests only.
 */

import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import type { TableViewConfig } from '@greenhouse/types/tables';
import { ToastContainer } from '../../../components/ui';
import { I18nProvider } from '../../../lib/i18n';
import type { TableDefinition, TableField, TableRecord, TableUserOption } from '../../../lib/api/tables';
import type { TableViewBodyProps } from './types';

const stamp = '2026-10-11T00:00:00.000Z';

export const fixtureTable: TableDefinition = {
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
};

export function fixtureField(id: number, name: string, type: TableField['type'], config: object = {}): TableField {
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

export function fixtureRecord(
  id: number,
  values: Record<string, unknown>,
  extra: Partial<TableRecord> = {},
): TableRecord {
  return {
    id,
    table_id: 7,
    values,
    computed_values: {},
    revision: 1,
    created_by: 'u1',
    updated_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
    ...extra,
  };
}

export const fixtureUsers: TableUserOption[] = [
  { id: 'u1', nickname: 'Jim', email: 'jim@example.com' },
  { id: 'u2', nickname: 'Ann', email: 'ann@example.com' },
];

export function bodyProps(overrides: Partial<TableViewBodyProps> & { config: TableViewConfig }): TableViewBodyProps {
  const schemaFields = overrides.schemaFields ?? [];
  return {
    table: fixtureTable,
    view: null,
    fields: schemaFields,
    schemaFields,
    records: [],
    total: overrides.records?.length ?? 0,
    query: {},
    loading: false,
    users: fixtureUsers,
    usersById: new Map(fixtureUsers.map((user) => [user.id, user])),
    sort: undefined,
    permissions: { canEdit: true, canCreate: true, canBuild: true, canChangeView: true },
    calendarMonth: '2026-10',
    onCalendarMonthChange: vi.fn(),
    onToggleSort: vi.fn(),
    onOpenRecord: vi.fn(),
    onEditRecord: vi.fn(),
    onDeleteRecord: vi.fn(),
    onCreateRecord: vi.fn(),
    onCommitValue: vi.fn(async () => undefined),
    onCommitValues: vi.fn(async () => undefined),
    onPaste: vi.fn(),
    onEditField: vi.fn(),
    onUpdateViewConfig: vi.fn(async () => undefined),
    onConfigureView: vi.fn(),
    ...overrides,
  };
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface MountedBody {
  container: HTMLDivElement;
  rerender: (props: TableViewBodyProps) => Promise<void>;
  unmount: () => void;
}

export async function mountBody(
  Body: ComponentType<TableViewBodyProps>,
  props: TableViewBodyProps,
): Promise<MountedBody> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const render = async (next: TableViewBodyProps) => {
    await act(async () => {
      root.render(
        <I18nProvider initialLocale="en">
          <Body {...next} />
          <ToastContainer />
        </I18nProvider>,
      );
    });
    await flush();
  };
  await render(props);
  return {
    container,
    rerender: render,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

export async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 });
}

/**
 * Press on `source`, move past the mouse threshold, release — with `target`
 * stubbed as the element under the pointer (happy-dom has no layout).
 */
export async function dragTo(source: Element, target: Element | null) {
  const under = vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
  await act(async () => {
    source.dispatchEvent(pointer('pointerdown', 10, 10));
  });
  await act(async () => {
    window.dispatchEvent(pointer('pointermove', 60, 80));
  });
  await act(async () => {
    window.dispatchEvent(pointer('pointerup', 60, 80));
  });
  under.mockRestore();
  await flush();
}
