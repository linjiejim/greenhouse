/**
 * TopBar — simplified top bar showing page/session title + agent button.
 *
 * For sub-module pages (Settings), shows breadcrumb:
 *   "Settings › Preferences" with optional subtitle.
 *
 * For chat, shows session title + profile badge.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Menu, ChevronRight, WifiOff, Tag, Share2, Eye, Users } from '../../lib/icons';
import { AgentNavButton } from '../agent-panel';
import { useUIStore, useWsStore } from '../../stores';
import { useT } from '../../lib/i18n';
import { resolveSubModule } from '../../lib/nav-registry';
import { SessionTagsInline, TagSelector } from '../session-tags';
import type { SessionTag } from '../../lib/api';
import * as api from '../../lib/api';

type Route = 'chat' | 'history' | 'settings' | 'projects' | 'inbox' | 'design' | 'knowledge' | (string & {});

interface TopBarProps {
  route: Route;
  subPath?: string;
  sessionTitle?: string;
  sessionProfileId?: string;
  isExternal?: boolean;
  /** Optional extra content rendered between title and right-side buttons */
  children?: React.ReactNode;
}

// ── Sub-module metadata resolved from unified nav-registry ──

function getSubModuleMeta(
  route: Route,
  subPath?: string,
): { primary: string; secondary?: string; description?: string } | null {
  if (!subPath) return null;
  return resolveSubModule(route, subPath);
}

