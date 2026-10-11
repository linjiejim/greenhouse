/**
 * Apps client — `/api/apps` (the app center, pins, an app's runtime view and the
 * gateway its cards read and write through). Route contract:
 * apps/api/src/routes/apps.ts; shapes: the vendored `src/shared/apps.ts` (the
 * gateway wire contract — app viewers cannot call `/api/tables`, so the gateway
 * resolves people / related-row / file labels itself, `AppRecordRefs`).
 *
 * Every read / write follows src/api/tables.ts (`Fetch` / `Write`, never throws).
 * Opening an app declares the card kinds this build draws (`MOBILE_APP_CARDS`,
 * `?cards=`): an older build meeting a newer kind shows "open on the web"
 * instead of crashing; the server may also trim what it sends to it.
 */

import {
  MOBILE_APP_CARDS,
  type AppActionInput,
  type AppActionResult,
  type AppActivityInput,
  type AppCardQueryInput,
  type AppCardQueryResult,
  type AppCommentInput,
  type AppFieldOptionsInput,
  type AppFieldOptionsView,
  type AppListView,
  type AppRecordGetInput,
  type AppRecordView,
  type AppRuntimeView,
  type AppSummary,
  type AppUploadView,
} from '../shared/apps';
import type { TableRecordActivityPage, TableRecordCommentView } from '../shared/tables';
import { read, uploadMultipart, viewerTimeZone, write, type Fetch, type UploadFile, type Write } from './tables';

export { newRequestId } from './tables';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function post<T>(path: string, body: unknown, pick: (res: any) => T): Promise<Fetch<T>> {
  return read(path, pick, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

// ─── The center ───────────────────────────────────────────

export function listApps(): Promise<Fetch<AppListView>> {
  return read('/api/apps', (body) => ({
    managed: (body?.managed ?? []) as AppSummary[],
    shared: (body?.shared ?? []) as AppSummary[],
    featured: (body?.featured ?? []) as AppSummary[],
  }));
}

/** My pinned apps, in order (only ones I may still open). */
export function listPins(): Promise<Fetch<AppSummary[]>> {
  return read('/api/apps/pins', (body) => (body?.apps ?? []) as AppSummary[]);
}

/** Replace my pins (server-stored, D9). */
export function setPins(appIds: number[]): Promise<Write<AppSummary[]>> {
  return write('/api/apps/pins', { method: 'PUT', json: { appIds } }, (body) => (body?.apps ?? []) as AppSummary[]);
}

// ─── One app ──────────────────────────────────────────────

/** The published spec trimmed to my role, with the field metadata to draw it. */
export function getApp(appId: number): Promise<Fetch<AppRuntimeView>> {
  const cards = MOBILE_APP_CARDS.join(',');
  return read(`/api/apps/${appId}?cards=${cards}`, (body) => body as AppRuntimeView);
}

export function queryCard(appId: number, input: AppCardQueryInput): Promise<Fetch<AppCardQueryResult>> {
  return post(
    `/api/apps/${appId}/cards/query`,
    { timezone: viewerTimeZone(), ...input },
    (body) => body as AppCardQueryResult,
  );
}

export function getAppRecord(appId: number, input: AppRecordGetInput): Promise<Fetch<AppRecordView>> {
  return post(`/api/apps/${appId}/records/get`, input, (body) => body as AppRecordView);
}

/**
 * Run a declared action or a built-in write (`$submit` / `$create` / `$move` /
 * `$edit`). Carries my time zone, as the web does: `$today` / `$now` in the
 * spec's values and defaults are my day, not UTC's.
 */
export function runAction(appId: number, input: AppActionInput): Promise<Write<AppActionResult>> {
  return write(
    `/api/apps/${appId}/actions`,
    { method: 'POST', json: { timezone: viewerTimeZone(), ...input } },
    (body) => body as AppActionResult,
  );
}

export function listAppActivity(appId: number, input: AppActivityInput): Promise<Fetch<TableRecordActivityPage>> {
  return post(`/api/apps/${appId}/activity`, input, (body) => body as TableRecordActivityPage);
}

export function createAppComment(appId: number, input: AppCommentInput): Promise<Write<TableRecordCommentView>> {
  return write(`/api/apps/${appId}/comments`, { method: 'POST', json: input }, (body) => body.comment);
}

export function deleteAppComment(
  appId: number,
  commentId: number,
  where: { pageId: string; cardId: string },
): Promise<Write<null>> {
  return write(`/api/apps/${appId}/comments/${commentId}`, { method: 'DELETE', json: where }, () => null);
}

/** Choices for a user / relation field the card lets my role write. */
export function fieldOptions(appId: number, input: AppFieldOptionsInput): Promise<Fetch<AppFieldOptionsView>> {
  return post(`/api/apps/${appId}/options`, input, (body) => ({ options: body?.options ?? [] }) as AppFieldOptionsView);
}

/** Stage a file for a card's attachment field; it is bound on the next write. */
export function uploadAppFile(
  appId: number,
  where: { pageId: string; cardId: string; fieldId: number },
  file: UploadFile,
): Promise<Write<AppUploadView>> {
  return uploadMultipart(`/api/apps/${appId}/uploads`, file, {
    pageId: where.pageId,
    cardId: where.cardId,
    fieldId: String(where.fieldId),
  });
}

/** The content route of an attachment I may read through this card and record. */
export function appFilePath(
  appId: number,
  fileId: number,
  where: { pageId: string; cardId: string; recordId: number; fieldId: number },
): string {
  const q = `pageId=${encodeURIComponent(where.pageId)}&cardId=${encodeURIComponent(where.cardId)}&recordId=${where.recordId}&fieldId=${where.fieldId}`;
  return `/api/apps/${appId}/files/${fileId}?${q}`;
}
