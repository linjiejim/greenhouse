/**
 * The seam between the app card renderers and whoever hosts them (the runtime
 * page today; a builder canvas could host them too). Renderers draw one card
 * from the spec, the gateway's evaluated state and the view's field metadata,
 * and turn every gesture into a host call — they never request or write on
 * their own, so the host owns the gateway, `requestId`s, 409 recovery and
 * dialogs.
 */

import type { ComponentType } from 'react';
import type {
  AppCard,
  AppCardKind,
  AppCardQueryResult,
  AppFieldOptionsView,
  AppRecordAction,
  AppRecordRow,
  AppRuntimeView,
  AppUploadView,
} from '@greenhouse/types/apps';
import type { TableFieldValueEntry } from '@greenhouse/types/tables';
import type { TableCardState } from '../table-cards';
import type { TableUserOption } from '../../lib/api/tables';
import type { AppRecordsLikeCard } from './model';

/** Per-card query parameters a card controls itself (records search and paging). */
export interface AppCardParams {
  search?: string;
  cursor?: string;
}

export interface AppCardHost {
  appId: number;
  pageId: string;
  view: AppRuntimeView;
  /** A manager previewing the app as one of its roles. */
  previewRole?: string;
  /** People the page has seen (refs of its cards) — labels for aggregates, the people filter. */
  users: readonly TableUserOption[];
  /** Re-evaluate a card with new parameters (and remember them for later refreshes). */
  setParams(card: AppCard, params: AppCardParams): void;
  /** Re-evaluate a card as it is. */
  retry(card: AppCard): void;
  /** Open a record's detail (cards with `detail`). */
  openRecord(card: AppRecordsLikeCard, row: AppRecordRow): void;
  /** Run a declared action on a record (the host confirms and collects inputs). */
  runAction(card: AppRecordsLikeCard, action: AppRecordAction, row: AppRecordRow): void;
  /** A records card's `create`, or a `create_record` button (`buttonId`). */
  openCreate(card: AppCard, buttonId?: string): void;
  /** `$submit` of a form card. Resolves when stored; throws a refusal for the form to show. */
  submitForm(card: Extract<AppCard, { kind: 'form' }>, values: TableFieldValueEntry[]): Promise<void>;
  /** `$move` of a kanban card. Resolves once the board shows the new state; throws to snap the card back. */
  move(card: Extract<AppCard, { kind: 'kanban' }>, row: AppRecordRow, fieldId: number, value: unknown): Promise<void>;
  openPage(pageId: string): void;
  /** Where one attachment of a record is read. */
  fileUrl(card: AppCard, recordId: number, fieldId: number, fileId: number): string;
  /** Upload-only attachments for a card that creates or edits records. */
  upload(card: AppCard, fieldId: number, file: File): Promise<AppUploadView>;
  /** Choices for a user / relation field this card writes. */
  loadOptions(card: AppCard, fieldId: number, buttonId?: string): Promise<AppFieldOptionsView>;
  /** What to tell the viewer about a failed write (the gateway's refusal reasons in their words). */
  describeError(error: unknown): string;
}

interface AppCardRendererBaseProps {
  host: AppCardHost;
  /** The evaluated state of a queried card (records-like and aggregate kinds); undefined for the others. */
  state?: TableCardState<AppCardQueryResult>;
}

/** A renderer of the kinds `K` (several kinds may share one renderer: kanban / calendar / gallery). */
export type AppCardRendererProps<K extends AppCardKind = AppCardKind> = AppCardRendererBaseProps & {
  card: Extract<AppCard, { kind: K }>;
};

/** One renderer per card kind — a kind without one is a compile error. */
export type AppCardRenderers = { [K in AppCardKind]: ComponentType<AppCardRendererProps<K>> };