export function TopBar({ route, subPath, sessionTitle, sessionProfileId, isExternal, children }: TopBarProps) {
  const t = useT();
  const {
    setNavOpen,
    currentSessionTags,
    currentChatSessionId,
    chatShare,
    setCurrentSessionInfo,
    bumpSessionListVersion,
  } = useUIStore();
  const [allTags, setAllTags] = useState<SessionTag[]>([]);
  const [tagSelector, setTagSelector] = useState<{ x: number; y: number } | null>(null);
  const isLocalChatSession = route === 'chat' && (sessionProfileId === 'desktop' || sessionProfileId === 'local-pi');

  // Load user tags once
  useEffect(() => {
    if (!isExternal) {
      api
        .listSessionTags()
        .then(setAllTags)
        .catch(() => {});
    }
  }, [isExternal]);

  const handleTagEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTagSelector({ x: rect.left, y: rect.bottom + 4 });
  }, []);

  const handleTagRemove = useCallback(
    async (tagId: number) => {
      if (!currentChatSessionId) return;
      try {
        await api.removeTagFromSession(currentChatSessionId, tagId);
        const newTags = currentSessionTags.filter((t2) => t2.id !== tagId);
        setCurrentSessionInfo(sessionTitle || '', sessionProfileId || 'default', newTags);
        bumpSessionListVersion();
      } catch {
        /* silent */
      }
    },
    [
      currentChatSessionId,
      currentSessionTags,
      sessionTitle,
      sessionProfileId,
      setCurrentSessionInfo,
      bumpSessionListVersion,
    ],
  );

  const handleTagsChanged = useCallback(async () => {
    if (!currentChatSessionId) return;
    try {
      const data = await api.getSession(currentChatSessionId);
      const tags = (data.session as any).tags || [];
      setCurrentSessionInfo(data.session.title || '', data.session.profile_id || 'default', tags);
      const freshTags = await api.listSessionTags();
      setAllTags(freshTags);
      bumpSessionListVersion();
    } catch {
      /* silent */
    }
  }, [currentChatSessionId, setCurrentSessionInfo, bumpSessionListVersion]);

  // Check for sub-module breadcrumb
  const subMeta = getSubModuleMeta(route, subPath);

  // Fallback page titles
  const pageTitles: Record<string, string> = {
    chat: sessionTitle || t('chat.newConversation'),
    projects: t('app.projects'),
    settings: t('app.settings'),
    inbox: t('inbox.title'),
    knowledge: t('app.knowledge'),
  };

  const title = pageTitles[route] || '';

  return (
    <header className="flex h-10 items-center justify-between px-3 bg-transparent flex-shrink-0 z-10">
      {/* Left */}
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={() => setNavOpen(true)}
          className="md:hidden p-1.5 -ml-1 text-fg-muted hover:text-fg-secondary hover:bg-surface-muted rounded-md"
        >
          <Menu size={20} />
        </button>

        {subMeta ? (
          /* Breadcrumb: Primary › Secondary + description */
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm text-fg-muted hidden sm:inline">{subMeta.primary}</span>
            <ChevronRight size={12} className="text-fg-faint flex-shrink-0 hidden sm:inline" />
            <span className="text-sm font-medium text-fg truncate">{subMeta.secondary}</span>
            {subMeta.description && (
              <span className="text-xs text-fg-faint hidden lg:inline ml-1.5 truncate">— {subMeta.description}</span>
            )}
          </div>
        ) : (
          /* Simple title */
          <>
            <h2 className="text-sm font-medium text-fg truncate">{title}</h2>
            {route === 'chat' && sessionProfileId && sessionProfileId !== 'default' && (
              <span className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full bg-info-subtle text-info border border-info flex-shrink-0">
                {sessionProfileId}
              </span>
            )}
            {route === 'chat' && !isLocalChatSession && currentChatSessionId && currentSessionTags.length > 0 && (
              <SessionTagsInline
                tags={currentSessionTags}
                maxVisible={3}
                size="sm"
                onEdit={handleTagEdit}
                onRemove={handleTagRemove}
              />
            )}
            {route === 'chat' && !isLocalChatSession && currentChatSessionId && currentSessionTags.length === 0 && (
              <button
                onClick={handleTagEdit}
                className="hidden md:inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-fg-faint hover:text-fg-muted hover:bg-surface-muted rounded-full border border-transparent hover:border-edge transition-colors"
                title="Add tags"
              >
                <Tag size={10} />
                <span>Tag</span>
              </button>
            )}
            {/* Share — moved here from its own row in the chat page, beside the tags */}
            {route === 'chat' && chatShare && (
              <button
                onClick={chatShare.onOpen}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded-full border transition-colors flex-shrink-0 ${
                  chatShare.shareCount !== 0
                    ? 'text-primary-fg-strong bg-primary-subtle border-primary-300 hover:bg-primary-100'
                    : 'text-fg-faint hover:text-fg-muted hover:bg-surface-muted border-transparent hover:border-edge'
                }`}
                title="Share this conversation"
              >
                <Share2 size={10} />
                <span>Share</span>
                {chatShare.shareCount !== 0 && (
                  <span className="inline-flex items-center gap-0.5 pl-1 border-l border-primary-300 ml-0.5">
                    <Eye size={10} />
                    {chatShare.shareCount === -1 ? <Users size={10} /> : <span>{chatShare.shareCount}</span>}
                  </span>
                )}
              </button>
            )}
          </>
        )}
      </div>

      {/* Right */}
      <div className="flex items-center gap-2">
        {children}
        {!isExternal && <WsStatusIndicator />}
        <AgentNavButton />
      </div>

      {/* Tag selector popover */}
      {!isLocalChatSession && tagSelector && currentChatSessionId && (
        <TagSelector
          sessionId={currentChatSessionId}
          sessionTags={currentSessionTags}
          allTags={allTags}
          onChanged={handleTagsChanged}
          onClose={() => setTagSelector(null)}
          x={tagSelector.x}
          y={tagSelector.y}
        />
      )}
    </header>
  );
}

// ─── WS Status Indicator (shows when disconnected/reconnecting) ──

function WsStatusIndicator() {
  const status = useWsStore((s) => s.status);

  // Only show when NOT connected — invisible when everything is fine
  if (status === 'connected') return null;

  const isConnecting = status === 'connecting';

  return (
    <div
      className={`p-1.5 rounded-md ${isConnecting ? 'text-warning animate-pulse' : 'text-fg-faint'}`}
      title={isConnecting ? 'Reconnecting...' : 'Disconnected — real-time notifications paused'}
    >
      <WifiOff size={16} />
    </div>
  );
}
