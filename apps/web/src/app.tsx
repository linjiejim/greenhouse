/**
 * Greenhouse — Web UI entry point.
 * Hash-based routing for Chat, Knowledge, Projects, Tables, and Settings.
 *
 * LAYOUT: Full-height global/contextual sidebar + right-side top bar and content.
 * UI 子组件拆分到 components/app/ 目录下。
 */

import './app.css';
import React, { useState, useEffect, useMemo, useCallback, useRef, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPage } from './pages/chat';

// Lazy-loaded route pages for code splitting
const ProjectsPage = lazy(() => import('./pages/projects').then((m) => ({ default: m.ProjectsPage })));
const ProjectDetailPage = lazy(() => import('./pages/project-detail').then((m) => ({ default: m.ProjectDetailPage })));
const SettingsPage = lazy(() => import('./pages/settings').then((m) => ({ default: m.SettingsPage })));
const AdministrationPage = lazy(() =>
  import('./pages/administration').then((m) => ({ default: m.AdministrationPage })),
);
const DesignPage = lazy(() => import('./pages/design').then((m) => ({ default: m.DesignPage })));
const KnowledgePage = lazy(() => import('./pages/knowledge').then((m) => ({ default: m.KnowledgePage })));
const AgentsPage = lazy(() => import('./pages/agents').then((m) => ({ default: m.AgentsPage })));
const AutomationsPage = lazy(() => import('./pages/automations').then((m) => ({ default: m.AutomationsPanel })));
const PersonalTasksPage = lazy(() => import('./pages/tasks').then((m) => ({ default: m.PromptsPage })));
const SkillHubPage = lazy(() => import('./pages/skillhub').then((m) => ({ default: m.SkillHubPage })));
const ExecutionCenterPage = lazy(() => import('./pages/executions').then((m) => ({ default: m.ExecutionsPage })));
const TablesPage = lazy(() => import('./pages/tables').then((m) => ({ default: m.TablesPage })));
const OAuthConsentPage = lazy(() => import('./pages/oauth-consent').then((m) => ({ default: m.OAuthConsentPage })));
const AccountPasswordPage = lazy(() =>
  import('./pages/account-password').then((m) => ({ default: m.AccountPasswordPage })),
);
import { AgentProvider } from './components/agent-context';
import { compiledExtensionRoutes } from './extensions';
import { ExtensionPageHost, ExtensionSidebarPanel } from './extensions/host';
import { useExtensionsStore } from './stores/extensions-store';
import { AssistantPanel } from './components/agent-panel';
import { EntityPeekHost } from './components/entity-peek';
import { GlobalSearchDialog } from './components/search/global-search-dialog';
import { SessionManagerProvider } from './lib/session-manager';
import { ConfirmDialog, Drawer, AppLogo, ToastContainer, ErrorBoundary, Spinner, IconButton } from './components/ui';
import { Plus, X } from './lib/icons';
import { authFetch, clearToken, setOnUnauthorized, validateSession } from './lib/auth';
import { navigationBlocked } from './lib/navigation-guard';
import { LoginScreen, AppSidebar, SidebarAccountMenu, SidebarBackButton, TopBar } from './components/app';
import {
  ChatHistoryPanel,
  KnowledgeNavPanel,
  MobilePinnedSection,
  SettingsNavPanel,
  AdministrationNavPanel,
} from './components/app/sidebar-panels';
import { SidebarGlobalNavigation } from './components/app/sidebar-global-navigation';
import { SidebarPrimaryAction } from './components/app/sidebar-primary-action';
import { SearchNavButton } from './components/search/search-nav-button';
import { useAuthStore, useUIStore, useProfileStore } from './stores';
import { useWsStore } from './stores/ws-store';
import { initTheme } from './lib/theme';
import { initWorkspaceBranding } from './lib/workspace-branding';
import { initScrollActivity } from './lib/scroll-activity';
import { I18nProvider, useT, getStoredLocale } from './lib/i18n';
import type { Locale } from './lib/i18n';
import { buildPrimaryNavigation } from './platform/navigation';
import { usePlatformCatalog, usePlatformStore } from './stores/platform-store';
import { useMobileKeyboardViewport } from './hooks/use-mobile-keyboard-viewport';
import { legacyExecutionRedirect } from './lib/execution-route';

