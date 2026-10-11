/**
 * Member-built apps (spec 20261011-tables-apps §6): `#/apps` → the app center,
 * `#/apps/<id>[/<pageId>]` → the app as its viewer uses it, `#/apps/<id>/edit`
 * → the builder. Mounted behind the `apps` feature (app.tsx), not the Tables
 * gate — an app's audience need not use Tables; the gateway authorizes.
 */

import { EmptyState } from '../../components/ui';
import { parseAppRoute } from '../../lib/app-routes';
import { useT } from '../../lib/i18n';
import { LayoutGrid } from '../../lib/icons';
import { AppBuilderPage } from './app-builder';
import { AppCenterPage } from './center/app-center';
import { AppRuntimePage } from './runtime/app-runtime';

interface AppsPageProps {
  subPath?: string;
  /** The route's query: the runtime reads `record=<id>` (open that record) and `previewRole=<key>`. */
  params?: URLSearchParams;
}

export function AppsPage({ subPath = '', params }: AppsPageProps) {
  const t = useT();
  const route = parseAppRoute(subPath);
  switch (route.kind) {
    case 'center':
      return <AppCenterPage />;
    case 'runtime':
      return <AppRuntimePage key={route.appId} appId={route.appId} pageId={route.pageId} params={params} />;
    case 'builder':
      return <AppBuilderPage key={route.appId} appId={route.appId} />;
    case 'invalid':
      return <EmptyState icon={LayoutGrid} variant="page" tone="neutral" title={t('apps.runtime.invalidRoute')} />;
  }
}
