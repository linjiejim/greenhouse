/**
 * Chat History Panel — sidebar contextual panel for Chat tab.
 * Shows recent sessions grouped by date (Today / Yesterday / This Week / Earlier)
 * with search/filter capabilities and auto-refresh on new session creation.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Spinner, ConfirmDialog, toast, SearchInput } from '../../ui';
import {
  History,
  MoreHorizontal,
  Pencil,
  Trash2,
  Archive,
  RefreshCw,
  Tag,
  Copy,
  Share2,
  Pin,
  PinOff,
  FolderOpen,
  ChevronDown,
  ChevronRight,
} from '../../../lib/icons';
import { relativeTime } from '../../../lib/utils';
import { useSessionManager } from '../../../lib/session-manager';
import { useAuthStore, useUIStore } from '../../../stores';
import * as api from '../../../lib/api';
import { FullHistoryModal } from '../../history-modal';
import { useT } from '../../../lib/i18n';
import { TagFilter, TagSelector, TagManagerDialog, SessionTagsInline } from '../../session-tags';
import { GroupManagerDialog, GroupSelector } from '../../session-groups';
import type { SessionTag, SessionGroup } from '@greenhouse/types/api';

interface ChatHistoryPanelProps {
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  collapsed?: boolean;
}

// ── Date grouping helpers ────────────────────────────────

function getDateGroup(dateStr: string): 'today' | 'yesterday' | 'this-week' | 'earlier' {
  const now = new Date();
  const date = new Date(dateStr);

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);

  if (date >= todayStart) return 'today';
  if (date >= yesterdayStart) return 'yesterday';
  if (date >= weekStart) return 'this-week';
  return 'earlier';
}

const GROUP_LABELS: Record<string, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  'this-week': 'This Week',
  earlier: 'Earlier',
};

const GROUP_ORDER = ['today', 'yesterday', 'this-week', 'earlier'];

// Collapsed section state persists across reloads (per browser).
const COLLAPSED_STORAGE_KEY = 'chat-history-collapsed-sections';
const DATE_BUCKET_PAGE = 80;

function loadCollapsedSections(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedSections(keys: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    /* ignore quota errors */
  }
}

interface GroupedSessions {
  group: string;
  label: string;
  sessions: api.Session[];
}

function groupSessions(sessions: api.Session[]): GroupedSessions[] {
  const groups: Record<string, api.Session[]> = {};
  for (const session of sessions) {
    const group = getDateGroup(session.updated_at);
    if (!groups[group]) groups[group] = [];
    groups[group].push(session);
  }
  return GROUP_ORDER.filter((g) => groups[g] && groups[g].length > 0).map((g) => ({
    group: g,
    label: GROUP_LABELS[g],
    sessions: groups[g],
  }));
}

// ── Context Menu for session items ───────────────────────

interface SessionMenuState {
  sessionId: string;
  x: number;
  y: number;
}

