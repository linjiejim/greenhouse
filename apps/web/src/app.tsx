import { registeredHostTitle } from './lib/extension-registries';
/**
 * Greenhouse — Web UI entry point.
 * Hash-based routing for Chat, Knowledge, Projects, Tables, and Settings.
 *
 * LAYOUT: Full-height global/contextual sidebar + right-side top bar and content.
 * UI 子组件拆分到 components/app/ 目录下。
 */
import { CONNECTOR_OAUTH_FINISH_HASH } from '@greenhouse/types/connectors';
import './app.css';
import React, { useState, useEffect, useMemo, useCallback, useRef, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPage } from './pages/chat';
// Lazy-loaded route pages for code splitting
const SettingsPage = lazy(() => import('./pages/settings').then((m) => ({ default: m.SettingsPage })));
const AdministrationPage = lazy(() =>
  import('./pages/administration').then((m) => ({ default: m.AdministrationPage })),
);
const DesignPage = import.meta.env.DEV
  ? lazy(() => import('./pages/design').then((m) => ({ default: m.DesignPage })))
  : null;
const AutomationsPage = lazy(() => import('./pages/automations').then((m) => ({ default: m.AutomationsPage })));
const SkillHubPage = lazy(() => import('./pages/skillhub').then((m) => ({ default: m.SkillHubPage })));
const ActivityPage = lazy(() => import('./pages/activity').then((m) => ({ default: m.ActivityPage })));
const FilesPage = lazy(() => import('./pages/files').then((m) => ({ default: m.FilesPage })));
const OAuthConsentPage = lazy(() => import('./pages/oauth-consent').then((m) => ({ default: m.OAuthConsentPage })));
const ConnectorOAuthFinishPage = lazy(() =>
  import('./pages/connector-oauth-finish').then((m) => ({ default: m.ConnectorOAuthFinishPage })),
);
const AccountPasswordPage = lazy(() =>
  import('./pages/account-password').then((m) => ({ default: m.AccountPasswordPage })),
);
import { AgentProvider } from './components/agent-context';
import { compiledExtensionRouteAliases, compiledExtensionRoutes, findExtensionPage } from './extensions';
import { reportPageOpen } from './lib/api/usage';
import { pageModuleForRoute } from './lib/usage/page-module';
import { ExtensionPageHost, ExtensionSidebarPanel } from './extensions/host';
import { useExtensionsStore } from './stores/extensions-store';
import { AssistantPanel } from './components/agent-panel';
import { EntityPeekHost } from './components/entity-peek';
import { GlobalSearchDialog } from './components/search/global-search-dialog';
import { SessionManagerProvider } from './lib/session-manager';
import { ConfirmDialog, Drawer, AppLogo, ToastContainer, ErrorBoundary, Spinner, IconButton } from './components/ui';
import { Plus, X } from './lib/icons';
import { authFetch, clearToken, setOnUnauthorized, validateSession } from './lib/auth';
import { LoginScreen, AppSidebar, SidebarAccountMenu, SidebarBackButton, TopBar } from './components/app';
import { ActionConfirmDialog } from './components/app/action-confirm-dialog';
import {
  ChatHistoryPanel,
  MobilePinnedSection,
  SettingsNavPanel,
  AdministrationNavPanel,
} from './components/app/sidebar-panels';
import { SidebarGlobalNavigation } from './components/app/sidebar-global-navigation';
import { SidebarPrimaryAction } from './components/app/sidebar-primary-action';
import { BrandIntro } from './components/app/brand-intro';
import { SearchNavButton } from './components/search/search-nav-button';
import { useAuthStore, useUIStore, useProfileStore } from './stores';
import { useWsStore } from './stores/ws-store';
import { initTheme } from './lib/theme';
import { initWorkspaceBranding } from './lib/workspace-branding';
import { initScrollActivity } from './lib/scroll-activity';
import { I18nProvider, useT, getStoredLocale } from './lib/i18n';
import type { Locale } from './lib/i18n';
import { buildPrimaryNavigation, isConversationRoute } from './platform/navigation';
import { usePlatformCatalog, usePlatformStore } from './stores/platform-store';
import { useMobileKeyboardViewport } from './hooks/use-mobile-keyboard-viewport';
import { CORE_ROUTES, newChatHash, useHashRouter } from './lib/hash-router';
import { InboxModal } from './components/app/inbox-modal';
import { InboxBellButton } from './components/app/inbox-bell';
// Initialize theme from localStorage on app load
initTheme();
// Reveal scrollbars only while scrolling (they're transparent at rest)
initScrollActivity();
// ─── Router ──────────────────────────────────────────────
type Route =
  | 'home'
  | 'chat'
  | 'extension'
  | 'automations'
  | 'settings'
  | 'administration'
  | 'design'
  | 'files'
  | 'skillhub'
  | 'activity';
