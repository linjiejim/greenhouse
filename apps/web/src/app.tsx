/**
 * Greenhouse — Web UI entry point.
 * Hash-based routing: #/chat, #/history, #/settings, #/projects
 *
 * NEW LAYOUT: Global left sidebar + simplified top bar + main content.
 * UI 子组件拆分到 components/app/ 目录下。
 */

import './app.css';
// Fork branding token overrides (S6) — comment-only upstream. Imported after
// app.css so redefinitions win the cascade.
import './branding.css';
// Fork runtime web extensions (URL context resolvers, locale messages). No-op
// upstream — see bootstrap.extensions.ts. Imported first so registrations run
// before the app renders.
import './bootstrap.extensions';
import React, { useState, useEffect, useMemo, useCallback, useRef, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPage } from './pages/chat';

// Lazy-loaded route pages for code splitting
const ProjectsPage = lazy(() => import('./pages/projects').then((m) => ({ default: m.ProjectsPage })));
const ProjectDetailPage = lazy(() => import('./pages/project-detail').then((m) => ({ default: m.ProjectDetailPage })));
const SettingsPage = lazy(() => import('./pages/settings').then((m) => ({ default: m.SettingsPage })));
const InboxPage = lazy(() => import('./pages/inbox').then((m) => ({ default: m.InboxPage })));
const DesignPage = lazy(() => import('./pages/design').then((m) => ({ default: m.DesignPage })));
const KnowledgePage = lazy(() => import('./pages/knowledge').then((m) => ({ default: m.KnowledgePage })));
import { AgentProvider } from './components/agent-context';
import { GlobalAgentPanel } from './components/agent-panel';
import { SessionManagerProvider } from './lib/session-manager';
import { Drawer, AppLogo, ToastContainer, ErrorBoundary, Spinner } from './components/ui';
import { MessageCircle, FolderKanban, Plus, ArrowLeft, BookOpen } from './lib/icons';
import type { LucideIcon } from './lib/icons';
import { authFetch, checkAuthStatus, clearToken, setOnUnauthorized, validateSession } from './lib/auth';
import { LoginScreen, AppSidebar, SidebarAccountMenu, TopBar } from './components/app';
import { MobilePinnedSection, SettingsNavPanel } from './components/app/sidebar-panels';
import { useAuthStore, useUIStore, useProfileStore } from './stores';
import { useWsStore } from './stores/ws-store';
import { initTheme } from './lib/theme';
import { initScrollActivity } from './lib/scroll-activity';
import { I18nProvider, useT, getStoredLocale } from './lib/i18n';
import type { Locale } from './lib/i18n';
import { getExtraPage, extraPageKeys, extraNavItems } from './lib/page-registry';

// Initialize theme from localStorage on app load
initTheme();
// Reveal scrollbars only while scrolling (they're transparent at rest)
initScrollActivity();

// ─── Router ──────────────────────────────────────────────

// Core routes keep literal typing; `(string & {})` admits fork page keys
// registered via ./lib/page-registry (see extraPageKeys).
type Route = 'chat' | 'history' | 'settings' | 'projects' | 'inbox' | 'design' | 'knowledge' | (string & {});

interface ParsedRoute {
  route: Route;
  subPath: string;
  params: URLSearchParams;
}

