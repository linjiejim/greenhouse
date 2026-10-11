/**
 * Apps builder client (`/api/apps`, spec 20261011-tables-apps §4) — what the
 * builder (`#/apps/<id>/edit`) and a Base's Apps section call: create an app,
 * read and save the draft (CAS on `draftRevision`), publish, versions and
 * restore, audiences (CAS on `audiencesRevision`), rename / archive / hand
 * over / feature, and the usage summary. The viewer calls (shelves, the
 * runtime view, pins, the gateway) live in `./apps` (slice R).
 *
 * Typed `rpc` over the chained `/api/apps` router: response types come from
 * the server. Failures throw the Tables client's `TablesRequestError` (status +
 * `details`): a 409 carries `details.reason` (`draft_conflict` /
 * `audiences_conflict`) and `currentRevision`; a 400 `spec_invalid` carries
 * `details.errors` (`AppSpecError[]`); a builder publishing or changing
 * audiences gets 403 `owner_only` (spec D2).
 */

import type {
  AppAccent,
  AppAudienceEntry,
  AppAudiencesView,
  AppDraftView,
  AppIconName,
  AppRuntimeView,
  AppSpec,
  AppSpecError,
  AppSummary,
  AppUsageView,
  AppVersionSummary,
} from '@greenhouse/types/apps';
import { rpc } from './client';
import { responseError, TablesRequestError } from './tables/shared';

export interface AppIdentityInput {
  name: string;
  description?: string | null;
  icon?: AppIconName;
  accent?: AppAccent;
}

function appParam(appId: number) {
  return { appId: String(appId) };
}

/** `POST /api/apps`: a new draft app on a Base the caller builds. */
export async function createApp(input: AppIdentityInput & { baseId: number; spec?: AppSpec }): Promise<AppDraftView> {
  const response = await rpc.api.apps.$post({ json: input });
  if (!response.ok) throw await responseError(response, 'Unable to create the app');
  return response.json();
}

/** `GET /api/apps/:id/draft`: the draft, its revision and its problems against today's schema. */
export async function getAppDraft(appId: number): Promise<AppDraftView> {
  const response = await rpc.api.apps[':appId'].draft.$get({ param: appParam(appId) });
  if (!response.ok) throw await responseError(response, 'Unable to load the draft');
  return response.json();
}

/**
 * `PUT /api/apps/:id/draft`. A shape the validator refuses → 400 `spec_invalid`
 * (nothing saved); schema problems come back in `errors` and the draft is saved.
 */
export async function saveAppDraft(appId: number, spec: AppSpec, draftRevision: number): Promise<AppDraftView> {
  const args = { param: appParam(appId), json: { spec, draftRevision } };
  const response = await rpc.api.apps[':appId'].draft.$put(args);
  if (!response.ok) throw await responseError(response, 'Unable to save the draft');
  return response.json();
}

/** `GET /api/apps/:id` as a manager: the published version in full (or the draft before the first publish). */
export async function getPublishedApp(appId: number): Promise<AppRuntimeView> {
  const response = await rpc.api.apps[':appId'].$get({ param: appParam(appId) });
  if (!response.ok) throw await responseError(response, 'Unable to load the app');
  return response.json();
}

/** Base owner / super: publish the draft at `draftRevision` as the next version. */
export async function publishApp(
  appId: number,
  input: { draftRevision: number; notes?: string | null },
): Promise<{ app: AppSummary; version: AppVersionSummary }> {
  const args = { param: appParam(appId), json: input };
  const response = await rpc.api.apps[':appId'].publish.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to publish the app');
  return response.json();
}

export async function listAppVersions(appId: number): Promise<AppVersionSummary[]> {
  const response = await rpc.api.apps[':appId'].versions.$get({ param: appParam(appId) });
  if (!response.ok) throw await responseError(response, 'Unable to load versions');
  return (await response.json()).versions;
}

/** Copy a published version into the draft (D5: publishing it makes a new version). */
export async function restoreAppVersion(appId: number, version: number, draftRevision: number): Promise<AppDraftView> {
  const args = { param: { appId: String(appId), version: String(version) }, json: { draftRevision } };
  const response = await rpc.api.apps[':appId'].versions[':version'].restore.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to restore the version');
  return response.json();
}