interface ParsedRoute {
  route: Route;
  subPath: string;
  params: URLSearchParams;
  /** The extension page route (`#/<extensionRoute>`) when `route === 'extension'`. */
  extensionRoute?: string;
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
/**
 * Which page a canonical hash shows. Pure: retired hashes were already resolved
 * by the router (`lib/hash-router.ts`), so nothing here touches the URL.
 */
function parseRoute(hash: string): ParsedRoute {
  const cleaned = hash.replace(/^#\/?/, '');
  const [path, query] = cleaned.split('?');
  const segments = path.split('/');
  // Home (a new conversation) is the landing page.
  const topLevel = segments[0] || 'home';
  const coreOwned = CORE_ROUTES.has(topLevel);
  // Extension pages answer their own top-level segment; the host checks the
  // extension is active before rendering anything.
  if (!coreOwned && compiledExtensionRoutes().has(topLevel)) {
    return {
      route: 'extension',
      extensionRoute: topLevel,
      subPath: segments.slice(1).join('/'),
      params: new URLSearchParams(query || ''),
    };
  }
  // An unknown top-level segment lands on Home.
  const route = (coreOwned ? topLevel : 'home') as Route;
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
  const { hash, pending: pendingLeave, confirmLeave, cancelLeave } = useHashRouter(compiledExtensionRouteAliases());
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
  // A connector sign-in coming back (usually in a popup): finish it without the app shell.
  if (window.location.hash.startsWith(CONNECTOR_OAUTH_FINISH_HASH)) {
    return (
      <I18nProvider initialLocale={userLocale} onLocaleChange={handleLocaleChange}>
        <Suspense fallback={<LoadingScreen />}>
          <ConnectorOAuthFinishPage />
        </Suspense>
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
          <ActionConfirmDialog />
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
  const { orderedApplications } = usePlatformCatalog();
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
  // Module usage: one page_open per module per page view. Moving within a
  // module (doc → doc, settings tab → same tab) is not a new open.
  const usageModule = pageModuleForRoute({
    route,
    subPath,
    extensionId: route === 'extension' && extensionRoute ? findExtensionPage(extensionRoute)?.extension.id : null,
  });
  useEffect(() => {
    if (usageModule) reportPageOpen(usageModule);
  }, [usageModule]);
  // Session ID from store (synced by ChatPage internally)
  const currentSessionId = currentChatSessionId;
  const previousNonSettingsHashRef = useRef('#/home');
  const lastChatHashRef = useRef('#/home');
  // Settings + Administration are full-screen overlay routes with a Back button.
  const isOverlayRoute = route === 'settings' || route === 'administration';
  useEffect(() => {
    if (isConversationRoute(route)) {
      lastChatHashRef.current = window.location.hash || '#/home';
    }
    if (!isOverlayRoute) {
      previousNonSettingsHashRef.current = window.location.hash || '#/home';
    }
  }, [isOverlayRoute, params, route, subPath]);
  // Home's first message moves the address to `#/chat?session=…` in place
  // (replaceState, no hashchange), so Back must follow the session, not Home.
  useEffect(() => {
    if (!currentSessionId || !isConversationRoute(route)) return;
    const hash = `#/chat?session=${currentSessionId}`;
    lastChatHashRef.current = hash;
    if (!isOverlayRoute) previousNonSettingsHashRef.current = hash;
  }, [currentSessionId, isOverlayRoute, route]);
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
    window.location.hash = newChatHash();
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
    labels: {
      files: t('navigation.files'),
      skillhub: t((registeredHostTitle('skillhub')?.titleKey as `ext.${string}`) ?? 'savedPrompts.title'),
      automations: t('navigation.automation'),
      applications: {
        ...Object.fromEntries(
          orderedApplications.flatMap((application) => {
            const title = registeredHostTitle(application.id);
            return title ? [[application.id, t(title.titleKey as `ext.${string}`)]] : [];
          }),
        ),
      },
    },
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
                  <InboxBellButton />
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
                    onNavigate={() => setNavOpen(false)}
                    morePlacement="inline"
                    className="pb-2"
                  />
                  <div className="mx-3 border-t border-edge" />
                  {isConversationRoute(route) ? (
                    <div className="flex min-h-0 flex-1 flex-col pt-1">
                      <ChatHistoryPanel
                        currentSessionId={currentSessionId}
                        onSelectSession={(sessionId) => {
                          handleSelectSession(sessionId);
                          setNavOpen(false);
                        }}
                      />
                    </div>
                  ) : (
                    <div className="flex min-h-0 flex-1 flex-col">
                      {route === 'activity' ? (
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
                      <ChatHistoryPanel
                        compact
                        currentSessionId={currentSessionId}
                        onSelectSession={(sessionId) => {
                          handleSelectSession(sessionId);
                          setNavOpen(false);
                        }}
                        onShowAll={() => {
                          handleNewChat();
                        }}
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
                    executionCenterActive={route === 'activity'}
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
                {/* Home is a new conversation; `#/chat?session=` opens an existing one. */}
                {isConversationRoute(route) && (
                  <ChatPage
                    key={(route === 'chat' && params.get('session')) || params.get('new') || 'new'}
                    initialSessionId={(route === 'chat' && params.get('session')) || undefined}
                  />
                )}
                {route === 'automations' && <AutomationsPage params={params} />}
                {route === 'skillhub' && <SkillHubPage subPath={subPath} params={params} />}
                {route === 'settings' && <SettingsPage subPath={subPath} />}
                {route === 'administration' && <AdministrationPage subPath={subPath} />}
                {route === 'design' && DesignPage && <DesignPage />}
                {route === 'files' && <FilesPage params={params} />}
                {route === 'activity' && <ActivityPage subPath={subPath} />}
                {route === 'extension' && (
                  <ExtensionPageHost route={extensionRoute ?? ''} subPath={subPath} params={params} />
                )}
              </main>
            </Suspense>
          </ErrorBoundary>

          <AssistantPanel />
          <InboxModal />
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
    <div className="app-viewport flex items-center justify-center bg-surface-chrome">
      <div className="text-center">
        <div className="mx-auto flex justify-center">
          <BrandIntro className="h-16 w-16" />
        </div>
        <p className="text-sm text-fg-muted mt-3">{t('common.loading')}</p>
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
