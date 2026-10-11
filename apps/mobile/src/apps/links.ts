/**
 * Opening an app's links on the phone (an `open_url` button). A web page opens
 * in the in-app browser (src/lib/links.ts). An in-app link (`#/…`, the web's
 * routes — the builder's default for a new link) goes to this app's own screen
 * when there is one, read by `inAppLink` (./model.ts): the app center, an app
 * (this one: switch its page), a record through an app, Tables (a Base, a
 * table, a record, a dashboard — when Tables is on here), a form. Anything
 * else is the web app's page on this station, in the in-app browser.
 */

import type { useRouter } from 'expo-router';
import { openLink } from '../lib/links';
import { getApiBase } from '../store/stations';
import { tablesEnabledNow } from '../tables/availability';
import { inAppLink } from './model';

type Router = ReturnType<typeof useRouter>;

export function openAppLink(
  router: Router,
  url: string,
  here: { appId: number; openPage: (pageId: string | null) => void },
  accent?: string,
): void {
  const href = url.trim();
  if (!href.startsWith('#/')) {
    void openLink(href, accent);
    return;
  }
  const target = inAppLink(href);
  const tables = tablesEnabledNow('tables');
  switch (target?.kind) {
    case 'app_center':
      router.push('/apps');
      return;
    case 'app':
      if (target.appId === here.appId && target.recordId === undefined) {
        here.openPage(target.pageId ?? null);
        return;
      }
      router.push({
        pathname: '/apps/[appId]',
        params: {
          appId: String(target.appId),
          ...(target.pageId ? { page: target.pageId } : {}),
          ...(target.recordId ? { record: String(target.recordId) } : {}),
        },
      });
      return;
    case 'tables':
      if (!tables) break;
      router.push('/tables');
      return;
    case 'base':
      if (!tables) break;
      router.push({ pathname: '/tables/[baseId]', params: { baseId: String(target.baseId) } });
      return;
    case 'table':
      if (!tables) break;
      if (target.recordId) {
        router.push({
          pathname: '/tables/record/[recordId]',
          params: { recordId: String(target.recordId), tableId: String(target.tableId), baseId: String(target.baseId) },
        });
      } else {
        router.push({
          pathname: '/tables/table/[tableId]',
          params: { tableId: String(target.tableId), baseId: String(target.baseId) },
        });
      }
      return;
    case 'dashboard':
      if (!tables) break;
      router.push({ pathname: '/tables/dashboard/[dashboardId]', params: { dashboardId: String(target.dashboardId) } });
      return;
    case 'form':
      router.push({ pathname: '/forms/[formId]', params: { formId: String(target.formId) } });
      return;
  }
  // No screen for it here (or Tables is off on this phone): the web app's page on this station.
  void openLink(`${getApiBase().replace(/\/+$/, '')}/${href}`, accent);
}
