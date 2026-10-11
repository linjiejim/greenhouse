/**
 * Apps client (`/api/apps`, spec 20261011-tables-apps §4) — the routes the
 * web shell needs: the caller's shelves, one app as its viewer sees it, and
 * server-side pins (D9).
 *
 * Raw `authFetch`, typed with the shared views in `@greenhouse/types/apps`,
 * because this tree's `AppType` does not carry `/api/apps` yet. Once the
 * chained gateway router is in `AppType` these calls move to `rpc` and the
 * response types are inferred from the server instead of declared here.
 * Failures throw the Tables client's `TablesRequestError` (status + details):
 * apps live in the Tables domain (spec D1), so callers keep one error type.
 */

import type { AppRuntimeView, AppSummary } from '@greenhouse/types/apps';
import { authFetch } from '../auth';
import { responseError } from './tables/shared';

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

export async function listApps(): Promise<AppCatalog> {
  const response = await authFetch('/api/apps');
  if (!response.ok) throw await responseError(response, 'Unable to load apps');
  return normalizeAppCatalog(await response.json());
}

/** The published app trimmed to the caller's role, with the field metadata to render it. */
export async function getApp(appId: number): Promise<AppRuntimeView> {
  const response = await authFetch(`/api/apps/${appId}`);
  if (!response.ok) throw await responseError(response, 'Unable to load app');
  return (await response.json()) as AppRuntimeView;
}

/** The caller's pinned apps in sidebar order (`GET /api/apps/pins`, spec D9 — pins live on the server). */
export async function getAppPins(): Promise<number[]> {
  const response = await authFetch('/api/apps/pins');
  if (!response.ok) throw await responseError(response, 'Unable to load pinned apps');
  // The server answers with the pinned summaries (only apps the caller may still open), in order.
  const body = (await response.json()) as { apps?: unknown };
  return summaries(body.apps)
    .map((app) => app.id)
    .filter((id) => Number.isInteger(id));
}

/** Replace the caller's pinned apps, in sidebar order (`PUT /api/apps/pins`, spec D9). */
export async function setAppPins(appIds: readonly number[]): Promise<void> {
  const response = await authFetch('/api/apps/pins', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appIds }),
  });
  if (!response.ok) throw await responseError(response, 'Unable to save pinned apps');
}