// Initialize theme from localStorage on app load
initTheme();
// Reveal scrollbars only while scrolling (they're transparent at rest)
initScrollActivity();

// ─── Router ──────────────────────────────────────────────

type Route =
  | 'chat'
  | 'extension'
  | 'automations'
  | 'agents'
  | 'settings'
  | 'administration'
  | 'projects'
  | 'design'
  | 'knowledge'
  | 'tables'
  | 'skillhub'
  | 'tasks'
  | 'executions';

interface ParsedRoute {
  route: Route;
  subPath: string;
  params: URLSearchParams;
  /** The extension page route (`#/<extensionRoute>`) when `route === 'extension'`. */
  extensionRoute?: string;
}

/**
 * The hash router, with a leave guard.
 *
 * A hash change cannot be cancelled — by the time `hashchange` fires the URL has
 * already moved. So when a screen has unsaved work we simply do NOT commit the
 * new hash: the app keeps rendering the current screen while the caller asks the
 * user. Confirming commits it; cancelling puts the URL back (which fires another
 * `hashchange` that matches what we are already rendering, and is ignored).
 */
function useHashRouter(): { hash: string; pending: string | null; confirmLeave: () => void; cancelLeave: () => void } {
  const [hash, setHash] = useState(window.location.hash || '#/chat');
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    const handler = () => {
      const next = window.location.hash || '#/chat';
      if (next === hash) {
        setPending(null);
        return;
      }
      if (navigationBlocked()) {
        setPending(next);
        return;
      }
      setHash(next);
    };
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, [hash]);

  const confirmLeave = useCallback(() => {
    setPending((target) => {
      if (target) setHash(target);
      return null;
    });
  }, []);
  const cancelLeave = useCallback(() => {
    setPending(null);
    // Back to where we still are. Same-value assignment fires no event, which is
    // exactly right — nothing to re-render.
    window.location.hash = hash;
  }, [hash]);

  return { hash, pending, confirmLeave, cancelLeave };
}

/**
 * Asks before a guarded screen is navigated away from. Rendered at the app root
 * because the guard lives in the router, not in any one screen — the screen that
 * is about to be left has no chance to render anything at this point.
 */
function LeaveConfirmDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <ConfirmDialog
      open={open}
      onClose={onCancel}
      onConfirm={onConfirm}
      title={t('common.unsavedTitle')}
      description={t('common.unsavedDesc')}
      confirmLabel={t('common.discardChanges')}
      confirmVariant="destructive"
    />
  );
}

