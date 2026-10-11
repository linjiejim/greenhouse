/**
 * Addresses of user-built apps (spec 20261011-tables-apps §6) — the one place
 * that knows their shape, for the router, links, the sidebar and the Assistant
 * context:
 *
 *   #/apps                       the app center
 *   #/apps/<id>[/<pageId>]       a page of the published app (`?record=<id>` opens a record)
 *   #/apps/<id>/edit             the builder (the app's draft)
 *
 * Managers may add `?previewRole=<key>` (the app as one role gets it) and
 * `?draft=1` (the draft instead of the published version) to a runtime
 * address — `appPreviewHref` writes them, `appPreviewScope` reads them back.
 */

import { APP_BUILDER_SEGMENT } from '@greenhouse/types/apps';

/** The sub-path segment that turns an app address into its builder (the validator reserves it as a page id). */
export { APP_BUILDER_SEGMENT };

export type AppRoute =
  | { kind: 'center' }
  | { kind: 'runtime'; appId: number; pageId?: string }
  | { kind: 'builder'; appId: number }
  | { kind: 'invalid' };

/** A hash segment as written; a malformed escape stays as typed instead of throwing. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** `subPath` is everything after `#/apps/` and before `?`. */
export function parseAppRoute(subPath: string): AppRoute {
  const segments = subPath.split('/').filter(Boolean);
  if (segments.length === 0) return { kind: 'center' };
  const appId = Number(segments[0]);
  if (!Number.isInteger(appId) || appId <= 0 || segments.length > 2) return { kind: 'invalid' };
  if (segments[1] === APP_BUILDER_SEGMENT) return { kind: 'builder', appId };
  return segments[1] ? { kind: 'runtime', appId, pageId: decodeSegment(segments[1]) } : { kind: 'runtime', appId };
}

export const APP_CENTER_HREF = '#/apps';

export function appHref(appId: number, pageId?: string): string {
  return pageId ? `#/apps/${appId}/${encodeURIComponent(pageId)}` : `#/apps/${appId}`;
}

export function appBuilderHref(appId: number): string {
  return `#/apps/${appId}/${APP_BUILDER_SEGMENT}`;
}

/** Where a notification or a link about one record of an app lands (spec §3 notifications). */
export function appRecordHref(appId: number, recordId: number, pageId?: string): string {
  return `${appHref(appId, pageId)}?record=${recordId}`;
}

/**
 * How a manager previews an app (the gateway honours both for managers only):
 * `previewRole` = as one of its roles (absent: full access), `draft` = the
 * draft instead of the published version. One object travels from the address
 * to every gateway call, so the role and the draft never drift apart.
 */
export interface AppPreviewScope {
  previewRole?: string;
  draft?: true;
}

/** A scope without absent keys (it is spread into requests as it is). */
export function appPreviewScopeOf(previewRole: string | undefined, draft: boolean | undefined): AppPreviewScope {
  return { ...(previewRole ? { previewRole } : {}), ...(draft ? { draft: true as const } : {}) };
}

/** The scope a runtime address asks for (`?previewRole=<key>`, `?draft=1`). */
export function appPreviewScope(params: URLSearchParams | undefined): AppPreviewScope {
  const draft = params?.get('draft');
  return appPreviewScopeOf(params?.get('previewRole') || undefined, draft === '1' || draft === 'true');
}

/**
 * A runtime address in a manager's preview: `?draft=1` for the draft,
 * `?previewRole=<key>` for one role's view (no scope = the published app with
 * the manager's full access). The builder's "Preview" and the runtime's role
 * switch both come here, so the draft flag survives switching roles.
 */
export function appPreviewHref(appId: number, preview: AppPreviewScope, pageId?: string): string {
  const query = new URLSearchParams();
  if (preview.draft) query.set('draft', '1');
  if (preview.previewRole) query.set('previewRole', preview.previewRole);
  const search = query.toString();
  return search ? `${appHref(appId, pageId)}?${search}` : appHref(appId, pageId);
}
