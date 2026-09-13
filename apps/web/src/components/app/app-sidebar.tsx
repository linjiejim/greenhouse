/**
 * AppSidebar — full-height brand, global navigation, and contextual rail.
 *
 * Layout (top to bottom):
 * 1. Brand + global actions
 * 2. + New Chat
 * 3. Global destinations + Chat utilities + More
 * 4. Contextual panel (varies by active destination)
 * 5. User profile + settings + collapse control (bottom)
 */

import { useState, type ReactNode } from 'react';

import { SidebarAccountMenu } from './user-menu';
import { PanelLeftClose, PanelLeftOpen, Plus, ArrowLeft } from '../../lib/icons';
import { AppLogo, ResizeHandle } from '../ui';
import { AssistantNavButton } from '../agent-panel';
import { SearchNavButton } from '../search/search-nav-button';
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useAuthStore, useUIStore } from '../../stores';
import { usePlatformCatalog } from '../../stores/platform-store';
import { useT } from '../../lib/i18n';
import { SidebarPrimaryAction } from './sidebar-primary-action';
import { SidebarGlobalNavigation } from './sidebar-global-navigation';
import { WsStatusIndicator } from './top-bar';
import type { PrimaryNavigation } from '../../platform/navigation';
import {
  ChatHistoryPanel,
  SettingsNavPanel,
  AdministrationNavPanel,
  ProjectsListPanel,
  PinnedSection,
  PinnedSectionCollapsed,
  KnowledgeNavPanel,
  SkillHubNavPanel,
  TablesNavPanel,
} from './sidebar-panels';

type Route =
  | 'home'
  | 'chat'
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

interface AppSidebarProps {
  route: Route;
  subPath: string;
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
  onSignOut: () => void;
  onBack: () => void;
  navigation: PrimaryNavigation;
}

type SidebarBrandHeaderProps =
  | { collapsed: true; onToggle: () => void; globalActions?: never }
  | { collapsed: false; globalActions?: ReactNode };

interface SidebarBackButtonProps {
  onClick: () => void;
  compact?: boolean;
  label?: string;
}

/** A real navigation action, visually distinct from the panel toggle above it. */
export function SidebarBackButton({ onClick, compact = false, label }: SidebarBackButtonProps) {
  const t = useT();
  const resolvedLabel = label ?? t('common.back');
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        compact
          ? 'flex h-9 w-9 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg-secondary'
          : 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-fg-secondary transition-colors hover:bg-surface-muted hover:text-fg'
      }
      title={resolvedLabel}
      aria-label={resolvedLabel}
    >
      <ArrowLeft size={compact ? 16 : 14} />
      {!compact && <span>{resolvedLabel}</span>}
    </button>
  );
}

const COLLAPSED_SIDEBAR_WIDTH = 60;

/** Shell identity owns the stable top row; the collapsed rail turns it into the expand target. */
export function SidebarBrandHeader(props: SidebarBrandHeaderProps) {
  const t = useT();
  if (props.collapsed) {
    return (
      <div className="relative flex h-14 w-full flex-shrink-0 items-center justify-center border-b border-edge px-1">
        <button
          type="button"
          onClick={props.onToggle}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-fg-faint transition-colors hover:bg-surface-muted hover:text-fg-secondary"
          title={t('navigation.expandSidebar')}
          aria-expanded={false}
          aria-label={t('navigation.expandSidebar')}
        >
          <PanelLeftOpen size={15} />
        </button>
      </div>
    );
  }

  const { globalActions } = props;

  return (
    <div className="flex h-14 w-full flex-shrink-0 items-center gap-2 border-b border-edge px-3">
      <div className="sidebar-brand-identity group relative flex min-w-0 flex-1 items-center overflow-hidden rounded-lg px-1">
        <a href="#/chat" className="absolute inset-0 z-0 rounded-lg" aria-label={t('navigation.greenHouseHome')} />
        <div className="pointer-events-none relative z-[1] flex items-center gap-2 transition-opacity group-hover:opacity-80">
          <AppLogo size="sm" logoOnly />
          <div className="flex min-w-0 flex-col">
            <span className="font-display text-sm font-bold leading-tight text-fg">Greenhouse</span>
            <div className="flex h-3 items-center gap-1 text-[9px] leading-tight text-fg-faint">
              <span>{t('navigation.brandTagline')}</span>
            </div>
          </div>
        </div>
      </div>
      {globalActions && <div className="flex flex-shrink-0 items-center gap-0">{globalActions}</div>}
    </div>
  );
}

