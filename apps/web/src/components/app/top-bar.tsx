/**
 * TopBar — contextual page/session title and local actions.
 *
 * For sub-module pages (Settings, Administration), shows breadcrumb:
 *   "Settings › Preferences" with optional subtitle.
 *
 * For chat, shows session title + profile badge.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Menu,
  ChevronRight,
  WifiOff,
  Tag,
  Share2,
  Users,
  History,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
} from '../../lib/icons';
import { useSidePaneStore, useUIStore, useWsStore } from '../../stores';
import { useT } from '../../lib/i18n';
import { resolveSubModule } from '../../lib/nav-registry';
import { TagSelector } from '../session-tags';
import { IconButton, Input, toast } from '../ui';
import { FullHistoryModal } from '../history-modal';
import { WorkbenchTopBarActions } from '../workbench/workbench-topbar-actions';
import { chatWorkspaceLabel } from '../chat/chat-workspace-navigation';
import type { ChatWorkspaceView } from '../../stores';
import type { SessionTag } from '../../lib/api';
import * as api from '../../lib/api';
import { MessageFeedback } from '../chat/message-feedback';

type Route =
  | 'home'
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

interface TopBarProps {
  route: Route;
  subPath?: string;
  sessionTitle?: string;
  chatWorkspaceView?: ChatWorkspaceView;
  onSelectSession: (sessionId: string) => void;
  /** Optional extra content rendered between title and right-side buttons */
  children?: React.ReactNode;
}

interface ChatFeedbackControls {
  sessionId: string;
  initialRating: number | null;
  initialComment: string | null;
  readonly: boolean;
}

interface ChatShareControls {
  shareCount: number;
  onOpen: () => void;
}

interface ChatTitleEditControls {
  readonly: boolean;
  onRename: (title: string) => Promise<void>;
}

