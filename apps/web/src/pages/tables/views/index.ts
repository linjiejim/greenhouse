/**
 * The typed view switcher: one body per `TableViewType`, each in its own file
 * under ./. A type without a body would render as a grid, so a view saved by a
 * newer client or by the Agent never shows a blank page.
 */

import type { ComponentType } from 'react';
import type { TableViewType } from '@greenhouse/types/tables';
import { CalendarViewBody } from './calendar';
import { GalleryViewBody } from './gallery';
import { GridViewBody } from './grid';
import { KanbanViewBody } from './kanban';
import type { TableViewBodyProps } from './types';

export const TABLE_VIEW_BODIES: Record<TableViewType, ComponentType<TableViewBodyProps> | null> = {
  grid: GridViewBody,
  kanban: KanbanViewBody,
  calendar: CalendarViewBody,
  gallery: GalleryViewBody,
};

export function viewBodyFor(type: TableViewType | undefined): ComponentType<TableViewBodyProps> {
  return TABLE_VIEW_BODIES[type ?? 'grid'] ?? GridViewBody;
}

export { TABLE_VIEW_TYPE_ICONS, TABLE_VIEW_TYPE_LABEL_KEYS } from './view-type-meta';
export type { TableSortTarget, TableViewBodyProps, TableViewHost, TableViewPermissions, TableViewQuery } from './types';
