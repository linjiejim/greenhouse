/**
 * The signed-in app (PRD §6, layout.md): rail 64, directory 256 (collapsible), the workspace,
 * and at most one drawer over it. Below 1024 the directory is a drawer; below 768 the rail
 * gives way to the module bar inside that drawer and details open as sheets.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRoute } from '../lib/router';
import { MEDIUM, NARROW, store, stored, useMedia } from '../lib/media';
import { cx } from '../lib/cx';
import { useT } from '../lib/i18n';
import { ShellContext } from './context';
import { CommandPalette } from './CommandPalette';
import { Directory } from './Directory';
import { ModuleBar } from './ModuleBar';
import { moduleOf } from './modules';
import { OverlayContext, type OverlayRequest } from './overlays';
import { Rail } from './Rail';
import { ErrorBoundary } from './ErrorBoundary';
import { ErrorBox } from '@greenhouse/ui/kit';
import { Workspace } from './Workspace';
import { OverlayHost } from './OverlayHost';

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
  const module = moduleOf(route);

  // A new page closes the directory drawer.
  useEffect(() => setDrawer(false), [route]);

  useEffect(() => {
    document.documentElement.toggleAttribute('data-narrow', narrow);
  }, [narrow]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  const showDirectory = floating ? drawer : !collapsed;
  let directory: ReactNode = null;
  if (showDirectory) {
    directory = (
      <aside className={cx('app-directory', floating && 'is-floating')} aria-label={t('nav.directory')}>
        <Directory module={module} route={route} floating={floating} onHide={hide} />
        {narrow && <ModuleBar module={module} />}
      </aside>
    );
  }

  return (
    <ShellContext.Provider value={shell}>
      <OverlayContext.Provider value={setOverlay}>
        <div className="app-shell" data-floating-boundary>
          {!narrow && <Rail module={module} />}
          {floating && drawer && <div className="app-directory-scrim" onClick={() => setDrawer(false)} aria-hidden />}
          {directory}
          <main className="app-workspace">
            <ErrorBoundary
              key={location.hash}
              fallback={(retry) => (
                <div className="app-center">
                  <ErrorBox onRetry={retry}>{t('common.pageFailed')}</ErrorBox>
                </div>
              )}
            >
              <Workspace route={route} />
            </ErrorBoundary>
          </main>
          {palette && <CommandPalette onClose={() => setPalette(false)} />}
          {overlay && <OverlayHost request={overlay} onClose={() => setOverlay(null)} />}
        </div>
      </OverlayContext.Provider>
    </ShellContext.Provider>
  );
}