export async function getAppAudiences(appId: number): Promise<AppAudiencesView> {
  const response = await rpc.api.apps[':appId'].audiences.$get({ param: appParam(appId) });
  if (!response.ok) throw await responseError(response, 'Unable to load who the app is shared with');
  return response.json();
}

/** Base owner / super: replace who the app is shared with. */
export async function setAppAudiences(
  appId: number,
  entries: AppAudienceEntry[],
  audiencesRevision: number,
): Promise<AppAudiencesView> {
  const args = { param: appParam(appId), json: { entries, audiencesRevision } };
  const response = await rpc.api.apps[':appId'].audiences.$put(args);
  if (!response.ok) throw await responseError(response, 'Unable to save who the app is shared with');
  return response.json();
}

/** Rename, describe, change the icon or the accent. */
export async function updateAppIdentity(appId: number, input: Partial<AppIdentityInput>): Promise<AppSummary> {
  const args = { param: appParam(appId), json: input };
  const response = await rpc.api.apps[':appId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update the app');
  return (await response.json()).app;
}

export async function archiveApp(appId: number): Promise<AppSummary> {
  const response = await rpc.api.apps[':appId'].archive.$post({ param: appParam(appId) });
  if (!response.ok) throw await responseError(response, 'Unable to archive the app');
  return (await response.json()).app;
}

/** Hand the app to another owner or builder of the Base. */
export async function transferApp(appId: number, userId: string): Promise<AppSummary> {
  const args = { param: appParam(appId), json: { userId } };
  const response = await rpc.api.apps[':appId'].transfer.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to hand the app over');
  return (await response.json()).app;
}

/** Super: recommend the published app to its audience, or stop. */
export async function featureApp(appId: number, featured: boolean): Promise<AppSummary> {
  const args = { param: appParam(appId), json: { featured } };
  const response = await rpc.api.apps[':appId'].feature.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to change the recommendation');
  return (await response.json()).app;
}

/**
 * Read `GET /usage` into the shared contract. The route is typed as a plain
 * record (the gateway slice fills it), so the shape is checked here rather
 * than cast: a missing count reads as zero, never as `undefined`.
 */
export function readAppUsage(body: Record<string, unknown>): AppUsageView {
  const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const actions =
    body.actions30d && typeof body.actions30d === 'object' && !Array.isArray(body.actions30d)
      ? Object.fromEntries(
          Object.entries(body.actions30d as Record<string, unknown>).map(([id, runs]) => [id, count(runs)]),
        )
      : {};
  return {
    users7d: count(body.users7d),
    users30d: count(body.users30d),
    actions30d: actions,
    lastUsedAt: typeof body.lastUsedAt === 'string' ? body.lastUsedAt : null,
  };
}

/** Managers: who used the app and what they ran (from the app-scoped audit). */
export async function getAppUsage(appId: number): Promise<AppUsageView> {
  const response = await rpc.api.apps[':appId'].usage.$get({ param: appParam(appId) });
  if (!response.ok) throw await responseError(response, 'Unable to load usage');
  return readAppUsage(await response.json());
}

// ─── Reading failures ─────────────────────────────────────

/** The validator's problems on a 400 `spec_invalid`, else undefined. */
export function specErrorsOf(error: unknown): AppSpecError[] | undefined {
  if (!(error instanceof TablesRequestError) || error.status !== 400) return undefined;
  if (error.details?.reason !== 'spec_invalid') return undefined;
  const errors = error.details.errors;
  return Array.isArray(errors) ? (errors as AppSpecError[]) : [];
}

/** A 409 revision conflict on the draft or the audience list. */
export function isRevisionConflict(error: unknown): error is TablesRequestError {
  return error instanceof TablesRequestError && error.status === 409;
}

/** 403 `owner_only`: only the Base owner (or a super) may publish or change audiences (D2). */
export function isOwnerOnly(error: unknown): boolean {
  return error instanceof TablesRequestError && error.status === 403;
}
