/**
 * AppSidebar — global left sidebar with navigation, contextual panels, and user profile.
 *
 * Layout (top to bottom):
 * 1. Logo + collapse toggle
 * 2. Horizontal primary navigation tabs
 * 3. + New Chat / contextual actions
 * 4. Contextual panel (varies by active tab)
 * 5. User profile + settings (bottom)
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AppLogo } from '../ui';
import { getRuntimeProductName } from '../../lib/workspace-branding';
import { SidebarAccountMenu } from './user-menu';
import {
  MessageCircle,
  FolderKanban,
  Settings as SettingsIcon,
  ChevronLeft,
  ChevronRight,
  Plus,
  ArrowLeft,
  BookOpen,
} from '../../lib/icons';
import type { LucideIcon } from '../../lib/icons';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useAuthStore, useUIStore } from '../../stores';
import { useT } from '../../lib/i18n';
import {
  ChatHistoryPanel,
  SettingsNavPanel,
  ProjectsListPanel,
  PinnedSection,
  PinnedSectionCollapsed,
  KnowledgeNavPanel,
} from './sidebar-panels';
import { extraNavItems } from '../../lib/page-registry';

type Route = 'chat' | 'history' | 'settings' | 'projects' | 'inbox' | 'design' | 'knowledge' | (string & {});

interface AppSidebarProps {
  route: Route;
  subPath: string;
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
  onSignOut: () => void;
  onBackFromSettings: () => void;
}

export function AppSidebar({
  route,
  subPath,
  currentSessionId,
  onSelectSession,
  onNewChat,
  onSignOut,
  onBackFromSettings,
}: AppSidebarProps) {
  const t = useT();
  const { currentUser } = useAuthStore();
  const { sidebarCollapsed, sidebarWidth, setSidebarCollapsed, setSidebarWidth } = useUIStore();
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const minWidth = SIDEBAR_MIN_WIDTH;
  const maxWidth = SIDEBAR_MAX_WIDTH;

  const userRole = currentUser?.role ?? 'external';
  const isExternal = userRole === 'external';
  const isSettingsRoute = route === 'settings';

  const navItems: Array<{ key: Route; label: string; icon: LucideIcon; visible: boolean }> = [
    { key: 'chat', label: t('app.chat'), icon: MessageCircle, visible: true },
    { key: 'projects', label: t('app.projects'), icon: FolderKanban, visible: !isExternal },
    { key: 'knowledge', label: t('app.knowledge'), icon: BookOpen, visible: !isExternal },
    ...extraNavItems({ isExternal, userRole }),
  ];
  const visibleNavItems = navItems.filter((item) => item.visible);

  // Resize handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.min(maxWidth, Math.max(minWidth, e.clientX));
      setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => setIsResizing(false);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, maxWidth, minWidth, setSidebarWidth]);

  // Parse active sub-module for contextual panels
  const activeSubModule = subPath.split('/').filter(Boolean)[0] || '';

  // ── Collapsed sidebar ──
  if (sidebarCollapsed) {
    return (
      <div
        className="hidden md:flex flex-col items-center my-2 ml-2 py-2 rounded-2xl border border-edge bg-surface-raised shadow-none overflow-hidden flex-shrink-0 h-[calc(100vh-1rem)] transition-[width] duration-200 ease-in-out"
        style={{ width: 60 }}
      >
        {/* Logo only (no text) */}
        <div className="p-2">
          <AppLogo size="sm" logoOnly />
        </div>

        <div className="flex flex-col items-center gap-1 mb-2">
          <button
            onClick={onNewChat}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-fg-muted hover:text-fg-secondary hover:bg-surface-muted transition-colors"
            title="New Chat"
          >
            <Plus size={16} />
          </button>

          <button
            onClick={() => setSidebarCollapsed(false)}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-fg-faint hover:text-fg-secondary hover:bg-surface-muted transition-colors"
            title="Expand sidebar"
            aria-expanded={false}
            aria-label="Expand sidebar"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        {isSettingsRoute ? (
          <button
            onClick={onBackFromSettings}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-fg-muted hover:text-fg-secondary hover:bg-surface-muted transition-colors mb-3"
            title="Back"
          >
            <ArrowLeft size={16} />
          </button>
        ) : (
          <>
            {/* Nav icons */}
            <nav className="flex flex-col gap-1 px-1.5" aria-label="Main navigation">
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = route === item.key;
                return (
                  <a
                    key={item.key}
                    href={`#/${item.key}`}
                    aria-current={isActive ? 'page' : undefined}
                    className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
                      isActive
                        ? 'bg-primary-subtle text-primary-fg-strong'
                        : 'text-fg-muted hover:text-fg-secondary hover:bg-surface-muted'
                    }`}
                    title={item.label}
                  >
                    <Icon size={16} />
                  </a>
                );
              })}
            </nav>

            {/* Pinned shortcuts (collapsed) */}
            <PinnedSectionCollapsed currentHash={`#/${route}${subPath ? '/' + subPath : ''}`} />
          </>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Settings + User avatar */}
        {!isExternal && (
          <a
            href="#/settings"
            className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
              route === 'settings'
                ? 'bg-primary-subtle text-primary-fg-strong'
                : 'text-fg-faint hover:text-fg-secondary hover:bg-surface-muted'
            }`}
            title={t('app.settings')}
          >
            <SettingsIcon size={16} />
          </a>
        )}
        <SidebarAccountMenu user={currentUser} compact />
      </div>
    );
  }

  // ── Expanded sidebar ──
  return (
    <>
      <div
        ref={sidebarRef}
        className="hidden md:flex flex-col my-2 ml-2 rounded-2xl border border-edge bg-surface-raised shadow-none overflow-hidden flex-shrink-0 h-[calc(100vh-1rem)] relative transition-[width] duration-200 ease-in-out"
        style={{ width: sidebarWidth }}
      >
        {/* Top: Logo + Title/Workspace + Collapse */}
        <div className="flex items-center gap-2.5 px-3 pt-3 pb-2 flex-shrink-0">
          {/* Column 1: Logo */}
          <a href="#/chat" className="flex-shrink-0 hover:opacity-80 transition-opacity">
            <AppLogo size="lg" logoOnly />
          </a>

          {/* Column 2: Title */}
          <div className="flex flex-col min-w-0 flex-1 gap-0.5">
            <a href="#/chat" className="hover:opacity-80 transition-opacity">
              <span className="font-semibold text-fg text-sm leading-tight">{getRuntimeProductName()}</span>
            </a>
          </div>

          {/* Column 3: Fixed header actions */}
          <div className="flex flex-shrink-0 items-center gap-1">
            <button
              onClick={onNewChat}
              className="h-8 w-8 flex items-center justify-center rounded-lg text-fg-muted hover:text-fg-secondary hover:bg-surface-muted transition-colors"
              title="New Chat"
              aria-label="New Chat"
            >
              <Plus size={15} />
            </button>
            <button
              onClick={() => setSidebarCollapsed(true)}
              className="h-8 w-8 flex items-center justify-center rounded-lg text-fg-faint hover:text-fg-secondary hover:bg-surface-muted transition-colors"
              title="Collapse sidebar"
              aria-expanded={true}
              aria-label="Collapse sidebar"
            >
              <ChevronLeft size={14} />
            </button>
          </div>
        </div>

        {isSettingsRoute ? (
          <>
            <div className="px-3 pb-2 flex-shrink-0">
              <button
                onClick={onBackFromSettings}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors"
              >
                <ArrowLeft size={14} />
                <span>Back</span>
              </button>
            </div>

            <div className="mx-3 border-t border-edge flex-shrink-0" />

            <div className="flex-1 min-h-0 overflow-hidden flex flex-col mt-1">
              <SettingsNavPanel activeModule={activeSubModule || 'preferences'} onSignOut={onSignOut} />
            </div>
          </>
        ) : (
          <>
            {/* Primary navigation — horizontal tabs */}
            <nav
              className="mx-3 mb-2 flex items-stretch gap-1 rounded-xl bg-surface-sunken p-1 flex-shrink-0 overflow-hidden"
              aria-label="Main navigation"
            >
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = route === item.key;
                return (
                  <a
                    key={item.key}
                    href={`#/${item.key}`}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg border px-1 transition-colors ${
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

            {route === 'chat' && (
              <div className="px-3 pb-2 flex-shrink-0">
                <button
                  onClick={onNewChat}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-primary-500 text-white text-sm font-medium hover:bg-primary-600 transition-colors"
                >
                  <Plus size={14} />
                  <span>New Chat</span>
                </button>
              </div>
            )}

            {/* Pinned shortcuts */}
            <PinnedSection currentHash={`#/${route}${subPath ? '/' + subPath : ''}`} />

            {/* Separator */}
            <div className="mx-3 border-t border-edge flex-shrink-0" />

            {/* Contextual Panel */}
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col mt-1">
              {route === 'chat' && (
                <ChatHistoryPanel currentSessionId={currentSessionId} onSelectSession={onSelectSession} />
              )}
              {route === 'projects' && <ProjectsListPanel />}
              {route === 'knowledge' && <KnowledgeNavPanel activeModule={activeSubModule} />}
            </div>
          </>
        )}

        {/* Bottom: Account + Settings */}
        <div className="px-3 py-1.5 border-t border-edge flex-shrink-0">
          <SidebarAccountMenu
            user={currentUser}
            showSettingsIcon={!isExternal}
            settingsActive={route === 'settings'}
            onBackFromSettings={onBackFromSettings}
            isSettingsRoute={isSettingsRoute}
          />
        </div>
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={handleMouseDown}
        className={`hidden md:block w-2 my-4 -ml-1 rounded-full flex-shrink-0 cursor-col-resize transition-colors hover:bg-primary-300 ${
          isResizing ? 'bg-primary-400' : 'bg-transparent'
        }`}
        style={{ zIndex: 10 }}
      />
    </>
  );
}
