/**
 * Links from outside the app (widgets, notifications, the share sheet's return) before Expo Router
 * opens them: a widget item opens only on the station it came from — its `station` stays on the
 * route until it is checked against the active station (src/widget/model.ts, src/widget/station-gate.tsx).
 * While the app runs, a widget item opens over home: pushed above a sheet (Settings, a form) it
 * would become that sheet's root, with no back button and an empty bar.
 *
 * Other `greenhouse://` object links (`knowledge/doc?id=`, `tables/record?…`, `chat?session=`,
 * src/lib/deep-links.ts `appLinkTarget`) open their object the same way; routes this client
 * already has (`connectors/oauth-finish`, the dev client) pass through untouched.
 */

import { router } from 'expo-router';
import { appLinkTarget } from '../src/lib/deep-links';
import { targetPath } from '../src/shell/object-ref';
import { isWidgetItemPath, widgetLinkPath } from '../src/widget/model';
import { useStations } from '../src/store/stations';

/** An app link without a station, as the object path it names; the path itself when it names none. */
function appLinkPath(path: string): string {
  const link = /^greenhouse:/i.test(path) ? path : `greenhouse://${path.replace(/^\/+/, '')}`;
  const target = appLinkTarget(link);
  return target ? targetPath(target) : path;
}

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  try {
    const widget = widgetLinkPath(path, useStations.getState().activeId);
    const target = widget === path ? appLinkPath(path) : widget;
    const opensSheet = isWidgetItemPath(target) || (target !== path && target.startsWith('/sheet/'));
    if (!initial && opensSheet && router.canDismiss()) router.dismissTo('/');
    return target;
  } catch {
    return path;
  }
}
