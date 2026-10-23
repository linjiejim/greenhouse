/**
 * Links from outside the app (widgets, notifications, the share sheet's return) before Expo Router
 * opens them: a widget item opens only on the station it came from — its `station` stays on the
 * route until it is checked against the active station (src/widget/model.ts, src/widget/station-gate.tsx).
 */

import { widgetLinkPath } from '../src/widget/model';
import { useStations } from '../src/store/stations';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return widgetLinkPath(path, useStations.getState().activeId);
  } catch {
    return path;
  }
}