function parseRoute(hash: string): ParsedRoute {
  const executionRedirect = legacyExecutionRedirect(hash);
  if (executionRedirect) {
    window.location.hash = executionRedirect;
    return parseRoute(executionRedirect);
  }

  const cleaned = hash.replace(/^#\/?/, '');
  const [path, query] = cleaned.split('?');
  const segments = path.split('/');
  const topLevel = segments[0] || 'chat';

  // Chat utilities used to be in-memory workspace switches. Keep those links
  // working, but canonicalize them to real pages so refresh/back/deep-links all
  // describe the screen the user is actually looking at.
  if (topLevel === 'chat') {
    const legacyView = new URLSearchParams(query || '').get('view');
    const destination =
      legacyView === 'automations'
        ? '#/automations'
        : legacyView === 'prompts'
          ? '#/tasks'
          : legacyView === 'agents'
            ? '#/agents'
            : null;
    if (destination) {
      window.location.hash = destination;
      return parseRoute(destination);
    }
  }

  // Redirect the retired prompt alias into its canonical independent page.
  if (topLevel === 'prompts') {
    window.location.hash = '#/tasks';
    return { route: 'tasks', subPath: '', params: new URLSearchParams() };
  }

  if (topLevel === 'sync') {
    const syncTail = segments.slice(1).filter(Boolean).join('/');
    const subPath = `wiki/sync${syncTail ? `/${syncTail}` : ''}`;
    window.location.hash = `#/knowledge/${subPath}`;
    return { route: 'knowledge', subPath, params: new URLSearchParams(query || '') };
  }

  if (topLevel === 'wiki') {
    const wikiTail = segments.slice(1).filter(Boolean).join('/');
    const destination = `#/knowledge/wiki${wikiTail ? `/${wikiTail}` : ''}`;
    window.location.hash = destination;
    return {
      route: 'knowledge',
      subPath: `wiki${wikiTail ? `/${wikiTail}` : ''}`,
      params: new URLSearchParams(query || ''),
    };
  }

  if (topLevel === 'eval') {
    const evalTail = segments.slice(1).filter(Boolean).join('/');
    const destination = `#/administration/eval${evalTail ? `/${evalTail}` : ''}`;
    window.location.hash = destination;
    return {
      route: 'administration',
      subPath: `eval${evalTail ? `/${evalTail}` : ''}`,
      params: new URLSearchParams(query || ''),
    };
  }

  if (topLevel === 'history') {
    window.location.hash = '#/chat';
    return { route: 'chat', subPath: '', params: new URLSearchParams() };
  }

  // The workbench is the Chat empty state now, so both the retired Apps page and
  // the short-lived standalone Home page redirect there. Old bookmarks keep
  // working; they just land on the screen that owns the cards.
  if (topLevel === 'workbench' || topLevel === 'home') {
    window.location.hash = '#/chat';
    return { route: 'chat', subPath: '', params: new URLSearchParams() };
  }

  // The old full-page inbox duplicated the account-menu dialog. Preserve old
  // bookmarks without keeping a second implementation alive.
  if (topLevel === 'inbox') {
    window.location.hash = '#/chat';
    return { route: 'chat', subPath: '', params: new URLSearchParams() };
  }

  // Retired routes from earlier product areas keep resolving so old links land
  // somewhere useful instead of on a dead page.
  if (topLevel === 'dashboard' || topLevel === 'inquiry') {
    window.location.hash = '#/chat';
    return { route: 'chat', subPath: '', params: new URLSearchParams() };
  }

  // Extension pages answer their own top-level segment; the host checks the
  // extension is active before rendering anything.
  if (compiledExtensionRoutes().has(topLevel)) {
    return {
      route: 'extension',
      extensionRoute: topLevel,
      subPath: segments.slice(1).join('/'),
      params: new URLSearchParams(query || ''),
    };
  }

  const route = (
    [
      'chat',
      'automations',
      'agents',
      'settings',
      'administration',
      'projects',
      'design',
      'knowledge',
      'tables',
      'skillhub',
      'tasks',
      'executions',
    ].includes(topLevel)
      ? topLevel
      : 'chat'
  ) as Route;
  const subPath = segments.slice(1).join('/');
  return { route, subPath, params: new URLSearchParams(query || '') };
}

// ─── App ─────────────────────────────────────────────────

function App() {
  // One viewport coordinator covers login, route pages and every shared
  // overlay. Call it above the auth branches so no mobile input falls back to
  // browser-default whole-page keyboard resizing.
  useMobileKeyboardViewport();
  const { authState, currentUser, login, logout, updateUser: _updateUser } = useAuthStore();
  const [userLocale, setUserLocale] = useState<Locale>(getStoredLocale());
  const { hash, pending: pendingLeave, confirmLeave, cancelLeave } = useHashRouter();
  const { route, subPath, params, extensionRoute } = useMemo(() => parseRoute(hash), [hash]);
  const passwordLinkRoute = hash.split('?')[0] === '#/activate';
  const passwordLinkToken = passwordLinkRoute
    ? new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '').get('token')
    : null;

  // Sync locale to backend when user changes it
  const handleLocaleChange = useCallback(
    (locale: Locale) => {
      setUserLocale(locale);
      if (currentUser) {
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
    // The one-time link page owns its unauthenticated session lifecycle. A
    // stale access-token validation must not race a successful completion and
    // clear the freshly issued session.
    if (passwordLinkRoute) return;
    setOnUnauthorized(handleUnauthorized);

    (async () => {
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
  }, [handleUnauthorized, login, passwordLinkRoute]);

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

  if (passwordLinkRoute) {
    return (
      <I18nProvider initialLocale={userLocale} onLocaleChange={handleLocaleChange}>
        <Suspense fallback={<LoadingScreen />}>
          <AccountPasswordPage
            initialToken={passwordLinkToken}
            onSuccess={(user) => {
              login(user);
              if (user.locale && (user.locale === 'en' || user.locale === 'zh')) {
                setUserLocale(user.locale as Locale);
              }
              useAuthStore.getState().setAuthState('authenticated');
            }}
          />
        </Suspense>
        <ToastContainer />
      </I18nProvider>
    );
  }

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
        <ToastContainer />
      </I18nProvider>
    );
  }

  if (new URLSearchParams(window.location.search).get('oauth_authorize') === '1') {
    return (
      <I18nProvider initialLocale={userLocale} onLocaleChange={handleLocaleChange}>
        <Suspense fallback={<LoadingScreen />}>
          <OAuthConsentPage />
        </Suspense>
        <ToastContainer />
      </I18nProvider>
    );
  }

  return (
    <I18nProvider initialLocale={userLocale} onLocaleChange={handleLocaleChange}>
      <AgentProvider>
        <SessionManagerProvider>
          <AppShell route={route} subPath={subPath} params={params} extensionRoute={extensionRoute} />
          <LeaveConfirmDialog open={pendingLeave !== null} onConfirm={confirmLeave} onCancel={cancelLeave} />
          <ToastContainer />
        </SessionManagerProvider>
      </AgentProvider>
    </I18nProvider>
  );
}

// ─── App Shell — new sidebar-first layout ────────────────

interface AppShellProps {
  route: Route;
  extensionRoute?: string;
  subPath: string;
  params: URLSearchParams;
}

function AppShell({ route, subPath, params, extensionRoute }: AppShellProps) {
  const t = useT();
  const { currentUser, logout } = useAuthStore();
  const { chatWorkspaceView, navOpen, setChatWorkspaceView, setNavOpen, currentSessionTitle, currentChatSessionId } =
    useUIStore();

  const { orderedApplications, hasApplication, loading: catalogLoading } = usePlatformCatalog();
  const loadPlatformCatalog = usePlatformStore((state) => state.load);

  useEffect(() => {
    void loadPlatformCatalog(true);
  }, [loadPlatformCatalog]);

  const loadExtensions = useExtensionsStore((state) => state.load);
  useEffect(() => {
    void loadExtensions();
  }, [loadExtensions]);

  useEffect(() => {
    setChatWorkspaceView('conversation');
  }, [route, setChatWorkspaceView]);

  // Session ID from store (synced by ChatPage internally)
  const currentSessionId = currentChatSessionId;
  const previousNonSettingsHashRef = useRef('#/chat');
  const lastChatHashRef = useRef('#/chat');

  // Settings + Administration are full-screen overlay routes with a Back button.
  const isOverlayRoute = route === 'settings' || route === 'administration';

  useEffect(() => {
    if (route === 'chat') {
      lastChatHashRef.current = window.location.hash || '#/chat';
    }
    if (!isOverlayRoute) {
      previousNonSettingsHashRef.current = window.location.hash || '#/chat';
    }
  }, [isOverlayRoute, params, route, subPath]);

  const _onSignOut = useCallback(() => {
    clearToken();
    logout();
    setNavOpen(false);
    useProfileStore.getState().clear();
  }, [logout, setNavOpen]);

  const handleBackFromPage = useCallback(() => {
    const previousPage = previousNonSettingsHashRef.current;
    const overlayTarget =
      previousPage?.startsWith('#/settings') || previousPage?.startsWith('#/administration')
        ? lastChatHashRef.current
        : previousPage;
    const target = isOverlayRoute ? overlayTarget || lastChatHashRef.current : lastChatHashRef.current;
    window.location.hash = target;
  }, [isOverlayRoute]);

  const handleNewChat = useCallback(() => {
    setChatWorkspaceView('conversation');
    window.location.hash = `#/chat?new=${Date.now()}`;
  }, [setChatWorkspaceView]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setChatWorkspaceView('conversation');
      window.location.hash = `#/chat?session=${sessionId}`;
    },
    [setChatWorkspaceView],
  );

  // One permission-aware navigation model feeds both the desktop sidebar and
  // mobile drawer. Presentation differs, visibility and ordering do not.
  const primaryNavigation = buildPrimaryNavigation({
    applications: orderedApplications,
    chatLabel: t('app.chat'),
    skillhubLabel: t('app.skillhub'),
  });
  return (
    <>
      <div className="app-viewport flex overflow-hidden bg-surface-canvas">
        {/* Full-height contextual rail — desktop only. Brand, workspace,
            primary action, contextual navigation, and account all live here. */}
        <AppSidebar
          route={route}
          extensionRoute={extensionRoute}
          subPath={subPath}
          currentSessionId={currentSessionId}
          onSelectSession={handleSelectSession}
          onNewChat={handleNewChat}
          onSignOut={_onSignOut}
          onBack={handleBackFromPage}
          navigation={primaryNavigation}
        />

        {/* Right workspace: contextual page bar and content. */}
        <div className="flex h-full min-w-0 flex-1 flex-col">
          {/* Simplified Top Bar */}
          <TopBar
            route={route}
            subPath={subPath}
            sessionTitle={currentSessionTitle}
            chatWorkspaceView={chatWorkspaceView}
            onSelectSession={handleSelectSession}
          />

          {/* Mobile navigation drawer */}
          <Drawer open={navOpen} onClose={() => setNavOpen(false)} ariaLabel={t('navigation.mobile')}>
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-edge px-4 py-4">
                <AppLogo size="sm" showVersion />
                <div className="flex items-center gap-0">
                  <SearchNavButton />
                  <IconButton onClick={() => setNavOpen(false)} label={t('common.close')}>
                    <X size={16} />
                  </IconButton>
                </div>
              </div>
              {isOverlayRoute && (
                <div className="flex-shrink-0 border-b border-edge px-3 py-3">
                  <SidebarBackButton
                    label={t('common.back')}
                    onClick={() => {
                      handleBackFromPage();
                      setNavOpen(false);
                    }}
                  />
                </div>
              )}
              {isOverlayRoute ? (
                <>
                  <div className="flex-1 min-h-0 overflow-hidden">
                    {route === 'administration' ? (
                      <AdministrationNavPanel activeModule={subPath.split('/').filter(Boolean)[0] || 'users'} />
                    ) : (
                      <SettingsNavPanel
                        activeModule={subPath.split('/').filter(Boolean)[0] || 'preferences'}
                        onSignOut={_onSignOut}
                      />
                    )}
                  </div>
                </>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="flex-shrink-0 px-3 pb-2 pt-3">
                    <SidebarPrimaryAction
                      icon={Plus}
                      onClick={() => {
                        handleNewChat();
                        setNavOpen(false);
                      }}
                    >
                      {t('navigation.newChat')}
                    </SidebarPrimaryAction>
                  </div>
                  <SidebarGlobalNavigation
                    navigation={primaryNavigation}
                    route={route}
                    extensionRoute={extensionRoute}
                    chatWorkspaceView={chatWorkspaceView}
                    onSelectChatWorkspace={setChatWorkspaceView}
                    onNavigate={() => setNavOpen(false)}
                    morePlacement="inline"
                    className="pb-2"
                  />
                  <div className="mx-3 border-t border-edge" />
                  {route === 'chat' ? (
                    <div className="flex min-h-0 flex-1 flex-col pt-1">
                      <ChatHistoryPanel
                        currentSessionId={currentSessionId}
                        onSelectSession={(sessionId) => {
                          handleSelectSession(sessionId);
                          setNavOpen(false);
                        }}
                      />
                    </div>
                  ) : route === 'knowledge' ? (
                    // The tree is the ONLY way to reach an internal doc (the page
                    // body stopped listing documents when the tree shipped), so
                    // without this the whole team library is unreachable on a
                    // phone — you'd land on the public wiki and stop there.
                    <div className="flex min-h-0 flex-1 flex-col pt-1">
                      <KnowledgeNavPanel activeModule={subPath} onNavigate={() => setNavOpen(false)} />
                    </div>
                  ) : route === 'executions' ? (
                    <div className="min-h-0 flex-1" />
                  ) : route === 'extension' ? (
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      <ExtensionSidebarPanel
                        route={extensionRoute ?? ''}
                        subPath={subPath}
                        onNavigate={() => setNavOpen(false)}
                      />
                    </div>
                  ) : (
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      <MobilePinnedSection
                        currentHash={`#/${route}${subPath ? '/' + subPath : ''}`}
                        onNavigate={() => setNavOpen(false)}
                      />
                    </div>
                  )}
                </div>
              )}
              {/* User info stays pinned while the navigation region scrolls. */}
              {currentUser && (
                <div className="flex-shrink-0 border-t border-edge bg-surface-raised px-4 py-3">
                  <SidebarAccountMenu
                    user={currentUser}
                    showSettingsIcon
                    settingsActive={route === 'settings'}
                    executionCenterActive={route === 'executions'}
                    onNavigate={() => setNavOpen(false)}
                  />
                </div>
              )}
            </div>
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
                {catalogLoading && (route === 'projects' || route === 'knowledge' || route === 'tables') && (
                  <div className="flex h-full items-center justify-center">
                    <Spinner className="h-6 w-6 text-fg-faint" />
                  </div>
                )}
                {route === 'chat' && (
                  <ChatPage
                    key={params.get('session') || params.get('new') || 'new'}
                    initialSessionId={params.get('session') || undefined}
                  />
                )}
                {route === 'automations' && <AutomationsPage />}
                {route === 'tasks' && <PersonalTasksPage />}
                {route === 'agents' && <AgentsPage />}
                {route === 'skillhub' && <SkillHubPage subPath={subPath} />}
                {route === 'settings' && <SettingsPage subPath={subPath} />}
                {route === 'administration' && <AdministrationPage subPath={subPath} />}
                {route === 'projects' &&
                  hasApplication('projects') &&
                  (subPath ? <ProjectDetailPage projectId={parseInt(subPath)} /> : <ProjectsPage />)}
                {route === 'design' && <DesignPage />}
                {route === 'knowledge' && hasApplication('knowledge') && (
                  <KnowledgePage subPath={subPath} basePath="#/knowledge" />
                )}
                {route === 'tables' && hasApplication('tables') && <TablesPage subPath={subPath} />}
                {route === 'executions' && <ExecutionCenterPage subPath={subPath} params={params} />}
                {route === 'extension' && (
                  <ExtensionPageHost route={extensionRoute ?? ''} subPath={subPath} params={params} />
                )}
                {!catalogLoading &&
                  ((route === 'projects' && !hasApplication('projects')) ||
                    (route === 'knowledge' && !hasApplication('knowledge')) ||
                    (route === 'tables' && !hasApplication('tables'))) && (
                    <div className="flex h-full items-center justify-center text-sm text-fg-faint">
                      {t('app.noPermission')}
                    </div>
                  )}
              </main>
            </Suspense>
          </ErrorBoundary>

          <AssistantPanel />
          <EntityPeekHost />
          <GlobalSearchDialog />
        </div>
      </div>
    </>
  );
}

// ─── Loading Screen ──────────────────────────────────────

function LoadingScreen() {
  const t = useT();
  return (
    <div className="app-viewport flex items-center justify-center bg-surface-sunken">
      <div className="text-center">
        <div className="mx-auto flex justify-center">
          <AppLogo size="xl" logoOnly />
        </div>
        <p className="text-sm text-fg-faint mt-2">{t('common.loading')}</p>
      </div>
    </div>
  );
}

// ─── Mount ───────────────────────────────────────────────

const container = document.getElementById('root');
if (container) {
  // Workspace branding (name / logo / theme) loads before first paint so the
  // login screen is already branded; it fails open to the build defaults.
  void initWorkspaceBranding().finally(() => {
    const root = createRoot(container);
    root.render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>,
    );
  });
}