export function SidebarCollapseButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-fg-faint transition-colors hover:bg-surface-muted hover:text-fg-secondary"
      title={t('navigation.collapseSidebar')}
      aria-expanded={true}
      aria-label={t('navigation.collapseSidebar')}
    >
      <PanelLeftClose size={16} />
    </button>
  );
}

export function AppSidebar({
  route,
  subPath,
  currentSessionId,
  onSelectSession,
  onNewChat,
  onSignOut,
  onBack,
  navigation,
}: AppSidebarProps) {
  const t = useT();
  const { currentUser } = useAuthStore();
  const {
    chatWorkspaceView,
    sidebarCollapsed,
    sidebarWidth,
    setChatWorkspaceView,
    setSidebarCollapsed,
    setSidebarWidth,
  } = useUIStore();
  const { hasApplication } = usePlatformCatalog();
  const minWidth = SIDEBAR_MIN_WIDTH;
  const maxWidth = SIDEBAR_MAX_WIDTH;
  const [sidebarDragWidth, setSidebarDragWidth] = useState<number | null>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);

  const isSettingsRoute = route === 'settings';
  const isAdminRoute = route === 'administration';
  const visibleSidebarWidth = sidebarDragWidth ?? (sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : sidebarWidth);
  // Settings and Administration keep their dedicated contextual panels. Normal
  // application routes share the global navigation instead of a redundant Back.
  const isOverlayRoute = isSettingsRoute || isAdminRoute;

  // Parse active sub-module for contextual panels
  const activeSubModule = subPath.split('/').filter(Boolean)[0] || '';

  const handleSidebarResize = (next: number) => {
    setSidebarDragWidth(next);
    if (next >= minWidth) {
      setSidebarWidth(next);
      setSidebarCollapsed(false);
    } else {
      setSidebarCollapsed(true);
    }
  };

  const finishSidebarResize = (next: number) => {
    if (next >= minWidth) {
      setSidebarWidth(next);
      setSidebarCollapsed(false);
    } else {
      setSidebarCollapsed(true);
    }
    setSidebarDragWidth(null);
    setSidebarResizing(false);
  };

  const resizeHandle = (
    <ResizeHandle
      orientation="vertical"
      value={visibleSidebarWidth}
      min={COLLAPSED_SIDEBAR_WIDTH}
      max={maxWidth}
      defaultValue={SIDEBAR_DEFAULT_WIDTH}
      onResizeStart={() => {
        setSidebarDragWidth(visibleSidebarWidth);
        setSidebarResizing(true);
      }}
      onChange={handleSidebarResize}
      onResizeEnd={finishSidebarResize}
      label={t('navigation.resizeSidebar')}
      className="-ml-1 hidden flex-shrink-0 md:flex z-10"
    />
  );

  if (sidebarCollapsed) {
    return (
      <>
        <div
          className={`hidden h-full flex-shrink-0 flex-col items-center border-r border-edge bg-surface-chrome md:flex ${
            sidebarResizing ? '' : 'transition-[width] duration-200 ease-in-out'
          }`}
          style={{ width: visibleSidebarWidth }}
        >
          <SidebarBrandHeader collapsed onToggle={() => setSidebarCollapsed(false)} />

          <div className="flex min-h-0 w-full flex-1 flex-col items-center pt-2">
            {isOverlayRoute ? (
              <div className="mb-2 flex flex-col items-center gap-1">
                <SidebarBackButton onClick={onBack} label={t('common.back')} compact />
              </div>
            ) : (
              <>
                <div className="mb-2 flex flex-col items-center gap-1 border-b border-edge pb-2">
                  <SearchNavButton />
                  <AssistantNavButton />
                  <WsStatusIndicator />
                </div>
                <button
                  type="button"
                  onClick={onNewChat}
                  className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg-secondary"
                  title={t('navigation.newChat')}
                  aria-label={t('navigation.newChat')}
                >
                  <Plus size={16} />
                </button>
                <SidebarGlobalNavigation
                  navigation={navigation}
                  route={route}
                  chatWorkspaceView={chatWorkspaceView}
                  onSelectChatWorkspace={setChatWorkspaceView}
                  compact
                />
              </>
            )}

            {!isOverlayRoute && route !== 'chat' && route !== 'executions' && (
              <PinnedSectionCollapsed currentHash={`#/${route}${subPath ? '/' + subPath : ''}`} />
            )}

            <div className="flex-1" />

            <SidebarAccountMenu user={currentUser} compact executionCenterActive={route === 'executions'} />
          </div>
        </div>
        {resizeHandle}
      </>
    );
  }

  return (
    <>
      <div
        className={`relative hidden h-full flex-shrink-0 flex-col overflow-visible border-r border-edge bg-surface-chrome md:flex ${
          sidebarResizing ? '' : 'transition-[width] duration-200 ease-in-out'
        }`}
        style={{ width: visibleSidebarWidth, containerType: 'inline-size', containerName: 'app-sidebar' }}
      >
        <SidebarBrandHeader
          collapsed={false}
          globalActions={
            <>
              <WsStatusIndicator />
              <SearchNavButton />
              <AssistantNavButton />
            </>
          }
        />

        <div className="flex min-h-0 flex-1 flex-col pt-2">
          {isOverlayRoute && (
            <>
              <div className="flex-shrink-0 px-3 pb-2">
                <SidebarBackButton onClick={onBack} label={t('common.back')} />
              </div>
              <div className="mx-3 flex-shrink-0 border-t border-edge" />
            </>
          )}

          {isOverlayRoute ? (
            <>
              <div className="flex-1 min-h-0 overflow-hidden flex flex-col mt-1">
                {isAdminRoute ? (
                  <AdministrationNavPanel activeModule={activeSubModule || 'users'} />
                ) : (
                  <SettingsNavPanel activeModule={activeSubModule || 'preferences'} onSignOut={onSignOut} />
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex-shrink-0 px-3 pb-2">
                <SidebarPrimaryAction icon={Plus} onClick={onNewChat}>
                  {t('navigation.newChat')}
                </SidebarPrimaryAction>
              </div>

              <SidebarGlobalNavigation
                navigation={navigation}
                route={route}
                chatWorkspaceView={chatWorkspaceView}
                onSelectChatWorkspace={setChatWorkspaceView}
                className="pb-2"
              />

              <div className="mx-3 flex-shrink-0 border-t border-edge" />

              {/* Tables own the full contextual rail. Execution Center is a
                  global utility and deliberately omits unrelated pinned links. */}
              {route !== 'tables' && route !== 'executions' && (
                <PinnedSection currentHash={`#/${route}${subPath ? '/' + subPath : ''}`} />
              )}

              {/* Contextual Panel */}
              <div className="flex-1 min-h-0 overflow-hidden flex flex-col mt-1">
                {route === 'chat' && (
                  <ChatHistoryPanel currentSessionId={currentSessionId} onSelectSession={onSelectSession} />
                )}
                {route === 'projects' && <ProjectsListPanel />}
                {/* Knowledge gets the FULL sub-path: its tree highlights the open
                    document, which lives in the later segments. */}
                {route === 'knowledge' && <KnowledgeNavPanel activeModule={subPath} />}
                {route === 'skillhub' && <SkillHubNavPanel activeName={activeSubModule} />}
                {route === 'tables' && hasApplication('tables') && <TablesNavPanel subPath={subPath} />}
              </div>
            </>
          )}

          {/* Account and collapse control share the stable bottom row. */}
          <div className="flex flex-shrink-0 items-center gap-1 border-t border-edge px-3 py-1.5">
            <div className="min-w-0 flex-1">
              <SidebarAccountMenu
                user={currentUser}
                settingsActive={isOverlayRoute}
                executionCenterActive={route === 'executions'}
                onBackFromSettings={onBack}
                isSettingsRoute={isOverlayRoute}
              />
            </div>
            <SidebarCollapseButton onClick={() => setSidebarCollapsed(true)} />
          </div>
        </div>
      </div>
      {resizeHandle}
    </>
  );
}
