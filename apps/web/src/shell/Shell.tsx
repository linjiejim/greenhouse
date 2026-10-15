import { PageConversation } from './PageConversation';
/**
 * The signed-in app (PRD §6, layout.md): rail 64, directory 256 (collapsible), the workspace,
 * and at most one drawer over it. Below 1024 the directory is a drawer; below 768 the rail
 * gives way to the module bar inside that drawer and details open as sheets.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSession } from '../app/session';
import { navigate, useRoute, type Route } from '../lib/router';
import { MEDIUM, NARROW, store, stored, useMedia } from '../lib/media';
import { cx } from '../lib/cx';
import { useT } from '../lib/i18n';
import { ShellContext } from './context';
import { CommandPalette } from './CommandPalette';
import { Directory } from './Directory';
import { ModuleBar } from './ModuleBar';
import { MODULES, moduleOf } from './modules';
import { OverlayContext, type OverlayRequest } from './overlays';
import { Rail } from './Rail';
import { ErrorBoundary } from './ErrorBoundary';
import { ErrorBox } from '@greenhouse/ui/kit';
import { Workspace } from './Workspace';
import { OverlayHost } from './OverlayHost';

const SETUP_SHOWN = 'greenhouse.setup-shown';

export function Shell() {
  const t = useT();
  const route = useRoute();
  const narrow = useMedia(NARROW);
  const medium = useMedia(MEDIUM);
  const floating = narrow || medium;
  const [collapsed, setCollapsed] = useState(() => stored('directory', 'open', ['open', 'closed']) === 'closed');
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [overlay, setOverlay] = useState<OverlayRequest | null>(null);
  const [pageConversation, setPageConversation] = useState<Route | null>(null);
  const [pageChats, setPageChats] = useState<Record<string, string>>({});
  const module = moduleOf(route);
  const { realtime, bootstrap, me } = useSession();
  // Say so only when a live connection dropped, not while it first connects.
  const [lost, setLost] = useState(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (realtime === 'open') {
      wasOpen.current = true;
      setLost(false);
      return;
    }
    if (!wasOpen.current) return;
    const timer = setTimeout(() => setLost(true), 3000);
    return () => clearTimeout(timer);
  }, [realtime]);

  useEffect(() => {
    document.title = `${t(MODULES[module].label)} · ${bootstrap?.name || t('app.name')}`;
  }, [module, bootstrap?.name, t]);

  // A new page closes the directory drawer.
  useEffect(() => setDrawer(false), [route]);

  // First deploy (ADM-12): an admin with no model service starts at 管理 → 服务, once per visit.
  useEffect(() => {
    if (me?.role !== 'admin' || me.capabilities.llm || sessionStorage.getItem(SETUP_SHOWN)) return;
    sessionStorage.setItem(SETUP_SHOWN, '1');
    navigate({ page: 'admin', section: 'services' }, { replace: true });
  }, [me]);

  useEffect(() => {
    document.documentElement.toggleAttribute('data-narrow', narrow);
  }, [narrow]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setOverlay(null);
        setPageConversation((open) => (open ? null : route));
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route]);

  const hide = useCallback(() => {
    if (floating) return setDrawer(false);
    setCollapsed(true);
    store('directory', 'closed');
  }, [floating]);

  const shell = useMemo(
    () => ({
      narrow,
      directoryHidden: floating ? !drawer : collapsed,
      openDirectory: () => {
        if (floating) return setDrawer(true);
        setCollapsed(false);
        store('directory', 'open');
      },
      openPalette: () => setPalette(true),
    }),
    [narrow, floating, drawer, collapsed],
  );

  const openOverlay = useCallback((request: OverlayRequest | null) => {
    setPageConversation(null);
    setOverlay(request);
  }, []);

  let directory: ReactNode = null;
  if (!floating || drawer) {
    directory = (
      <aside
        className={cx('app-directory', floating && 'is-floating', !floating && collapsed && 'is-collapsed')}
        aria-label={t('nav.directory')}
        inert={!floating && collapsed}
        aria-hidden={(!floating && collapsed) || undefined}
      >
        <Directory key={module} module={module} route={route} floating={floating} onHide={hide} />
        {narrow && <ModuleBar module={module} />}
      </aside>
    );
  }

  return (
    <ShellContext.Provider value={shell}>
      <OverlayContext.Provider value={openOverlay}>
        <div className="app-shell" data-floating-boundary>
          {!narrow && <Rail module={module} />}
          {floating && drawer && <div className="app-directory-scrim" onClick={() => setDrawer(false)} aria-hidden />}
          {directory}
          <main className="app-workspace">
            {lost && (
              <div className="app-offline" role="status">
                {t('common.offline')}
              </div>
            )}
            <ErrorBoundary
              key={
                'extension' in route
                  ? `${route.page}:${route.extension}:${route.page === 'extension' ? route.view + ':' + route.path : route.section}`
                  : 'id' in route
                    ? `${route.page}:${route.id}`
                    : route.page
              }
              fallback={(retry) => (
                <div className="app-center">
                  <ErrorBox onRetry={retry}>{t('common.pageFailed')}</ErrorBox>
                </div>
              )}
            >
              <Workspace route={route} />
            </ErrorBoundary>
          </main>
          {pageConversation && (
            <PageConversation
              key={JSON.stringify(pageConversation)}
              route={pageConversation}
              chatId={pageChats[JSON.stringify(pageConversation)]}
              onCreated={(id) => setPageChats((chats) => ({ ...chats, [JSON.stringify(pageConversation)]: id }))}
              onClose={() => setPageConversation(null)}
            />
          )}
          {palette && <CommandPalette onClose={() => setPalette(false)} />}
          {overlay && <OverlayHost request={overlay} onClose={() => setOverlay(null)} />}
        </div>
      </OverlayContext.Provider>
    </ShellContext.Provider>
  );
}
