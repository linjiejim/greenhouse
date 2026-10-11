/**
 * Who sees Tables and Apps on the phone, and where (spec
 * docs/specs/20261011-mobile-tables-apps.md §4): iOS (Android hides the
 * entries in v1, D3 — the SwiftUI routes have `.android.tsx` forwarders), a
 * settled auth state (`useAuth.loading` covers startup and a station switch),
 * an internal account, and the server's feature switch — `features.tables`
 * for the Tables section, `features.apps` for the app center (a member can be
 * given an app without the Tables module, apps spec D1). Missing = off (an
 * older server has neither).
 */

import { Platform } from 'react-native';
import type { AuthenticatedUser } from '../shared/greenhouse-types';
import { isInternal } from '../bots/availability';
import { useAuth } from '../store/auth';

/** v1 ships on iOS only (spec D3); Android gets the views later. */
export const TABLES_PLATFORM_READY: boolean = Platform.OS === 'ios';

export type TablesArea = 'tables' | 'apps';

function enabled(area: TablesArea, user: AuthenticatedUser | null, loading: boolean): boolean {
  return TABLES_PLATFORM_READY && !loading && isInternal(user) && user?.features?.[area] === true;
}

export function useTablesEnabled(): boolean {
  const user = useAuth((s) => s.user);
  const loading = useAuth((s) => s.loading);
  return enabled('tables', user, loading);
}

export function useAppsEnabled(): boolean {
  const user = useAuth((s) => s.user);
  const loading = useAuth((s) => s.loading);
  return enabled('apps', user, loading);
}

/** Non-hook snapshot (link routing: an entity link opens a native peek only when Tables is on). */
export function tablesEnabledNow(area: TablesArea = 'tables'): boolean {
  const { user, loading } = useAuth.getState();
  return enabled(area, user, loading);
}
