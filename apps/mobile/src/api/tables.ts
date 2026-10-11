/**
 * Tables client — `/api/tables` (browse, records, comments, buttons) and
 * `/api/forms` (submit-only forms). Route contract: apps/api/src/routes/tables/
 * index.ts and routes/forms.ts; the response shapes are the vendored
 * `src/shared/tables-wire.ts` / `tables.ts` (one copy with the web).
 *
 * Conventions (apps/mobile/AGENTS.md "API 层"): reads resolve to a `Fetch`
 * that says whether a failure is *definitive* (403 / 404: gone or no access —
 * drop any cached copy) or transient (offline, 5xx — keep showing what we
 * have); writes resolve to a `Write` with the server's sentence and `details`
 * (a 409 carries `currentRevision`) and never throw. Record writes always carry
 * the revision they were read at.
 */

import type {
  TableFormSubmitResult,
  TableFormSubmitView,
  TableFormUploadView,
  TableQuery,
  TableRecordActivityPage,
  TableRecordButton,
  TableRecordCommentView,
  TableRecordValues,
} from '../shared/tables';
import type {
  TableBaseWithRole,
  TableBaseWorkspace,
  TableField,
  TableView,
  TableDashboard,
  TableDashboardWidget,
  TableDashboardWidgetResult,
  TableRecord,
  TableRecordPage,
  TableSchema,
  TableUser,
} from '../shared/tables-wire';
import type { TableFilterValue } from '../shared/tables';
import { api } from './client';

export type {
  TableBaseWithRole,
  TableBaseWorkspace,
  TableField,
  TableView,
  TableDashboard,
  TableDashboardWidget,
  TableRecord,
  TableRecordPage,
  TableSchema,
  TableUser,
};

/** A read: the value, or why not (`definitive` = 403 / 404 — gone or no access; else offline / 5xx). */
export type Fetch<T> = { ok: true; value: T } | { ok: false; status: number; definitive: boolean };

/** A write: the value, or the refusal (status 0 = network) with the server's sentence and details. */
export type Write<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string; details?: Record<string, unknown> };

const enc = encodeURIComponent;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** The viewer's IANA zone — date tokens and day comparisons resolve there (the server's default is UTC). */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export async function read<T>(path: string, pick: (body: any) => T, init?: RequestInit): Promise<Fetch<T>> {
  try {
    const res = await api(path, init);
    if (!res.ok) return { ok: false, status: res.status, definitive: res.status === 403 || res.status === 404 };
    return { ok: true, value: pick(await res.json()) };
  } catch {
    return { ok: false, status: 0, definitive: false };
  }
}

export async function write<T>(
  path: string,
  init: RequestInit & { json?: unknown },
  pick: (body: any) => T,
): Promise<Write<T>> {
  try {
    const { json, ...rest } = init;
    const res = await api(path, {
      ...rest,
      ...(json === undefined
        ? {}
        : { body: JSON.stringify(json), headers: { ...JSON_HEADERS, ...(rest.headers ?? {}) } }),
    });
    if (!res.ok) {
      const body: { error?: unknown; details?: unknown } = await res.json().catch(() => ({}));
      return {
        ok: false,
        status: res.status,
        message: typeof body.error === 'string' ? body.error : '',
        ...(body.details && typeof body.details === 'object'
          ? { details: body.details as Record<string, unknown> }
          : {}),
      };
    }
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    return { ok: true, value: pick(body) };
  } catch {
    return { ok: false, status: 0, message: '' };
  }
}

// ─── Bases ────────────────────────────────────────────────

export function listBases(search?: string): Promise<Fetch<TableBaseWithRole[]>> {
  const q = search?.trim() ? `?search=${enc(search.trim())}` : '';
  return read(`/api/tables/bases${q}`, (body) => (body?.bases ?? []) as TableBaseWithRole[]);
}

export function getBase(baseId: number): Promise<Fetch<TableBaseWorkspace>> {
  return read(`/api/tables/bases/${baseId}`, (body) => body as TableBaseWorkspace);
}

/** The internal user directory (names for people fields, the people picker, mentions). */
export function listUsers(): Promise<Fetch<TableUser[]>> {
  return read('/api/tables/meta/users', (body) => (body?.users ?? []) as TableUser[]);
}

// ─── Schema ───────────────────────────────────────────────

export function getSchema(tableId: number): Promise<Fetch<TableSchema>> {
  return read(`/api/tables/tables/${tableId}/schema`, (body) => body as TableSchema);
}

// ─── Records ──────────────────────────────────────────────

export function queryRecords(tableId: number, query: TableQuery): Promise<Fetch<TableRecordPage>> {
  return read(
    `/api/tables/tables/${tableId}/records/query`,
    (body) =>
      ({
        records: body?.records ?? [],
        total: body?.total ?? 0,
        nextCursor: body?.nextCursor ?? null,
      }) as TableRecordPage,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ...query, timezone: viewerTimeZone() }) },
  );
}

export function getRecord(tableId: number, recordId: number): Promise<Fetch<TableRecord>> {
  return read(`/api/tables/tables/${tableId}/records/${recordId}`, (body) => body.record as TableRecord);
}

export function createRecord(tableId: number, values: TableRecordValues): Promise<Write<TableRecord>> {
  return write(`/api/tables/tables/${tableId}/records`, { method: 'POST', json: { values } }, (body) => body.record);
}

export function updateRecord(
  tableId: number,
  recordId: number,
  revision: number,
  values: TableRecordValues,
): Promise<Write<TableRecord>> {
  return write(
    `/api/tables/tables/${tableId}/records/${recordId}`,
    { method: 'PATCH', json: { revision, values } },
    (body) => body.record,
  );
}

