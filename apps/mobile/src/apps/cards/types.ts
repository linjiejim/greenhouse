/**
 * What every app card renderer gets (./registry.tsx): the runtime view (my
 * role's spec + field metadata), the page it sits on, the card, the page's
 * filter values, and the page's navigation / write helpers.
 */

import type { AppCard, AppPage, AppRecordRow, AppRuntimeView } from '../../shared/apps';
import type { FilterValues } from '../../tables/cards/filter-bar';
import type { useAppActions } from '../actions';
import type { AppWriteMode } from '../model';

export interface AppPageUi {
  /** Open a record of a records-like card (its detail view). */
  openRecord: (card: AppCard, record: AppRecordRow) => void;
  /** Open the write form (a form card's submit, a create, a button's new record). */
  openWrite: (card: AppCard, mode: AppWriteMode, extra?: { buttonId?: string }) => void;
  openPage: (pageId: string) => void;
  openUrl: (url: string) => void;
  actions: ReturnType<typeof useAppActions>;
}

export interface AppCardProps {
  appId: number;
  view: AppRuntimeView;
  page: AppPage;
  card: AppCard;
  filterValues: FilterValues;
  previewRole?: string;
  ui: AppPageUi;
}