function SessionContextMenu({
  x,
  y,
  session,
  onClose,
  onRename,
  onTags,
  onTogglePin,
  onMoveToGroup,
  onRegenerateTitle,
  onArchive,
  onDelete,
  isLocal,
}: {
  x: number;
  y: number;
  session: api.Session;
  onClose: () => void;
  onRename: (session: api.Session) => void;
  onTags: (session: api.Session) => void;
  onTogglePin: (session: api.Session) => void;
  onMoveToGroup: (session: api.Session, x: number, y: number) => void;
  onRegenerateTitle: (session: api.Session) => void;
  onArchive: (session: api.Session) => void;
  onDelete: (session: api.Session) => void;
  isLocal?: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Adjust position to stay within viewport
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menuRef.current.style.left = `${x - rect.width}px`;
      }
      if (rect.bottom > window.innerHeight) {
        menuRef.current.style.top = `${y - rect.height}px`;
      }
    }
  }, [x, y]);

  const items = [
    { key: 'rename', icon: Pencil, label: t('common.edit') || 'Rename', action: () => onRename(session) },
    !isLocal && {
      key: 'pin',
      icon: session.pinned ? PinOff : Pin,
      label: session.pinned ? t('sessionGroups.unpin') || 'Unpin' : t('sessionGroups.pin') || 'Pin',
      action: () => onTogglePin(session),
    },
    !isLocal && {
      key: 'move-to-group',
      icon: FolderOpen,
      label: t('sessionGroups.moveToGroup') || 'Move to group',
      action: () => onMoveToGroup(session, x, y),
    },
    !isLocal && { key: 'tags', icon: Tag, label: 'Tags', action: () => onTags(session) },
    !isLocal && {
      key: 'regenerate-title',
      icon: RefreshCw,
      label: 'Regenerate Title',
      action: () => onRegenerateTitle(session),
    },
    { key: 'archive', icon: Archive, label: t('common.archive') || 'Archive', action: () => onArchive(session) },
    {
      key: 'copy-id',
      icon: Copy,
      label: 'Copy Session ID',
      action: () => {
        navigator.clipboard.writeText(session.id);
        toast('Session ID copied', 'success');
      },
    },
    {
      key: 'delete',
      icon: Trash2,
      label: t('common.delete') || 'Delete',
      danger: true,
      action: () => onDelete(session),
    },
  ].filter(Boolean) as Array<{
    key: string;
    icon: typeof Pencil;
    label: string;
    action: () => void;
    danger?: boolean;
  }>;

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[140px] py-1 bg-surface-raised border border-edge rounded-lg shadow-lg animate-fade-in"
      style={{ left: x, top: y }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          onClick={(e) => {
            e.stopPropagation();
            item.action();
            onClose();
          }}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
            item.danger
              ? 'text-danger hover:bg-danger-subtle'
              : 'text-fg-secondary hover:bg-surface-muted hover:text-fg'
          }`}
        >
          <item.icon size={13} />
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function ChatHistoryPanel({ currentSessionId, onSelectSession, collapsed }: ChatHistoryPanelProps) {
  const t = useT();
  const isExternal = useAuthStore((s) => s.currentUser?.role === 'external');
  const isLocalHistory = false;
  const [sessions, setSessions] = useState<api.Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showFullHistory, setShowFullHistory] = useState(false);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<SessionMenuState | null>(null);
  // Rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Delete confirm state
  const [pendingDeleteSession, setPendingDeleteSession] = useState<api.Session | null>(null);
  // Tag state
  const [allTags, setAllTags] = useState<SessionTag[]>([]);
  const [activeTagFilter, setActiveTagFilter] = useState<number | null>(null);
  const [showTagManager, setShowTagManager] = useState(false);
  const [tagSelectorState, setTagSelectorState] = useState<{ session: api.Session; x: number; y: number } | null>(null);
  // Group (folder) state
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [showGroupManager, setShowGroupManager] = useState(false);
  const [groupSelectorState, setGroupSelectorState] = useState<{
    session: api.Session;
    x: number;
    y: number;
  } | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(loadCollapsedSections);
  // How many date-bucket sessions to render (incremented by "show more").
  const [dateBucketLimit, setDateBucketLimit] = useState(DATE_BUCKET_PAGE);
  // Drag: which session is being dragged, from which section (+ that section's
  // group id for reorder persistence). Drives both in-section reorder and
  // cross-section move.
  const [dragState, setDragState] = useState<{
    sectionKey: string;
    dragGroupId?: number;
    orderedIds: string[];
    draggingId: string;
  } | null>(null);
  // Typewriter animation: track session IDs with recently AI-generated titles
  const [typewriterIds, setTypewriterIds] = useState<Set<string>>(new Set());
  const prevTitleMapRef = useRef<Map<string, string>>(new Map());

  const { activeSessions, unreadSessions, importantSessions } = useSessionManager();
  const { sessionListVersion, bumpSessionListVersion } = useUIStore();

  // ── Session actions ──
  const handleRenameStart = useCallback((session: api.Session) => {
    setRenamingId(session.id);
    setRenameValue(session.title || '');
    // Focus input after render
    setTimeout(() => renameInputRef.current?.focus(), 50);
  }, []);

  const handleRenameSubmit = useCallback(async () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    try {
      await api.updateSession(renamingId, { title: trimmed });
      setSessions((prev) => prev.map((s) => (s.id === renamingId ? { ...s, title: trimmed } : s)));
      toast(t('common.saved') || 'Saved', 'success');
    } catch {
      toast(t('common.saveFailed') || 'Save failed', 'error');
    }
    setRenamingId(null);
  }, [renamingId, renameValue, t]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRenameSubmit();
      } else if (e.key === 'Escape') {
        setRenamingId(null);
      }
    },
    [handleRenameSubmit],
  );

  const handleArchive = useCallback(
    async (session: api.Session) => {
      try {
        await api.updateSession(session.id, { status: 'archived' });
        setSessions((prev) => prev.filter((s) => s.id !== session.id));
        bumpSessionListVersion();
        toast(t('common.archived') || 'Archived', 'info');
      } catch {
        toast(t('common.saveFailed') || 'Failed', 'error');
      }
    },
    [t, bumpSessionListVersion],
  );

  const handleRegenerateTitle = useCallback(
    async (session: api.Session) => {
      try {
        const title = await api.regenerateTitle(session.id);
        setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, title } : s)));
        // Trigger typewriter animation for this session
        setTypewriterIds((prev) => new Set(prev).add(session.id));
        setTimeout(
          () =>
            setTypewriterIds((prev) => {
              const next = new Set(prev);
              next.delete(session.id);
              return next;
            }),
          1500,
        );
        bumpSessionListVersion();
        toast(t('common.saved') || 'Title updated', 'success');
      } catch {
        toast(t('common.saveFailed') || 'Failed to regenerate title', 'error');
      }
    },
    [t, bumpSessionListVersion],
  );

  const handleDelete = useCallback((session: api.Session) => {
    setPendingDeleteSession(session);
  }, []);

  const handleTagsClick = useCallback(
    (session: api.Session) => {
      // Use context menu position as fallback, or center of session item
      const x = contextMenu?.x ?? 200;
      const y = contextMenu?.y ?? 200;
      setContextMenu(null);
      setTagSelectorState({ session, x, y });
    },
    [contextMenu],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDeleteSession) return;
    try {
      await api.updateSession(pendingDeleteSession.id, { status: 'deleted' });
      setSessions((prev) => prev.filter((s) => s.id !== pendingDeleteSession.id));
      bumpSessionListVersion();
      toast(t('chat.sessionMovedToTrash') || 'Session moved to trash', 'info');
    } catch {
      toast(t('common.deleteFailed') || 'Delete failed', 'error');
    }
    setPendingDeleteSession(null);
  }, [pendingDeleteSession, t, bumpSessionListVersion]);

  const handleContextMenu = useCallback((e: React.MouseEvent, session: api.Session) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ sessionId: session.id, x: e.clientX, y: e.clientY });
  }, []);

  const handleMoreClick = useCallback((e: React.MouseEvent, session: api.Session) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({ sessionId: session.id, x: rect.left, y: rect.bottom + 4 });
  }, []);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listSessions('active', false);
      // Keep the full set (server caps at 500): pinned/grouped sessions must
      // survive even when older than the 50 most-recent. Date buckets cap
      // their own render below.
      const sorted = data.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      setSessions(sorted);
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
    setLoading(false);
  }, []);

  // Load user tags (internal users only — external users get 403)
  const loadTags = useCallback(async () => {
    if (isExternal || isLocalHistory) return;
    try {
      const data = await api.listSessionTags();
      setAllTags(data);
    } catch {
      // silent — tags are optional
    }
  }, [isExternal, isLocalHistory]);

  // Load user groups/folders (internal users only)
  const loadGroups = useCallback(async () => {
    if (isExternal || isLocalHistory) return;
    try {
      setGroups(await api.listSessionGroups());
    } catch {
      // silent — groups are optional
    }
  }, [isExternal, isLocalHistory]);

  useEffect(() => {
    loadSessions();
    loadTags();
    loadGroups();
  }, [loadSessions, loadTags, loadGroups]);

  const handleTagsChanged = useCallback(() => {
    // Reload tags and sessions
    loadTags();
    loadSessions();
  }, [loadSessions, loadTags]);

  // Reload after a group membership / library change (move, pin, manager edits).
  const handleGroupsChanged = useCallback(() => {
    loadGroups();
    loadSessions();
  }, [loadGroups, loadSessions]);

  // Pin / unpin (optimistic, then refresh sort orders + counts).
  const handleTogglePin = useCallback(
    async (session: api.Session) => {
      const willPin = !session.pinned;
      setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, pinned: willPin } : s)));
      try {
        if (willPin) await api.pinSession(session.id);
        else await api.unpinSession(session.id);
        loadSessions();
        loadGroups();
      } catch {
        setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, pinned: !willPin } : s)));
        toast(t('common.saveFailed') || 'Failed', 'error');
      }
    },
    [t, loadSessions, loadGroups],
  );

  const handleMoveToGroupClick = useCallback((session: api.Session, x: number, y: number) => {
    setContextMenu(null);
    setGroupSelectorState({ session, x, y });
  }, []);

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsedSections(next);
      return next;
    });
  }, []);

  // ── Drag: reorder within a section + move across sections ──
  const handleRowDragStart = useCallback(
    (e: React.DragEvent, sectionKey: string, dragGroupId: number | undefined, orderedIds: string[], id: string) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
      setDragState({ sectionKey, dragGroupId, orderedIds, draggingId: id });
    },
    [],
  );

  const handleRowDragOver = useCallback((e: React.DragEvent, sectionKey: string, overId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragState((prev) => {
      // Live-reorder only within the source section, and only orderable ones
      // (Pinned / folders have a group id; date buckets do not).
      if (!prev || prev.sectionKey !== sectionKey || prev.dragGroupId == null || prev.draggingId === overId)
        return prev;
      const order = [...prev.orderedIds];
      const from = order.indexOf(prev.draggingId);
      const to = order.indexOf(overId);
      if (from === -1 || to === -1) return prev;
      order.splice(from, 1);
      order.splice(to, 0, prev.draggingId);
      return { ...prev, orderedIds: order };
    });
  }, []);

  const handleRowDragEnd = useCallback(() => setDragState(null), []);

  // Drop onto a section: same section → persist reorder; other section → move.
  const handleSectionDrop = useCallback(
    async (targetKey: string, targetGroupId: number | undefined) => {
      const ds = dragState;
      setDragState(null);
      if (!ds) return;
      const id = ds.draggingId;

      // Same orderable section → persist the new member order.
      if (ds.sectionKey === targetKey) {
        if (targetGroupId == null) return;
        const updates = ds.orderedIds.map((session_id, i) => ({ session_id, sort_order: i }));
        const sortMap = new Map(updates.map((u) => [u.session_id, u.sort_order]));
        setSessions((prev) =>
          prev.map((s) => {
            if (!sortMap.has(s.id)) return s;
            const so = sortMap.get(s.id)!;
            return targetKey === 'pinned' ? { ...s, pin_sort: so } : { ...s, group_sort: so };
          }),
        );
        try {
          await api.reorderGroupMembers(targetGroupId, updates);
        } catch {
          toast(t('sessionGroups.reorderFailed') || 'Failed to reorder', 'error');
          loadSessions();
        }
        return;
      }

      // Cross-section → move the session.
      try {
        if (targetKey === 'pinned') await api.pinSession(id);
        else if (targetKey.startsWith('g:') && targetGroupId != null) await api.setSessionGroup(id, targetGroupId);
        else if (targetKey === 'ungrouped') await api.setSessionGroup(id, null);
        else return;
        toast(t('sessionGroups.moved') || 'Moved', 'info');
        loadSessions();
        loadGroups();
      } catch {
        toast(t('common.saveFailed') || 'Failed', 'error');
      }
    },
    [dragState, t, loadSessions, loadGroups],
  );

  // Auto-refresh when streaming sessions change or new sessions are created
  useEffect(() => {
    if (activeSessions.size > 0) {
      loadSessions();
    }
  }, [activeSessions.size, loadSessions]);

  // Auto-refresh when session list version changes (new session created)
  useEffect(() => {
    if (sessionListVersion > 0) {
      loadSessions();
    }
  }, [sessionListVersion, loadSessions]);

  // Detect AI-generated title from streaming sessions and apply typewriter effect
  useEffect(() => {
    for (const [sid, managed] of activeSessions) {
      if (managed.generatedTitle) {
        const prevTitle = prevTitleMapRef.current.get(sid);
        if (prevTitle !== managed.generatedTitle) {
          prevTitleMapRef.current.set(sid, managed.generatedTitle);
          // Update the session title in local list
          setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, title: managed.generatedTitle! } : s)));
          // Trigger typewriter animation
          setTypewriterIds((prev) => new Set(prev).add(sid));
          setTimeout(
            () =>
              setTypewriterIds((prev) => {
                const next = new Set(prev);
                next.delete(sid);
                return next;
              }),
            1500,
          );
        }
      }
    }
  }, [activeSessions]);

  const filteredSessions = useMemo(() => {
    let result = sessions;
    if (searchQuery) {
      result = result.filter((s) => (s.title || '').toLowerCase().includes(searchQuery.toLowerCase()));
    }
    if (!isLocalHistory && activeTagFilter != null) {
      result = result.filter((s) => (s as any).tags?.some((t: any) => t.id === activeTagFilter));
    }
    return result;
  }, [sessions, searchQuery, activeTagFilter, isLocalHistory]);

  // ── Partition into sections: Pinned (cross-cutting) + folders (single-home)
  //    + date buckets (the unpinned, unfiled rest). Local history has neither
  //    pinned nor group fields, so it falls entirely into date buckets. ──
  const pinnedGroupId = useMemo(() => groups.find((g) => g.kind === 'pinned')?.id, [groups]);
  const customGroups = useMemo(
    () => groups.filter((g) => g.kind !== 'pinned').sort((a, b) => a.sort_order - b.sort_order),
    [groups],
  );

  const pinnedSessions = useMemo(
    () =>
      isLocalHistory
        ? []
        : filteredSessions.filter((s) => s.pinned).sort((a, b) => (a.pin_sort ?? 0) - (b.pin_sort ?? 0)),
    [filteredSessions, isLocalHistory],
  );

  const folderSections = useMemo(() => {
    if (isLocalHistory) return [];
    // While dragging, show empty folders too so they can be drop targets.
    const showEmpty = dragState != null;
    return customGroups
      .map((g) => ({
        group: g,
        sessions: filteredSessions
          .filter((s) => s.group_id === g.id)
          .sort((a, b) => (a.group_sort ?? 0) - (b.group_sort ?? 0)),
      }))
      .filter((sec) => sec.sessions.length > 0 || showEmpty);
  }, [customGroups, filteredSessions, isLocalHistory, dragState]);

  // Date buckets exclude pinned (lifted up) and filed (shown in their folder).
  const dateBucketSessions = useMemo(
    () => (isLocalHistory ? filteredSessions : filteredSessions.filter((s) => !s.pinned && s.group_id == null)),
    [filteredSessions, isLocalHistory],
  );
  const groupedSessions = useMemo(
    () => groupSessions(dateBucketSessions.slice(0, dateBucketLimit)),
    [dateBucketSessions, dateBucketLimit],
  );
  const hasMoreDateBuckets = dateBucketSessions.length > dateBucketLimit;

  if (collapsed) return null;

  // ── Row + section renderers (shared by Pinned, folders, and date buckets) ──
  const renderRow = (session: api.Session, sectionKey: string, dragGroupId?: number, orderedIds?: string[]) => {
    const isActive = session.id === currentSessionId;
    const isSessionStreaming = activeSessions.get(session.id)?.status === 'streaming';
    const isUnread = unreadSessions.has(session.id);
    const isImportant = importantSessions.has(session.id);
    const isRenaming = renamingId === session.id;
    const isTypewriting = typewriterIds.has(session.id);
    // All cloud rows are draggable (to move across sections); only Pinned /
    // folder rows reorder within their section (they carry a dragGroupId).
    const draggable = !isLocalHistory && !isRenaming;
    const isDragging = dragState?.draggingId === session.id;
    return (
      <div
        key={session.id}
        role="button"
        tabIndex={0}
        draggable={draggable}
        onDragStart={
          draggable ? (e) => handleRowDragStart(e, sectionKey, dragGroupId, orderedIds ?? [], session.id) : undefined
        }
        onDragOver={draggable ? (e) => handleRowDragOver(e, sectionKey, session.id) : undefined}
        onDragEnd={draggable ? handleRowDragEnd : undefined}
        onClick={() => !isRenaming && onSelectSession(session.id)}
        onContextMenu={(e) => handleContextMenu(e, session)}
        className={`group/item w-full text-left px-3 py-2 flex items-center gap-2 transition-colors cursor-pointer ${
          isDragging ? 'opacity-50 ' : ''
        }${
          isActive
            ? 'bg-primary-subtle border-r-2 border-r-primary-500'
            : isUnread
              ? 'bg-info-subtle/50 hover:bg-info-subtle'
              : 'hover:bg-surface-muted'
        }`}
      >
        <span className="flex-shrink-0 w-2 flex items-center justify-center">
          {isSessionStreaming && (
            <span className="w-2 h-2 rounded-full bg-primary-500 animate-pulse" title="Streaming..." />
          )}
          {isUnread && !isSessionStreaming && (
            <span className="w-2 h-2 rounded-full bg-blue-500" title="New response" />
          )}
          {isImportant && !isUnread && !isSessionStreaming && (
            <span className="text-[8px]" title="Important">
              ⭐
            </span>
          )}
        </span>
        {isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={handleRenameKeyDown}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 text-xs bg-surface-sunken border border-primary-500 rounded px-1.5 py-0.5 focus:outline-none text-fg"
            autoFocus
          />
        ) : (
          <span
            className={`flex-1 min-w-0 text-xs truncate ${
              isActive ? 'text-primary-fg-strong font-medium' : isUnread ? 'text-fg font-medium' : 'text-fg-secondary'
            }${isTypewriting ? ' animate-typewriter' : ''}`}
            title={session.title || 'Untitled'}
          >
            {session.title || 'Untitled'}
          </span>
        )}
        {sectionKey !== 'pinned' && session.pinned && !isLocalHistory && (
          <Pin size={10} className="flex-shrink-0 text-fg-faint" aria-label="Pinned" />
        )}
        {isLocalHistory && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-surface-sunken text-fg-faint flex-shrink-0">
            Local
          </span>
        )}
        {!isLocalHistory && session.shared && (
          <Share2 size={11} className="flex-shrink-0 text-fg-faint" aria-label="Shared with you" />
        )}
        {!isLocalHistory && (session as any).tags?.length > 0 && (
          <SessionTagsInline
            tags={(session as any).tags}
            maxVisible={1}
            size="xs"
            onEdit={(e) => {
              e.stopPropagation();
              setTagSelectorState({ session, x: e.clientX, y: e.clientY });
            }}
          />
        )}
        <span className="relative flex-shrink-0 flex items-center">
          <span className="text-[10px] text-fg-faint tabular-nums group-hover/item:invisible">
            {relativeTime(session.updated_at)}
          </span>
          <button
            onClick={(e) => handleMoreClick(e, session)}
            className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/item:opacity-100 touch-visible transition-opacity text-fg-faint hover:text-fg-secondary"
            title="More"
          >
            <MoreHorizontal size={14} />
          </button>
        </span>
      </div>
    );
  };

  const renderSection = (opts: {
    key: string;
    title: string;
    count: number;
    sessions: api.Session[];
    dragGroupId?: number;
    colorDot?: string;
    showPinIcon?: boolean;
  }) => {
    const { key, title, count, sessions: secSessions, dragGroupId, colorDot, showPinIcon } = opts;
    const isCollapsed = collapsedSections.has(key);
    // While reordering this section, render in the live drag order.
    let display = secSessions;
    if (dragState?.sectionKey === key) {
      const pos = new Map(dragState.orderedIds.map((id, i) => [id, i] as const));
      display = [...secSessions].sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    }
    const orderedIds = display.map((s) => s.id);
    const isDropTarget = dragState != null && dragState.sectionKey !== key;
    return (
      <div key={key} onDragOver={(e) => e.preventDefault()} onDrop={() => handleSectionDrop(key, dragGroupId)}>
        <button
          onClick={() => toggleSection(key)}
          className={`w-full flex items-center gap-1.5 px-3 py-1 mt-1 first:mt-0 text-fg-faint hover:text-fg-secondary transition-colors ${
            isDropTarget ? 'bg-primary-subtle/40' : ''
          }`}
        >
          {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          {showPinIcon && <Pin size={11} />}
          {colorDot && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: colorDot }} />}
          <span className="text-[10px] font-semibold uppercase tracking-wider flex-1 text-left truncate">{title}</span>
          <span className="text-[10px] tabular-nums">{count}</span>
        </button>
        {!isCollapsed && display.map((s) => renderRow(s, key, dragGroupId, orderedIds))}
        {!isCollapsed && display.length === 0 && isDropTarget && (
          <div className="mx-3 my-1 rounded border border-dashed border-edge px-3 py-2 text-center text-[10px] text-fg-faint">
            {t('sessionGroups.dropHere') || 'Drop here'}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="flex flex-col flex-1 min-h-0">
        {/* Search + quick actions */}
        <div className="px-3 py-1.5 flex-shrink-0 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search..."
              size="sm"
              className="flex-1 min-w-0"
            />
            {!isLocalHistory && (
              <button
                onClick={() => setShowGroupManager(true)}
                className="p-1.5 text-fg-faint hover:text-fg-secondary hover:bg-surface-muted rounded transition-colors flex-shrink-0"
                title={t('sessionGroups.manageGroups') || 'Manage groups'}
              >
                <FolderOpen size={14} />
              </button>
            )}
            {!isLocalHistory && (
              <button
                onClick={() => setShowTagManager(true)}
                className="p-1.5 text-fg-faint hover:text-fg-secondary hover:bg-surface-muted rounded transition-colors flex-shrink-0"
                title="Manage Tags"
              >
                <Tag size={14} />
              </button>
            )}
            {!isLocalHistory && (
              <button
                onClick={() => setShowFullHistory(true)}
                className="p-1.5 text-fg-faint hover:text-fg-secondary hover:bg-surface-muted rounded transition-colors flex-shrink-0"
                title="View All"
              >
                <History size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Tag filter */}
        {!isLocalHistory && allTags.length > 0 && (
          <div className="px-3 pb-2 flex-shrink-0">
            <TagFilter tags={allTags} activeTagId={activeTagFilter} onSelect={setActiveTagFilter} />
          </div>
        )}

        {/* Session list — grouped by date */}
        <div className="flex-1 overflow-y-auto">
          {loading && sessions.length === 0 && (
            <div className="flex justify-center py-6">
              <Spinner className="h-4 w-4 text-fg-faint" />
            </div>
          )}

          {!loading && filteredSessions.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-fg-faint">
              {searchQuery
                ? 'No matches'
                : isLocalHistory
                  ? 'No local conversations found'
                  : t('chat.noConversationsFound')}
            </div>
          )}

          {/* Pinned — cross-cutting, lifted above date buckets */}
          {pinnedSessions.length > 0 &&
            renderSection({
              key: 'pinned',
              title: t('sessionGroups.pinned') || 'Pinned',
              count: pinnedSessions.length,
              sessions: pinnedSessions,
              dragGroupId: pinnedGroupId,
              showPinIcon: true,
            })}

          {/* User folders (single-home) */}
          {folderSections.map((sec) =>
            renderSection({
              key: `g:${sec.group.id}`,
              title: sec.group.name,
              count: sec.sessions.length,
              sessions: sec.sessions,
              dragGroupId: sec.group.id,
              colorDot: sec.group.color,
            }),
          )}

          {/* Date buckets — the unpinned, unfiled rest. Also a drop target:
              dropping a filed session here removes it from its folder. */}
          <div onDragOver={(e) => e.preventDefault()} onDrop={() => handleSectionDrop('ungrouped', undefined)}>
            {groupedSessions.map((group) => (
              <div key={group.group}>
                <div className="px-3 py-1 mt-1 first:mt-0">
                  <span className="text-[10px] font-semibold text-fg-faint uppercase tracking-wider">
                    {group.label}
                  </span>
                </div>
                {group.sessions.map((session) => renderRow(session, `date:${group.group}`))}
              </div>
            ))}
            {hasMoreDateBuckets && (
              <button
                onClick={() => setDateBucketLimit((n) => n + DATE_BUCKET_PAGE)}
                className="w-full px-3 py-2 text-[11px] text-fg-faint hover:text-fg-secondary hover:bg-surface-muted transition-colors"
              >
                {t('sessionGroups.showMore') || 'Show more'}
              </button>
            )}
          </div>
        </div>
      </div>

      <FullHistoryModal
        open={!isLocalHistory && showFullHistory}
        onClose={() => setShowFullHistory(false)}
        onSelectSession={(id) => {
          onSelectSession(id);
          setShowFullHistory(false);
        }}
      />

      {/* Context menu */}
      {contextMenu &&
        (() => {
          const menuSession = sessions.find((s) => s.id === contextMenu.sessionId);
          if (!menuSession) return null;
          return (
            <SessionContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              session={menuSession}
              onClose={() => setContextMenu(null)}
              onRename={handleRenameStart}
              onTags={handleTagsClick}
              onTogglePin={handleTogglePin}
              onMoveToGroup={handleMoveToGroupClick}
              onRegenerateTitle={handleRegenerateTitle}
              onArchive={handleArchive}
              onDelete={handleDelete}
              isLocal={isLocalHistory}
            />
          );
        })()}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!pendingDeleteSession}
        onClose={() => setPendingDeleteSession(null)}
        onConfirm={confirmDelete}
        title={t('chat.deleteSessionTitle') || 'Delete session?'}
        description={t('chat.sessionMovedToTrash') || 'Session will be moved to trash.'}
        confirmLabel={t('common.delete') || 'Delete'}
        confirmVariant="destructive"
      />

      {/* Tag selector popover */}
      {!isLocalHistory && tagSelectorState && (
        <TagSelector
          sessionId={tagSelectorState.session.id}
          sessionTags={(tagSelectorState.session as any).tags || []}
          allTags={allTags}
          onChanged={handleTagsChanged}
          onClose={() => setTagSelectorState(null)}
          x={tagSelectorState.x}
          y={tagSelectorState.y}
        />
      )}

      {/* Tag manager dialog */}
      <TagManagerDialog
        open={!isLocalHistory && showTagManager}
        onClose={() => setShowTagManager(false)}
        onTagsChanged={handleTagsChanged}
      />

      {/* Group selector popover (move session to a folder) */}
      {!isLocalHistory && groupSelectorState && (
        <GroupSelector
          sessionId={groupSelectorState.session.id}
          currentGroupId={groupSelectorState.session.group_id ?? null}
          allGroups={groups}
          onChanged={handleGroupsChanged}
          onClose={() => setGroupSelectorState(null)}
          x={groupSelectorState.x}
          y={groupSelectorState.y}
        />
      )}

      {/* Group manager dialog */}
      <GroupManagerDialog
        open={!isLocalHistory && showGroupManager}
        onClose={() => setShowGroupManager(false)}
        onGroupsChanged={handleGroupsChanged}
      />
    </>
  );
}