/**
 * Update, recovering from a stale revision when it is safe to (web
 * `updateTableRecordWithReplay`): automations run asynchronously and can bump a
 * record's revision seconds after a person read it. On a 409 the record is
 * re-read; if none of the fields this patch writes changed since `base`, the
 * patch is replayed on the new revision, else the conflict comes back.
 */
export async function updateRecordWithReplay(
  tableId: number,
  base: Pick<TableRecord, 'id' | 'revision' | 'values'>,
  values: TableRecordValues,
): Promise<Write<TableRecord>> {
  const first = await updateRecord(tableId, base.id, base.revision, values);
  if (first.ok || first.status !== 409) return first;
  const current = await getRecord(tableId, base.id);
  if (!current.ok) return first;
  const untouched = Object.keys(values).every(
    (key) => JSON.stringify(current.value.values[key] ?? null) === JSON.stringify(base.values[key] ?? null),
  );
  if (!untouched) return first;
  return updateRecord(tableId, base.id, current.value.revision, values);
}

export function deleteRecord(tableId: number, recordId: number, revision: number): Promise<Write<null>> {
  return write(
    `/api/tables/tables/${tableId}/records/${recordId}?revision=${revision}`,
    { method: 'DELETE' },
    () => null,
  );
}

// ─── Activity & comments ──────────────────────────────────

export function listActivity(
  tableId: number,
  recordId: number,
  cursor?: string | null,
): Promise<Fetch<TableRecordActivityPage>> {
  const q = cursor ? `?cursor=${enc(cursor)}` : '';
  return read(
    `/api/tables/tables/${tableId}/records/${recordId}/activity${q}`,
    (body) => body as TableRecordActivityPage,
  );
}

export function createComment(tableId: number, recordId: number, body: string): Promise<Write<TableRecordCommentView>> {
  return write(
    `/api/tables/tables/${tableId}/records/${recordId}/comments`,
    { method: 'POST', json: { body } },
    (res) => res.comment,
  );
}

export function deleteComment(commentId: number): Promise<Write<null>> {
  return write(`/api/tables/comments/${commentId}`, { method: 'DELETE' }, () => null);
}

// ─── Automation buttons ───────────────────────────────────

/** The buttons on a record the caller may press (only for people who can update the row). */
export function listRecordButtons(tableId: number, recordId: number): Promise<Fetch<TableRecordButton[]>> {
  return read(
    `/api/tables/tables/${tableId}/records/${recordId}/buttons`,
    (body) => (body?.buttons ?? []) as TableRecordButton[],
  );
}

/** Press a button: the rule runs asynchronously as its execution user. */
export function triggerButton(ruleId: number, recordId: number, requestId: string): Promise<Write<unknown>> {
  return write(
    `/api/tables/automations/${ruleId}/trigger`,
    { method: 'POST', json: { recordId, requestId } },
    (body) => body,
  );
}

// ─── Dashboards ───────────────────────────────────────────

export function getDashboard(
  dashboardId: number,
): Promise<Fetch<{ dashboard: TableDashboard; widgets: TableDashboardWidget[] }>> {
  return read(`/api/tables/dashboards/${dashboardId}`, (body) => ({
    dashboard: body.dashboard as TableDashboard,
    widgets: (body.widgets ?? []) as TableDashboardWidget[],
  }));
}

export function queryWidget(
  widgetId: number,
  filterValues: Record<string, TableFilterValue | null>,
): Promise<Fetch<TableDashboardWidgetResult>> {
  return read(`/api/tables/dashboard-widgets/${widgetId}/query`, (body) => body as TableDashboardWidgetResult, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ filterValues, timezone: viewerTimeZone() }),
  });
}

// ─── Forms (submit-only, `/api/forms`) ────────────────────

/** The submit view; 404 `details.reason = 'not_published'` for a draft form. */
export function openForm(formId: number): Promise<Fetch<TableFormSubmitView>> {
  return read(`/api/forms/${formId}`, (body) => body.form as TableFormSubmitView);
}

/** Stage one file for this form; it is bound when the same person submits. */
export function uploadFormFile(formId: number, file: UploadFile): Promise<Write<TableFormUploadView>> {
  return uploadMultipart(`/api/forms/${formId}/uploads`, file, {});
}

export function submitForm(formId: number, values: TableRecordValues): Promise<Write<TableFormSubmitResult>> {
  return write(
    `/api/forms/${formId}/submit`,
    { method: 'POST', json: { values, timeZone: viewerTimeZone() } },
    (body) => body as TableFormSubmitResult,
  );
}

// ─── Uploads ──────────────────────────────────────────────

/** A local file to upload (a photo from the camera or the library). */
export interface UploadFile {
  uri: string;
  name: string;
  type: string;
}

/** `multipart/form-data` with `file` + string fields → `{ file }` (forms and the apps gateway). */
export async function uploadMultipart(
  path: string,
  file: UploadFile,
  fields: Record<string, string>,
): Promise<Write<TableFormUploadView>> {
  try {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    // React Native FormData file descriptor
    form.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
    const res = await api(path, { method: 'POST', body: form });
    if (!res.ok) {
      const body: { error?: unknown } = await res.json().catch(() => ({}));
      return { ok: false, status: res.status, message: typeof body.error === 'string' ? body.error : '' };
    }
    const body = (await res.json()) as { file: TableFormUploadView };
    return { ok: true, value: body.file };
  } catch {
    return { ok: false, status: 0, message: '' };
  }
}

/** The authenticated content route of a Tables attachment (Drive `scope='tables'`). */
export function tablesFilePath(fileId: number): string {
  return `/api/drive/files/${fileId}/content`;
}

/** A fresh idempotency key for one press (an app action, an automation button); a retry of the same press reuses it. */
export function newRequestId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `m-${Date.now().toString(36)}-${random}`;
}
