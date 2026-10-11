/**
 * Apps client (`/api/apps`, spec 20261011-tables-apps §4) — what the app
 * center and the runtime call: the caller's shelves, pins, creating an app,
 * the built-in templates, one app as its viewer sees it, and the gateway
 * (card queries, record detail, actions, activity, comments, field options,
 * uploads, file downloads). The builder's draft / publish / versions /
 * audiences calls live in `./apps-builder.ts`.
 *
 * Typed `rpc` over `AppType`: response types are inferred from the routes,
 * which answer the wire contract of `@greenhouse/types/apps`. The one
 * exception is the multipart upload (FormData, like every upload) on raw
 * `authFetch`. Failures throw the Tables client's `TablesRequestError`
 * (status + details, `details.reason` for action refusals): apps live in the
 * Tables domain (spec D1), so callers keep one error type.
 *
 * A manager's preview travels as one `AppPreviewScope` (`previewRole?`,
 * `draft?`) — spread into every gateway input, the query of `getApp`, the
 * upload's form fields and the file download's query.
 */

import type {
  AppAccent,
  AppActionInput,
  AppActionResult,
  AppActivityInput,
  AppCardQueryInput,
  AppCardQueryResult,
  AppCommentInput,
  AppDraftView,
  AppFieldOptionsInput,
  AppFieldOptionsView,
  AppIconName,
  AppRecordGetInput,
  AppRecordView,
  AppRuntimeView,
  AppSummary,
  AppTemplateInstallResult,
  AppTemplateSummary,
  AppUploadView,
} from '@greenhouse/types/apps';
import type { TableFilterValue, TableRecordActivityPage, TableRecordCommentView } from '@greenhouse/types/tables';
import type { AppPreviewScope } from '../app-routes';
import { authFetch } from '../auth';
import { localTimeZone } from '../cron';
import { rpc } from './client';
import { TablesRequestError, responseError } from './tables/shared';

/** `GET /api/apps`: the caller's three shelves. One app may sit on several. */
export interface AppCatalog {
  /** Apps on Bases the caller owns or builds (or every app, for super) — drafts included. */
  managed: AppSummary[];
  /** Published apps given to the caller, a group of theirs or everyone. */
  shared: AppSummary[];
  /** Published apps a super featured, among those the caller may open. */
  featured: AppSummary[];
}

function summaries(value: unknown): AppSummary[] {
  return Array.isArray(value) ? (value as AppSummary[]) : [];
}

/**
 * The shelves from either answer the gateway may give: the three lists, or one
 * flat list whose summaries carry the caller's relation (`canManage`,
 * `featured`, `status`). Anything else is an empty catalog, never a throw.
 */
export function normalizeAppCatalog(body: unknown): AppCatalog {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if ('managed' in record || 'shared' in record || 'featured' in record) {
    return {
      managed: summaries(record.managed),
      shared: summaries(record.shared),
      featured: summaries(record.featured),
    };
  }
  const apps = summaries(record.apps);
  const published = (app: AppSummary) => app.status === 'published' && app.publishedVersion !== null;
  return {
    managed: apps.filter((app) => app.canManage),
    shared: apps.filter((app) => !app.canManage && published(app)),
    featured: apps.filter((app) => app.featured && published(app)),
  };
}

const appParam = (appId: number) => ({ appId: String(appId) });

// ─── Center ───────────────────────────────────────────────

export async function listApps(): Promise<AppCatalog> {
  const response = await rpc.api.apps.$get();
  if (!response.ok) throw await responseError(response, 'Unable to load apps');
  return normalizeAppCatalog(await response.json());
}

/** The caller's pinned apps in sidebar order (spec D9 — pins live on the server, only apps still open to them). */
export async function getAppPins(): Promise<number[]> {
  const response = await rpc.api.apps.pins.$get();
  if (!response.ok) throw await responseError(response, 'Unable to load pinned apps');
  return (await response.json()).apps.map((app) => app.id).filter((id) => Number.isInteger(id));
}

/** Replace the caller's pinned apps, in sidebar order (spec D9). */
export async function setAppPins(appIds: readonly number[]): Promise<void> {
  const args = { json: { appIds } };
  const response = await rpc.api.apps.pins.$put(args);
  if (!response.ok) throw await responseError(response, 'Unable to save pinned apps');
}