function useHashRouter() {
  const [hash, setHash] = useState(window.location.hash || '#/chat');
  useEffect(() => {
    const handler = () => setHash(window.location.hash || '#/chat');
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  return hash;
}

function parseRoute(hash: string): ParsedRoute {
  const cleaned = hash.replace(/^#\/?/, '');
  const [path, query] = cleaned.split('?');
  const segments = path.split('/');
  const topLevel = segments[0] || 'chat';

  // Redirect legacy routes into settings
  if (topLevel === 'prompts') {
    window.location.hash = '#/settings/prompts';
    return { route: 'settings', subPath: 'prompts', params: new URLSearchParams(query || '') };
  }

  const route = (
    ['chat', 'history', 'settings', 'projects', 'inbox', 'design', 'knowledge', ...extraPageKeys()].includes(topLevel)
      ? topLevel
      : 'chat'
  ) as Route;
  const subPath = segments.slice(1).join('/');
  return { route, subPath, params: new URLSearchParams(query || '') };
}

// ─── App ─────────────────────────────────────────────────

function App() {
  const { authState, currentUser, login, logout, updateUser: _updateUser } = useAuthStore();
  const [userLocale, setUserLocale] = useState<Locale>(getStoredLocale());
  const hash = useHashRouter();
  const { route, subPath, params } = useMemo(() => parseRoute(hash), [hash]);

  // Sync locale to backend when user changes it
  const handleLocaleChange = useCallback(
    (locale: Locale) => {
      setUserLocale(locale);
      if (currentUser && currentUser.id !== 'external' && currentUser.id !== 'dev') {
        authFetch('/api/auth/me/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale }),
        }).catch(() => {});
      }
    },
    [currentUser],
  );

  const handleUnauthorized = useCallback(() => {
    clearToken();
    logout();
    useProfileStore.getState().clear();
  }, [logout]);

  useEffect(() => {
    setOnUnauthorized(handleUnauthorized);

    (async () => {
      const authEnabled = await checkAuthStatus();
      if (!authEnabled) {
        login({ id: 'dev', nickname: 'Dev', role: 'super', profiles: [] });
        return;
      }

      const user = await validateSession();
      if (user) {
        login(user);
        if (user.locale && (user.locale === 'en' || user.locale === 'zh')) {
          setUserLocale(user.locale as Locale);
        }
        useAuthStore.getState().setAuthState('authenticated');
      } else {
        clearToken();
        useAuthStore.getState().setAuthState('needs-login');
      }
    })();
  }, [handleUnauthorized]);

  // ── WebSocket lifecycle: connect on login, disconnect on logout ──
  useEffect(() => {
    const unsub = useAuthStore.subscribe((state, prev) => {
      if (state.authState === 'authenticated' && prev.authState !== 'authenticated') {
        useWsStore.getState().connect();
      }
      if (state.authState !== 'authenticated' && prev.authState === 'authenticated') {
        useWsStore.getState().disconnect();
      }
    });
    // If already authenticated (e.g. page refresh with valid token), connect now
    if (useAuthStore.getState().authState === 'authenticated') {
      useWsStore.getState().connect();
    }
    return unsub;
  }, []);

  if (authState === 'checking') {
    return (
      <I18nProvider initialLocale={userLocale} onLocaleChange={handleLocaleChange}>
        <LoadingScreen />
      </I18nProvider>
    );
  }

  if (authState === 'needs-login') {
    return (
      <I18nProvider initialLocale={userLocale} onLocaleChange={handleLocaleChange}>
        <LoginScreen
          onSuccess={(user) => {
            login(user);
            if (user.locale && (user.locale === 'en' || user.locale === 'zh')) {
              setUserLocale(user.locale as Locale);
            }
            useAuthStore.getState().setAuthState('authenticated');
          }}
        />
      </I18nProvider>
    );
  }

  return (
    <I18nProvider initialLocale={userLocale} onLocaleChange={handleLocaleChange}>
      <AgentProvider>
        <SessionManagerProvider>
          <AppShell route={route} subPath={subPath} params={params} />
          <ToastContainer />
        </SessionManagerProvider>
      </AgentProvider>
    </I18nProvider>
  );
}

// ─── App Shell — new sidebar-first layout ────────────────

interface AppShellProps {
  route: Route;
  subPath: string;
  params: URLSearchParams;
}

function AppShell({ route, subPath, params }: AppShellProps) {
  const t = useT();
  const { currentUser, logout } = useAuthStore();
  const { navOpen, setNavOpen, currentSessionTitle, currentSessionProfileId, currentChatSessionId } = useUIStore();

  const userRole = currentUser?.role ?? 'external';
  const isExternal = userRole === 'external';

  // Session ID from store (synced by ChatPage internally)
  const currentSessionId = currentChatSessionId;
  const previousNonSettingsHashRef = useRef('#/chat');

  useEffect(() => {
    if (route !== 'settings') {
      previousNonSettingsHashRef.current = window.location.hash || '#/chat';
    }
  }, [route, subPath, params]);

  const _onSignOut = useCallback(() => {
    clearToken();
    logout();
    setNavOpen(false);
    useProfileStore.getState().clear();
  }, [logout, setNavOpen]);

  const handleBackFromSettings = useCallback(() => {
    const target = previousNonSettingsHashRef.current?.startsWith('#/settings')
      ? '#/chat'
      : previousNonSettingsHashRef.current || '#/chat';
    window.location.hash = target;
  }, []);

  const handleNewChat = useCallback(() => {
    window.location.hash = `#/chat?new=${Date.now()}`;
  }, []);

  const handleSelectSession = useCallback((sessionId: string) => {
    window.location.hash = `#/chat?session=${sessionId}`;
  }, []);

  // Navigation items for mobile drawer (+ fork pages that opt into the nav)
  const navItems: Array<{ key: Route; label: string; icon: LucideIcon; visible: boolean }> = [
    { key: 'chat', label: t('app.chat'), icon: MessageCircle, visible: true },
    { key: 'projects', label: t('app.projects'), icon: FolderKanban, visible: !isExternal },
    { key: 'knowledge', label: t('app.knowledge'), icon: BookOpen, visible: !isExternal },
    ...extraNavItems({ isExternal, userRole }),
  ];

  return (
    <>
      <div className="h-screen flex overflow-hidden bg-surface-sunken">
        {/* Global Left Sidebar — desktop only */}
        <AppSidebar
          route={route}
          subPath={subPath}
          currentSessionId={currentSessionId}
          onSelectSession={handleSelectSession}
          onNewChat={handleNewChat}
          onSignOut={_onSignOut}
          onBackFromSettings={handleBackFromSettings}
        />

        {/* Right side: TopBar + Main Content */}
        <div className="flex flex-col flex-1 min-w-0 h-full py-2 pr-2">
          {/* Simplified Top Bar */}
          <TopBar
            route={route}
            subPath={subPath}
            sessionTitle={currentSessionTitle}
            sessionProfileId={currentSessionProfileId}
            isExternal={isExternal}
          />

          {/* Mobile navigation drawer */}
          <Drawer open={navOpen} onClose={() => setNavOpen(false)}>
            <div className="px-4 py-4 border-b border-edge flex items-center justify-between gap-3">
              <AppLogo size="sm" showVersion />
              <button
                onClick={() => {
                  handleNewChat();
                  setNavOpen(false);
                }}
                className="h-8 w-8 flex items-center justify-center rounded-lg text-fg-muted hover:text-fg-secondary hover:bg-surface-muted transition-colors"
                title="New Chat"
                aria-label="New Chat"
              >
                <Plus size={15} />
              </button>
            </div>
            {route === 'settings' ? (
              <>
                <div className="px-3 py-3 border-b border-edge">
                  <button
                    onClick={() => {
                      handleBackFromSettings();
                      setNavOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors"
                  >
                    <ArrowLeft size={14} />
                    <span>Back</span>
                  </button>
                </div>
                <div className="flex-1 min-h-0 overflow-hidden">
                  <SettingsNavPanel
                    activeModule={subPath.split('/').filter(Boolean)[0] || 'preferences'}
                    onSignOut={_onSignOut}
                  />
                </div>
              </>
            ) : (
              <>
                <nav
                  className="mx-3 mb-2 flex items-stretch gap-1 rounded-xl bg-surface-sunken p-1 overflow-x-auto"
                  aria-label="Main navigation"
                >
                  {navItems
                    .filter((item) => item.visible)
                    .map((item) => {
                      const Icon = item.icon;
                      const isActive = route === item.key;
                      return (
                        <a
                          key={item.key}
                          href={`#/${item.key}`}
                          onClick={() => setNavOpen(false)}
                          className={`flex h-12 min-w-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg border px-1 transition-colors ${
                            isActive
                              ? 'border-edge bg-surface-raised text-fg font-medium'
                              : 'border-transparent text-fg-muted hover:bg-surface-muted hover:text-fg-secondary'
                          }`}
                          title={item.label}
                        >
                          <Icon size={15} className={isActive ? 'text-primary-fg' : 'text-fg-faint'} />
                          <span className="max-w-full truncate text-[9px] leading-tight">{item.label}</span>
                        </a>
                      );
                    })}
                </nav>
                {/* Pinned shortcuts (mobile) */}
                <MobilePinnedSection
                  currentHash={`#/${route}${subPath ? '/' + subPath : ''}`}
                  onNavigate={() => setNavOpen(false)}
                />
              </>
            )}
            {/* User info at bottom of drawer */}
            {currentUser && (
              <div className="px-4 py-3 border-t border-edge">
                <SidebarAccountMenu
                  user={currentUser}
                  showSettingsIcon={!isExternal}
                  settingsActive={route === 'settings'}
                  onNavigate={() => setNavOpen(false)}
                />
              </div>
            )}
          </Drawer>

          {/* Page content */}
          <ErrorBoundary>
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-full">
                  <Spinner className="h-6 w-6 text-fg-faint" />
                </div>
              }
            >
              <main className="flex-1 overflow-hidden min-h-0">
                {route === 'chat' && (
                  <ChatPage
                    key={params.get('session') || params.get('new') || 'new'}
                    initialSessionId={params.get('session') || undefined}
                    userRole={userRole}
                  />
                )}
                {route === 'history' && !isExternal && <ChatPage key="from-history" userRole={userRole} />}
                {route === 'settings' && !isExternal && <SettingsPage subPath={subPath} />}
                {route === 'projects' &&
                  !isExternal &&
                  (subPath ? <ProjectDetailPage projectId={parseInt(subPath)} /> : <ProjectsPage />)}
                {route === 'inbox' && !isExternal && <InboxPage />}
                {route === 'design' && <DesignPage />}
                {route === 'knowledge' && !isExternal && <KnowledgePage subPath={subPath} basePath="#/knowledge" />}
                {route === 'history' && isExternal && <ChatPage key="fallback" userRole={userRole} />}
                {route === 'settings' && isExternal && (
                  <div className="flex items-center justify-center h-full text-fg-faint text-sm">
                    {t('app.noPermission')}
                  </div>
                )}
                {route === 'knowledge' && isExternal && (
                  <div className="flex items-center justify-center h-full text-fg-faint text-sm">
                    {t('app.noPermission')}
                  </div>
                )}
                {/* Private fork pages (empty upstream) — see lib/page-registry. */}
                {getExtraPage(route)?.render({ subPath, params, userRole, isExternal })}
              </main>
            </Suspense>
          </ErrorBoundary>

          <GlobalAgentPanel />
        </div>
      </div>
    </>
  );
}

// ─── Loading Screen ──────────────────────────────────────

function LoadingScreen() {
  const t = useT();
  return (
    <div className="h-screen flex items-center justify-center bg-surface-sunken">
      <div className="text-center">
        <div className="flex justify-center">
          <AppLogo logoOnly size="xl" />
        </div>
        <p className="text-sm text-fg-faint mt-2">{t('common.loading')}</p>
      </div>
    </div>
  );
}

// ─── Mount ───────────────────────────────────────────────

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
}
