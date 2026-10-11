/**
 * The sidebar's Apps section (spec 20261011-tables-apps §6): the member's
 * pinned apps, then featured ones — both from the server (`useAppsStore`,
 * pins are server-side, D9). Renders nothing without the `apps` feature or
 * when there is nothing to list; "All apps" always leads to the app center.
 *
 * Three presentations of the same list: the expanded rail (rows), the
 * collapsed rail (tiles) and the mobile drawer (larger rows).
 */

import { useEffect, useMemo } from 'react';
import type { AppSummary } from '@greenhouse/types/apps';
import { AppBadge } from '../../apps';
import { APP_CENTER_HREF, appHref, parseAppRoute } from '../../../lib/app-routes';
import { canUseFeature } from '../../../lib/features';
import { useT } from '../../../lib/i18n';
import { LayoutGrid, Pin, Star } from '../../../lib/icons';
import { useAuthStore } from '../../../stores';
import { sidebarApps, useAppsStore } from '../../../stores/apps-store';

/** Rows before the section stops growing — every app stays reachable from the app center. */
const PINNED_LIMIT = 8;
const FEATURED_LIMIT = 3;
const COLLAPSED_LIMIT = 5;

interface AppsSectionProps {
  /** Current hash, to mark the open app. */
  currentHash: string;
  onNavigate?: () => void;
}

function useSidebarApps(currentHash: string) {
  const currentUser = useAuthStore((state) => state.currentUser);
  const enabled = canUseFeature(currentUser, 'apps');
  const catalog = useAppsStore((state) => state.catalog);
  const pinnedIds = useAppsStore((state) => state.pinnedIds);
  const load = useAppsStore((state) => state.load);
  // Only the first mount asks: after a failure the sidebar stays quiet (the app
  // center offers the retry) instead of re-asking every time a rail mounts.
  useEffect(() => {
    if (enabled && useAppsStore.getState().status === 'idle') void load();
  }, [enabled, load]);
  const lists = useMemo(
    () => (enabled ? sidebarApps(catalog, pinnedIds) : { pinned: [], featured: [] }),
    [catalog, enabled, pinnedIds],
  );
  const [path] = currentHash.replace(/^#\/?/, '').split('?');
  const route = path.startsWith('apps/') ? parseAppRoute(path.slice('apps/'.length)) : null;
  const activeAppId = route && (route.kind === 'runtime' || route.kind === 'builder') ? route.appId : null;
  return {
    pinned: lists.pinned.slice(0, PINNED_LIMIT),
    featured: lists.featured.slice(0, FEATURED_LIMIT),
    activeAppId,
  };
}

function AppRow({
  app,
  active,
  onNavigate,
  mobile = false,
}: {
  app: AppSummary;
  active: boolean;
  onNavigate?: () => void;
  mobile?: boolean;
}) {
  return (
    <a
      href={appHref(app.id)}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      title={app.name}
      data-testid={`sidebar-app-${app.id}`}
      className={`flex w-full items-center rounded-lg transition-colors ${
        mobile ? 'min-h-11 gap-3 px-3 py-2 text-sm' : 'min-h-11 gap-2 px-2 py-1 text-xs md:min-h-7'
      } ${
        active ? 'sidebar-active-item font-semibold text-fg' : 'text-fg-secondary hover:bg-surface-muted hover:text-fg'
      }`}
    >
      <AppBadge icon={app.icon} accent={app.accent} size={mobile ? 'sm' : 'xs'} />
      <span className="min-w-0 flex-1 truncate">{app.name}</span>
    </a>
  );
}

function SubHeading({ icon: Icon, label }: { icon: typeof Pin; label: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-[10px] font-medium text-fg-faint">
      <Icon size={10} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Expanded desktop rail. */
export function AppsSection({ currentHash, onNavigate }: AppsSectionProps) {
  const t = useT();
  const { pinned, featured, activeAppId } = useSidebarApps(currentHash);
  if (pinned.length === 0 && featured.length === 0) return null;
  return (
    <section className="flex-shrink-0 px-2 pb-1" aria-label={t('apps.sidebar.section')} data-testid="sidebar-apps">
      <div className="flex items-center gap-1.5 px-1 py-1.5">
        <LayoutGrid size={11} className="text-fg-faint" aria-hidden="true" />
        <span className="flex-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
          {t('apps.sidebar.section')}
        </span>
        <a
          href={APP_CENTER_HREF}
          onClick={onNavigate}
          className="rounded px-1 text-[10px] text-fg-faint transition-colors hover:text-fg-secondary"
        >
          {t('apps.sidebar.allApps')}
        </a>
      </div>
      {pinned.length > 0 && featured.length > 0 && <SubHeading icon={Pin} label={t('apps.sidebar.pinned')} />}
      <div className="space-y-0.5">
        {pinned.map((app) => (
          <AppRow key={app.id} app={app} active={app.id === activeAppId} onNavigate={onNavigate} />
        ))}
      </div>
      {featured.length > 0 && (
        <>
          <SubHeading icon={Star} label={t('apps.sidebar.featured')} />
          <div className="space-y-0.5">
            {featured.map((app) => (
              <AppRow key={app.id} app={app} active={app.id === activeAppId} onNavigate={onNavigate} />
            ))}
          </div>
        </>
      )}
      <div className="mx-1 mt-1.5 border-t border-edge" />
    </section>
  );
}

/** Collapsed desktop rail: tiles only. */
export function AppsSectionCollapsed({ currentHash }: AppsSectionProps) {
  const { pinned, featured, activeAppId } = useSidebarApps(currentHash);
  const apps = [...pinned, ...featured].slice(0, COLLAPSED_LIMIT);
  if (apps.length === 0) return null;
  return (
    <div className="flex flex-col items-center gap-1 px-1.5 py-1" data-testid="sidebar-apps-collapsed">
      <div className="mb-0.5 w-5 border-t border-edge" />
      {apps.map((app) => (
        <a
          key={app.id}
          href={appHref(app.id)}
          title={app.name}
          aria-label={app.name}
          aria-current={app.id === activeAppId ? 'page' : undefined}
          className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
            app.id === activeAppId ? 'sidebar-active-item' : 'hover:bg-surface-muted'
          }`}
        >
          <AppBadge icon={app.icon} accent={app.accent} size="xs" />
        </a>
      ))}
    </div>
  );
}

/** Mobile navigation drawer. */
export function MobileAppsSection({ currentHash, onNavigate }: AppsSectionProps) {
  const t = useT();
  const { pinned, featured, activeAppId } = useSidebarApps(currentHash);
  if (pinned.length === 0 && featured.length === 0) return null;
  return (
    <section className="px-2 py-1" aria-label={t('apps.sidebar.section')} data-testid="mobile-apps">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <LayoutGrid size={11} className="text-fg-faint" aria-hidden="true" />
        <span className="flex-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
          {t('apps.sidebar.section')}
        </span>
        <a
          href={APP_CENTER_HREF}
          onClick={onNavigate}
          className="inline-flex min-h-11 items-center px-1 text-xs text-fg-faint hover:text-fg-secondary"
        >
          {t('apps.sidebar.allApps')}
        </a>
      </div>
      <div className="space-y-0.5">
        {[...pinned, ...featured].map((app) => (
          <AppRow key={app.id} app={app} active={app.id === activeAppId} onNavigate={onNavigate} mobile />
        ))}
      </div>
    </section>
  );
}