export interface CreateAppInput {
  baseId: number;
  name: string;
  description?: string;
  icon?: AppIconName;
  accent?: AppAccent;
}

/** A new app on a Base the caller builds: a draft with the starter spec, opened in the builder next. */
export async function createApp(input: CreateAppInput): Promise<AppDraftView> {
  const args = { json: input };
  const response = await rpc.api.apps.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create the app');
  return response.json();
}

/** The built-in templates (`GET /api/apps/templates` → `{templates}`), in the caller's language. */
export async function listAppTemplates(): Promise<AppTemplateSummary[]> {
  const response = await rpc.api.apps.templates.$get();
  if (!response.ok) throw await responseError(response, 'Unable to load templates');
  return (await response.json()).templates;
}

/**
 * Install a template: a new Base owned by the caller plus a draft app on it
 * (`AppTemplateInstallResult`). Not idempotent — every call builds another
 * Base, so callers send it once per intent.
 */
export async function installAppTemplate(key: string): Promise<AppTemplateInstallResult> {
  const response = await rpc.api.apps.templates[':key'].install.$post({ param: { key } });
  if (!response.ok) throw await responseError(response, 'Unable to install the template');
  return response.json();
}

// ─── Runtime ──────────────────────────────────────────────

/**
 * One app as the caller uses it: the published spec trimmed to their role
 * with the field metadata to render it (a manager gets full access, or the
 * trim of `previewRole`; `draft` reads the draft instead of the published
 * version).
 */
export async function getApp(appId: number, preview: AppPreviewScope = {}): Promise<AppRuntimeView> {
  const query = {
    ...(preview.previewRole ? { previewRole: preview.previewRole } : {}),
    ...(preview.draft ? { draft: '1' } : {}),
  };
  const args = { param: appParam(appId), ...(Object.keys(query).length > 0 ? { query } : {}) };
  const response = await rpc.api.apps[':appId'].$get(args);
  if (!response.ok) throw await responseError(response, 'Unable to load app');
  return response.json();
}

/**
 * A card query as the runtime sends it. Filter values follow the dashboard's
 * convention: a control the viewer cleared is sent as `null` (its default no
 * longer applies), an untouched one is absent.
 */
export type AppCardQueryRequest = Omit<AppCardQueryInput, 'filterValues'> & {
  filterValues?: Record<string, TableFilterValue | null>;
};

export async function queryAppCard(appId: number, input: AppCardQueryRequest): Promise<AppCardQueryResult> {
  const args = { param: appParam(appId), json: input };
  const response = await rpc.api.apps[':appId'].cards.query.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to load this card');
  return response.json();
}

export async function getAppRecord(appId: number, input: AppRecordGetInput): Promise<AppRecordView> {
  const args = { param: appParam(appId), json: input };
  const response = await rpc.api.apps[':appId'].records.get.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to load the record');
  return response.json();
}

/**
 * Run a declared action or a built-in write (`$submit` / `$create` / `$move` /
 * `$edit`). `$today` / `$now` in the action's values resolve in the viewer's
 * zone unless the input names one (the gateway defaults to UTC).
 */
export async function runAppAction(appId: number, input: AppActionInput): Promise<AppActionResult> {
  const args = { param: appParam(appId), json: { ...input, timezone: input.timezone ?? localTimeZone() } };
  const response = await rpc.api.apps[':appId'].actions.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to run the action');
  return response.json();
}

