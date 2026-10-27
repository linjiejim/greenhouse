import React, { useEffect, useState } from 'react';
import { useT } from '../lib/i18n';
import { useRouter } from 'expo-router';
import { WideShell } from '../shell/wide-shell.web';
import { useAuth } from '../store/auth';
import { getApiBase, useStations } from '../store/stations';
import { useNotifications } from '../store/notifications';
import { useInspector } from '../shell/inspector.web';
import { hasInteractiveOverlay } from '../ui/overlay.web';
import { useShortcut } from '../ui/use-shortcut';
import { captureIdentity } from '../data/identity';
import { getAccessToken, onTokensChanged, hydrateTokens, getCachedUser } from '../api/token-storage';
import { desktopLink } from './deep-links';
import { invoke, listenNative, nativeApi, reportNativeError } from './native';
import { QuickAsk } from './quick-ask.web';
import { connectNotifications } from './live-notifications';
import { SHORTCUTS } from './shortcuts';

export function ClientShell({ children }: { children: React.ReactNode }) {
  const label = window.__GREENHOUSE_WINDOW__ ?? 'main';
  const router = useRouter(),
    t = useT();
  const user = useAuth((s) => s.user),
    loading = useAuth((s) => s.loading),
    station = useStations((s) => s.activeId);
  const userId = user?.id;
  const [token, setToken] = useState(getAccessToken),
    [error, setError] = useState('');
  const unread = useNotifications((s) => s.unread);
  useEffect(() => onTokensChanged(() => setToken(getAccessToken())), []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = (event: StorageEvent) => {
      if (
        event.key === 'greenhouse_desktop:greenhouse_pref_stations' ||
        event.key === 'greenhouse_desktop:greenhouse_pref_active_station'
      ) {
        void useAuth.getState().bootstrap();
      } else if (event.key === 'greenhouse_desktop:session_revision') {
        clearTimeout(timer);
        timer = setTimeout(() => {
          void hydrateTokens(useStations.getState().activeId)
            .then(() => {
              const cached = getCachedUser();
              // A sign-in/out in any window changes every surface immediately.
              if (!getAccessToken()) useAuth.setState({ user: null });
              else if (cached) useAuth.setState({ user: cached });
            })
            .catch(reportNativeError);
        }, 50);
      }
    };
    const originalOpen = window.open;
    window.open = (url) => {
      if (url) void invoke('open_external', { url: String(url) }).catch(reportNativeError);
      return null;
    };
    window.addEventListener('storage', changed);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('storage', changed);
      window.open = originalOpen;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.desktopWindow = label;
    const report = (e: Event) => setError((e as CustomEvent<string>).detail);
    window.addEventListener('desktop:error', report);
    return () => window.removeEventListener('desktop:error', report);
  }, [label]);
  useEffect(() => {
    const api = nativeApi();
    const stops = [
      listenNative<string>(api, 'desktop:shortcut', (shortcut) =>
        window.dispatchEvent(new CustomEvent('greenhouse:shortcut', { detail: shortcut })),
      ),
      listenNative<string>(api, 'desktop:place', (id) =>
        window.dispatchEvent(new CustomEvent('greenhouse:place', { detail: id })),
      ),
      listenNative(api, 'desktop:update', () => {
        void invoke<boolean>('check_update')
          .then((found) => {
            if (!found) setError(t('desktop.noUpdate'));
          })
          .catch(reportNativeError);
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, [router, t]);
  useEffect(() => {
    if (label === 'settings' && userId && !loading) router.replace('/me');
  }, [label, userId, loading, router]);
  useEffect(() => {
    if (label !== 'main' || loading || !userId) return;
    let alive = true;
    const current = captureIdentity();
    const drain = () => {
      void invoke<string[]>('take_links')
        .then((links) => {
          if (!alive || !current()) return;
          for (const link of links) {
            const route = desktopLink(link);
            if (route) router.navigate(route as never);
          }
        })
        .catch(reportNativeError);
    };
    const routes = () => {
      void invoke<string[]>('take_routes')
        .then((pending) => {
          if (!alive || !current()) return;
          for (const route of pending) router.navigate(route as never);
        })
        .catch(reportNativeError);
    };
    const stopRoutes = listenNative(nativeApi(), 'desktop:routes', routes);
    const stop = listenNative(nativeApi(), 'desktop:links', drain);
    routes();
    drain();
    return () => {
      alive = false;
      stop();
      stopRoutes();
    };
  }, [label, loading, userId, station, router]);
  useEffect(() => {
    if (label !== 'main') return;
    void invoke('notify_unread', { unread: user ? Math.max(0, unread) : 0 }).catch(reportNativeError);
  }, [label, unread, user]);
  useEffect(() => {
    if (label !== 'main' || !userId || !token) return;
    const current = captureIdentity();
    const url = new URL('/api/ws', getApiBase());
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', token);
    void useNotifications.getState().refresh();
    return connectNotifications({
      url: url.href,
      current,
      message: (event) => {
        if (event.type !== 'notification:new' && event.type !== 'notification:summary') return;
        const count = typeof event.unread === 'number' ? Math.max(0, event.unread) : 0;
        useNotifications.setState({ unread: count });
        void invoke('notify_unread', {
          unread: count,
          title: event.type === 'notification:new' && typeof event.title === 'string' ? event.title : null,
        }).catch(reportNativeError);
        if (event.type === 'notification:new') void useNotifications.getState().refresh();
      },
    });
  }, [label, userId, station, token]);
  useShortcut(SHORTCUTS.close, () => {
    if (hasInteractiveOverlay()) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }
    const close = useInspector.getState().close;
    if (close) close();
    else void invoke('close_window').catch(reportNativeError);
  });
  useShortcut('Escape', () => {
    if (label === 'quick-ask' && !hasInteractiveOverlay()) void invoke('close_window').catch(reportNativeError);
  });
  return (
    <>
      {label !== 'quick-ask' ? (
        <div
          data-tauri-drag-region
          style={{
            position: 'fixed',
            left: 0,
            top: 0,
            width: label === 'settings' ? 220 : 72,
            height: 52,
            zIndex: 1000,
          }}
        />
      ) : null}
      {label === 'quick-ask' ? (
        <>
          <div style={{ display: 'none' }}>{children}</div>
          <QuickAsk />
        </>
      ) : label === 'settings' && user ? (
        children
      ) : (
        <WideShell>{children}</WideShell>
      )}
      {error ? (
        <div role="alert" className="gh-desktop-error">
          <span>{error}</span>
          <button onClick={() => setError('')}>×</button>
        </div>
      ) : null}
    </>
  );
}