/** Kept independent from the Zustand read so inline rename has a direct DOM test. */
export function EditableChatTitle({ title, controls }: { title: string; controls: ChatTitleEditControls | null }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const cancelBlurRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [editing, title]);

  const save = useCallback(async () => {
    const next = draft.trim();
    if (!controls || controls.readonly || !next || next === title) {
      setDraft(title);
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await controls.onRename(next);
      setEditing(false);
      toast(t('common.saved'), 'success');
    } catch {
      setDraft(title);
      setEditing(false);
      toast(t('common.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  }, [controls, draft, t, title]);

  if (editing) {
    return (
      <div className="w-[min(28rem,55vw)] min-w-[8rem]">
        <Input
          size="xs"
          value={draft}
          disabled={saving}
          autoFocus
          aria-label={t('common.rename')}
          className="h-7"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (cancelBlurRef.current) {
              cancelBlurRef.current = false;
              return;
            }
            void save();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelBlurRef.current = true;
              setDraft(title);
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <h2 className="truncate text-sm font-medium text-fg" title={title}>
        {title}
      </h2>
      {controls && !controls.readonly && (
        <IconButton
          size="compact"
          onClick={() => {
            cancelBlurRef.current = false;
            setDraft(title);
            setEditing(true);
          }}
          label={t('common.rename')}
        >
          <Pencil size={13} />
        </IconButton>
      )}
    </div>
  );
}

/** Session actions are kept renderable without store setup so their compact
 * TopBar contract has a direct regression test. */
export function ChatTopBarSessionActions({
  feedback,
  share,
}: {
  feedback: ChatFeedbackControls | null;
  share: ChatShareControls | null;
}) {
  const t = useT();
  return (
    <>
      {feedback && (
        <MessageFeedback
          messageId=""
          sessionId={feedback.sessionId}
          initialRating={feedback.initialRating}
          initialComment={feedback.initialComment}
          readonly={feedback.readonly}
          toolbar
        />
      )}
      {share && (
        <IconButton
          onClick={share.onOpen}
          label={t('chat.shareConversation')}
          wrapperClassName="relative"
          className={share.shareCount !== 0 ? 'text-primary-fg-strong' : ''}
        >
          <Share2 size={16} />
          {share.shareCount !== 0 && (
            <span className="absolute right-0 top-0 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary-600 px-0.5 text-[8px] leading-none text-white ring-2 ring-surface-raised">
              {share.shareCount === -1 ? <Users size={8} /> : share.shareCount}
            </span>
          )}
        </IconButton>
      )}
    </>
  );
}

// ── Sub-module metadata resolved from unified nav-registry ──

export function TopBar({
  route,
  subPath,
  sessionTitle,
  chatWorkspaceView = 'conversation',
  onSelectSession,
  children,
}: TopBarProps) {
  const t = useT();
  const {
    setNavOpen,
    currentSessionTags,
    currentChatSessionId,
    chatShare,
    chatFeedback,
    chatTitleEdit,
    homeWorkbench,
    setCurrentSessionInfo,
    bumpSessionListVersion,
  } = useUIStore();
  const [allTags, setAllTags] = useState<SessionTag[]>([]);
  const [tagSelector, setTagSelector] = useState<{ x: number; y: number } | null>(null);
  const [showMobileHistory, setShowMobileHistory] = useState(false);
  const sidePaneOpen = useSidePaneStore((state) => state.isOpen);
  const collapseSidePane = useSidePaneStore((state) => state.collapse);
  const reopenSidePane = useSidePaneStore((state) => state.reopen);

  // Load user tags once
  useEffect(() => {
    api
      .listSessionTags()
      .then(setAllTags)
      .catch(() => {});
  }, []);

  const handleTagEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTagSelector({ x: rect.left, y: rect.bottom + 4 });
  }, []);

  const handleTagsChanged = useCallback(async () => {
    if (!currentChatSessionId) return;
    try {
      const data = await api.getSession(currentChatSessionId);
      const tags = (data.session as any).tags || [];
      setCurrentSessionInfo(data.session.title || '', data.session.profile_id || 'team', tags);
      const freshTags = await api.listSessionTags();
      setAllTags(freshTags);
      bumpSessionListVersion();
    } catch {
      /* silent */
    }
  }, [currentChatSessionId, setCurrentSessionInfo, bumpSessionListVersion]);

  // Check for sub-module breadcrumb
  const subMeta = subPath ? resolveSubModule(route, subPath, t) : null;
  const isChatConversation = route === 'chat' && chatWorkspaceView === 'conversation';
  const chatUtilityTitle = route === 'chat' ? chatWorkspaceLabel(chatWorkspaceView, t) : null;

  // Fallback page titles
  const pageTitles: Record<string, string> = {
    workbench: 'Workbench',
    chat: chatUtilityTitle || sessionTitle || t('chat.newConversation'),
    automations: t('navigation.automation'),
    agents: t('navigation.myAgents'),
    projects: t('app.projects'),
    settings: t('app.settings'),
    administration: t('app.administration'),
    knowledge: t('app.knowledge'),
    tables: 'Tables',
    skillhub: t('app.skillhub'),
    tasks: t('navigation.myPrompts'),
    executions: t('taskCenter.title'),
  };

  const title = pageTitles[route] || '';

  // Module pages (Projects/Knowledge/Settings) render their own
  // header, so this breadcrumb bar would duplicate it — hide it on desktop and
  // keep only the mobile nav trigger. Chat has no page header of its own, so its
  // session title/tags/share bar stays visible at every width.
  const visibility = route === 'chat' ? 'flex' : 'flex md:hidden';

  return (
    <header
      className={`${visibility} min-h-10 items-center justify-between gap-2 border-b border-edge bg-surface-raised px-3 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] md:h-10 md:py-0 md:pt-0 flex-shrink-0 z-10`}
    >
      {/* Left — takes whatever width the actions leave and truncates the title. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <IconButton onClick={() => setNavOpen(true)} label={t('navigation.mobile')} wrapperClassName="-ml-1 md:hidden">
          <Menu size={20} />
        </IconButton>

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
        ) : /* Simple title */
        isChatConversation ? (
          <EditableChatTitle title={title} controls={chatTitleEdit} />
        ) : (
          <h2 className="truncate text-sm font-medium text-fg">{title}</h2>
        )}
      </div>

      {/* Right — session actions stay together and never compete with the title. */}
      <div className="ml-auto flex flex-shrink-0 items-center justify-end gap-1 sm:gap-2">
        {/* Workbench controls, only while the panel that registered them is on
            screen (the empty state of a new conversation). Sending the first
            message unmounts the panel, which takes these with it. */}
        {isChatConversation && <WorkbenchTopBarActions controls={homeWorkbench} />}
        {isChatConversation && (
          <IconButton
            onClick={sidePaneOpen ? collapseSidePane : reopenSidePane}
            label={sidePaneOpen ? t('sidePane.collapse') : t('sidePane.open')}
          >
            {sidePaneOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </IconButton>
        )}
        {isChatConversation && currentChatSessionId && (
          <IconButton
            onClick={handleTagEdit}
            label={currentSessionTags.length > 0 ? t('common.tags') : t('chat.addTags')}
            className={currentSessionTags.length > 0 ? 'text-primary-fg-strong' : ''}
          >
            <Tag size={16} />
          </IconButton>
        )}
        {isChatConversation && <ChatTopBarSessionActions feedback={chatFeedback} share={chatShare} />}
        {children}
        <div className="flex items-center gap-1 md:hidden">
          {route === 'chat' && (
            <IconButton onClick={() => setShowMobileHistory(true)} label={t('chat.sessionHistory')}>
              <History size={18} />
            </IconButton>
          )}
          <WsStatusIndicator />
        </div>
      </div>

      {/* Tag selector popover */}
      {tagSelector && isChatConversation && currentChatSessionId && (
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

      <FullHistoryModal
        open={showMobileHistory}
        onClose={() => setShowMobileHistory(false)}
        onSelectSession={(sessionId) => {
          setShowMobileHistory(false);
          onSelectSession(sessionId);
        }}
      />
    </header>
  );
}

// ─── WS Status Indicator (shows when disconnected/reconnecting) ──

export function WsStatusIndicator() {
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
