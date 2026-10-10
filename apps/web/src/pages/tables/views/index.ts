/**
 * The typed view switcher: one body per `TableViewType`. Slice V fills in
 * kanban / calendar / gallery here (each in its own file under ./). A type
 * without a body yet renders as a grid, so a view saved by a newer client or by
 * the Agent never shows a blank page.
 */

import type { ComponentType } from 'react';
import type { TableViewType } from '@greenhouse/types/tables';
import { GridViewBody } from './grid';
import type { TableViewBodyProps } from './types';

export const TABLE_VIEW_BODIES: Record<TableViewType, ComponentType<TableViewBodyProps> | null> = {
  grid: GridViewBody,
  kanban: null,
  calendar: null,
  gallery: null,
};

export function viewBodyFor(type: TableViewType | undefined): ComponentType<TableViewBodyProps> {
  return TABLE_VIEW_BODIES[type ?? 'grid'] ?? GridViewBody;
}

export type { TableViewBodyProps, TableViewPermissions } from './types';