/** A fresh idempotency key for one write (the gateway answers a repeat with its first result). */
export function newAppRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Why `/actions` refused (`AppActionRefusal`), when it said. */
export function appActionRefusal(error: unknown): string | undefined {
  if (!(error instanceof TablesRequestError)) return undefined;
  const reason = error.details?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

function isStaleRevision(error: unknown): boolean {
  return error instanceof TablesRequestError && error.status === 409 && appActionRefusal(error) !== 'precondition';
}

/**
 * A record write that survives an unrelated concurrent change (the app
 * counterpart of `updateTableRecordWithReplay`). On a stale revision the record
 * is re-read through the same card:
 * - `$edit` / `$move` replay when none of the fields they write changed since
 *   `base` (the values the viewer was looking at);
 * - a declared action replays when it is still offered for the record now
 *   (`actionIds`) — its `when` is re-checked by the server inside the write.
 * Anything else rethrows the conflict for the caller to report. The first
 * attempt carries the caller's `requestId` (one per intent, so a retry after a
 * lost answer is answered once); a replay is a new write with a new id.
 */
export async function runAppActionWithReplay(
  appId: number,
  input: AppActionInput,
  base?: { values: Record<string, unknown> },
): Promise<AppActionResult> {
  try {
    return await runAppAction(appId, input);
  } catch (error) {
    if (!isStaleRevision(error) || input.recordId === undefined) throw error;
    const current = await getAppRecord(appId, {
      pageId: input.pageId,
      cardId: input.cardId,
      recordId: input.recordId,
      ...(input.previewRole ? { previewRole: input.previewRole } : {}),
      ...(input.draft ? { draft: true } : {}),
    }).catch(() => null);
    if (!current) throw error;
    const builtin = input.actionId === '$edit' || input.actionId === '$move';
    const safe = builtin
      ? (input.values ?? []).every(
          (entry) =>
            JSON.stringify(current.record.values[String(entry.fieldId)] ?? null) ===
            JSON.stringify(base?.values[String(entry.fieldId)] ?? null),
        )
      : current.record.actionIds.includes(input.actionId);
    if (!safe) throw error;
    return runAppAction(appId, { ...input, revision: current.record.revision, requestId: newAppRequestId() });
  }
}

export async function listAppActivity(appId: number, input: AppActivityInput): Promise<TableRecordActivityPage> {
  const args = { param: appParam(appId), json: input };
  const response = await rpc.api.apps[':appId'].activity.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to load the activity');
  return response.json();
}

export async function createAppComment(appId: number, input: AppCommentInput): Promise<TableRecordCommentView> {
  const args = { param: appParam(appId), json: input };
  const response = await rpc.api.apps[':appId'].comments.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to post the comment');
  return (await response.json()).comment;
}

export async function updateAppComment(
  appId: number,
  commentId: number,
  input: { pageId: string; cardId: string; body: string } & AppPreviewScope,
): Promise<TableRecordCommentView> {
  const args = { param: { ...appParam(appId), commentId: String(commentId) }, json: input };
  const response = await rpc.api.apps[':appId'].comments[':commentId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update the comment');
  return (await response.json()).comment;
}

export async function deleteAppComment(
  appId: number,
  commentId: number,
  input: { pageId: string; cardId: string } & AppPreviewScope,
): Promise<void> {
  const args = { param: { ...appParam(appId), commentId: String(commentId) }, json: input };
  const response = await rpc.api.apps[':appId'].comments[':commentId'].$delete(args);
  if (!response.ok) throw await responseError(response, 'Unable to delete the comment');
}

/** Choices for a user or relation field this card lets the viewer write (people; records in their read scope). */
export async function listAppFieldOptions(appId: number, input: AppFieldOptionsInput): Promise<AppFieldOptionsView> {
  const args = { param: appParam(appId), json: input };
  const response = await rpc.api.apps[':appId'].options.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to load the choices');
  return response.json();
}

/** Upload an attachment for a card's form or edit (bound to the record on the next write). Multipart → raw `authFetch`. */
export async function uploadAppFile(
  appId: number,
  input: { pageId: string; cardId: string; fieldId: number; file: File } & AppPreviewScope,
): Promise<AppUploadView> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('pageId', input.pageId);
  form.append('cardId', input.cardId);
  form.append('fieldId', String(input.fieldId));
  if (input.previewRole) form.append('previewRole', input.previewRole);
  if (input.draft) form.append('draft', '1');
  const response = await authFetch(`/api/apps/${appId}/uploads`, { method: 'POST', body: form });
  if (!response.ok) throw await responseError(response, 'Unable to upload the file');
  return ((await response.json()) as { file: AppUploadView }).file;
}

/** Where one attachment of a record is read — only when the record and the field are readable by the viewer's role. */
export function appFilePath(
  appId: number,
  fileId: number,
  context: { pageId: string; cardId: string; recordId: number; fieldId: number } & AppPreviewScope,
): string {
  const query = new URLSearchParams({
    pageId: context.pageId,
    cardId: context.cardId,
    recordId: String(context.recordId),
    fieldId: String(context.fieldId),
  });
  if (context.previewRole) query.set('previewRole', context.previewRole);
  if (context.draft) query.set('draft', '1');
  return `/api/apps/${appId}/files/${fileId}?${query.toString()}`;
}
