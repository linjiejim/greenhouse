/** Icon and label of each view type — the switcher, the type picker and the dialogs share them. */

import type { TableViewType } from '@greenhouse/types/tables';
import { CalendarDays, GalleryHorizontal, Kanban, Table2, type LucideIcon } from '../../../lib/icons';
import type { TranslationKey } from '../../../lib/i18n';

export const TABLE_VIEW_TYPE_ICONS: Record<TableViewType, LucideIcon> = {
  grid: Table2,
  kanban: Kanban,
  calendar: CalendarDays,
  gallery: GalleryHorizontal,
};

export const TABLE_VIEW_TYPE_LABEL_KEYS: Record<TableViewType, TranslationKey> = {
  grid: 'tables.views.type.grid',
  kanban: 'tables.views.type.kanban',
  calendar: 'tables.views.type.calendar',
  gallery: 'tables.views.type.gallery',
};
