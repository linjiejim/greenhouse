/**
 * App card renderers (spec 20261011-tables-apps §6) — one per `AppCardKind`,
 * shared by every host of an app page. Records-like cards reuse the Phase 0
 * Tables renderers (`RecordsTable`, the kanban / calendar / gallery view
 * bodies, `FieldValue` / `FieldEditor`), aggregates the dashboard's
 * `TableCardView`; renderers never call the gateway themselves — the host
 * (`AppCardHost`) does.
 */

export { AppCardView, APP_CARD_RENDERERS } from './app-card-view';
export { AppRecordForm, type AppRecordFormProps } from './record-form';
export { AppRecordActionButtons } from './record-actions';
export {
  actionInputFieldIds,
  appRecordToTableRecord,
  appTableDefinition,
  appTableFields,
  brokenActionIds,
  cardIssue,
  cardTableId,
  cardTitle,
  drawerActions,
  editableFieldIds,
  EMPTY_REFS,
  isAggregateCard,
  isQueriedCard,
  isRecordsLikeCard,
  isSafeAppUrl,
  mergeRefs,
  offeredActions,
  pickFields,
  refsUsers,
  usersByIdOf,
  viewTable,
  type AppAggregateCard,
  type AppRecordsLikeCard,
  type AppViewTable,
} from './model';
export { recordsResult } from './records-data';
export type { AppCardHost, AppCardParams, AppCardRendererProps, AppCardRenderers } from './types';
