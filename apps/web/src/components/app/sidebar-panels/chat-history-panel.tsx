/**
 * Chat History Panel — sidebar contextual panel for Chat tab.
 * Shows recent sessions grouped by date (Today / Yesterday / This Week / Earlier)
 * with search/filter capabilities and auto-refresh on new session creation.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Spinner, ConfirmDialog, StatusDot, Checkbox, FilterPills, toast } from '../../ui';
import { SidebarToolbar } from '../sidebar-toolbar';
import {
  History,
  MoreHorizontal,
  Pencil,
  Trash2,
  Archive,
  RefreshCw,
  Copy,
  Share2,
  Pin,
  PinOff,
  ChevronDown,
  ChevronRight,
  CheckSquare,
} from '../../../lib/icons';
import { relativeTime } from '../../../lib/utils';
import { SessionTypeIcon } from '../../chat/session-type-icon';
import { useSessionManager } from '../../../lib/session-manager';
import { useUIStore, useAuthStore, useWsStore } from '../../../stores';
import * as api from '../../../lib/api';
import { runWithConcurrency } from '@greenhouse/utils/concurrency';
import { FullHistoryModal } from '../../history-modal';
import { useT } from '../../../lib/i18n';
import { BatchActionBar } from './batch-action-bar';
import { pruneMissing, rangeSelect, toggleOne, type SelectableRow } from './selection';
import type { SessionScope } from '@greenhouse/types/api';
import { DEFAULT_ASSET_SCOPE } from '../../../lib/asset-scopes';

// Long-press duration (touch) to enter multi-select mode.
const LONG_PRESS_MS = 450;
const BATCH_CONCURRENCY = 5;

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
  onTogglePin,
  onRegenerateTitle,
  onArchive,
  onDelete,
}: {
  x: number;
  y: number;
  session: api.Session;
  onClose: () => void;
  onRename: (session: api.Session) => void;
  onTogglePin: (session: api.Session) => void;
  onRegenerateTitle: (session: api.Session) => void;
  onArchive: (session: api.Session) => void;
  onDelete: (session: api.Session) => void;
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
    { key: 'rename', icon: Pencil, label: t('common.rename'), action: () => onRename(session) },
    {
      key: 'pin',
      icon: session.pinned ? PinOff : Pin,
      label: session.pinned ? t('sessionGroups.unpin') : t('sessionGroups.pin'),
      action: () => onTogglePin(session),
    },
    {
      key: 'regenerate-title',
      icon: RefreshCw,
      label: 'Regenerate Title',
      action: () => onRegenerateTitle(session),
    },
    { key: 'archive', icon: Archive, label: t('common.archive'), action: () => onArchive(session) },
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
      label: t('common.delete'),
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
      className="fixed z-50 min-w-[140px] py-1 bg-surface-raised border border-edge rounded-md shadow-lg animate-fade-in"
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
  const [sessions, setSessions] = useState<api.Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showFullHistory, setShowFullHistory] = useState(false);
  // Broader scopes are intentionally session-local: every fresh Chat surface
  // starts on the caller's own conversations, including for super users.
  const [scope, setScope] = useState<SessionScope>(DEFAULT_ASSET_SCOPE);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<SessionMenuState | null>(null);
  // Rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Delete confirm state
  const [pendingDeleteSession, setPendingDeleteSession] = useState<api.Session | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(loadCollapsedSections);
  // How many date-bucket sessions to render (incremented by "show more").
  const [dateBucketLimit, setDateBucketLimit] = useState(DATE_BUCKET_PAGE);
  // Drag: which session is being dragged, from which section (+ whether that
  // section is orderable). Drives in-section reorder of Pinned and dropping a
  // row onto Pinned to pin it.
  const [dragState, setDragState] = useState<{
    sectionKey: string;
    orderable: boolean;
    orderedIds: string[];
    draggingId: string;
  } | null>(null);
  // Typewriter animation: track session IDs with recently AI-generated titles
  const [typewriterIds, setTypewriterIds] = useState<Set<string>>(new Set());
  const prevTitleMapRef = useRef<Map<string, string>>(new Map());

  // ── Multi-select (batch operations) ──
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Anchor for Shift-ranges: the ROW key (`<sectionKey>|<sessionId>`), so a
  // session drawn in more than one section is never confused with its copy.
  const [lastClickedKey, setLastClickedKey] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  // Batch confirm (archive / delete the selection).
  const [batchConfirm, setBatchConfirm] = useState<'archive' | 'delete' | null>(null);
  // Long-press (touch) → enter select mode.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  const { activeSessions, unreadSessions, remoteStreamingSessions } = useSessionManager();
  const { sessionListVersion, bumpSessionListVersion } = useUIStore();
  const currentUser = useAuthStore((s) => s.currentUser);
  // Same unread number the inbox shows — one server-pushed count, not a second tally.
  const unreadShareCount = useWsStore((s) => s.shareCount);
  const isSuper = currentUser?.role === 'super';

  // A stored 'team' from a demoted account would 403 on every load.
  const effectiveScope: SessionScope = scope === 'team' && !isSuper ? 'mine' : scope;

  const changeScope = useCallback((next: SessionScope) => {
    setScope(next);
    setDateBucketLimit(DATE_BUCKET_PAGE);
  }, []);

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
      toast(t('common.saved'), 'success');
    } catch {
      toast(t('common.saveFailed'), 'error');
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
        toast(t('common.archived'), 'info');
      } catch {
        toast(t('common.saveFailed'), 'error');
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
        toast(t('common.saved'), 'success');
      } catch {
        toast(t('common.saveFailed'), 'error');
      }
    },
    [t, bumpSessionListVersion],
  );

  const handleDelete = useCallback((session: api.Session) => {
    setPendingDeleteSession(session);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDeleteSession) return;
    try {
      await api.updateSession(pendingDeleteSession.id, { status: 'deleted' });
      setSessions((prev) => prev.filter((s) => s.id !== pendingDeleteSession.id));
      bumpSessionListVersion();
      toast(t('chat.sessionMovedToTrash'), 'info');
    } catch {
      toast(t('common.deleteFailed'), 'error');
    }
    setPendingDeleteSession(null);
  }, [pendingDeleteSession, t, bumpSessionListVersion]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, session: api.Session) => {
      e.preventDefault();
      e.stopPropagation();
      // Touch browsers synthesize `contextmenu` from a long press — the very
      // gesture that enters select mode. Opening the single-session menu on top
      // of it would leave two conflicting UIs on screen.
      if (selectMode || longPressFired.current) return;
      setContextMenu({ sessionId: session.id, x: e.clientX, y: e.clientY });
    },
    [selectMode],
  );

  const handleMoreClick = useCallback((e: React.MouseEvent, session: api.Session) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({ sessionId: session.id, x: rect.left, y: rect.bottom + 4 });
  }, []);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listSessions('active', false, 500, effectiveScope);
      // Keep the full set (server caps at 500): pinned sessions must
      // survive even when older than the 50 most-recent. Date buckets cap
      // their own render below.
      const sorted = data.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      setSessions(sorted);
      // Keep survivors ticked across refreshes; drop ids that vanished.
      const ids = new Set(sorted.map((s) => s.id));
      setSelectedIds((prev) => pruneMissing(prev, ids));
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
    setLoading(false);
  }, [effectiveScope]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Pin / unpin (optimistic, then refresh sort orders).
  const handleTogglePin = useCallback(
    async (session: api.Session) => {
      const willPin = !session.pinned;
      setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, pinned: willPin } : s)));
      try {
        if (willPin) await api.pinSession(session.id);
        else await api.unpinSession(session.id);
        loadSessions();
      } catch {
        setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, pinned: !willPin } : s)));
        toast(t('common.saveFailed'), 'error');
      }
    },
    [t, loadSessions],
  );

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsedSections(next);
      return next;
    });
  }, []);

  // ── Drag: reorder within Pinned + drop onto Pinned to pin ──
  const handleRowDragStart = useCallback(
    (e: React.DragEvent, sectionKey: string, orderable: boolean, orderedIds: string[], id: string) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
      setDragState({ sectionKey, orderable, orderedIds, draggingId: id });
    },
    [],
  );

  const handleRowDragOver = useCallback((e: React.DragEvent, sectionKey: string, overId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragState((prev) => {
      // Live-reorder only within the source section, and only orderable ones
      // (Pinned; date buckets are not).
      if (!prev || prev.sectionKey !== sectionKey || !prev.orderable || prev.draggingId === overId) return prev;
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

  // Drop onto Pinned: from Pinned → persist the new order; from a date bucket → pin.
  const handleSectionDrop = useCallback(
    async (targetKey: string) => {
      const ds = dragState;
      setDragState(null);
      if (!ds || targetKey !== 'pinned') return;
      const id = ds.draggingId;

      if (ds.sectionKey === targetKey) {
        const updates = ds.orderedIds.map((session_id, i) => ({ session_id, sort_order: i }));
        const sortMap = new Map(updates.map((u) => [u.session_id, u.sort_order]));
        setSessions((prev) => prev.map((s) => (sortMap.has(s.id) ? { ...s, pin_sort: sortMap.get(s.id)! } : s)));
        try {
          await api.reorderPinnedSessions(updates);
        } catch {
          toast(t('sessionGroups.reorderFailed'), 'error');
          loadSessions();
        }
        return;
      }

      try {
        await api.pinSession(id);
        loadSessions();
      } catch {
        toast(t('common.saveFailed'), 'error');
      }
    },
    [dragState, t, loadSessions],
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
    return result;
  }, [sessions, searchQuery]);

  // ── Partition into sections: Pinned + date buckets (the unpinned rest). ──
  //
  // Pinning is how you organise YOUR conversations, so the Pinned section only
  // exists in the 'mine' scope. The shared and team views are a flat
  // date-bucketed list — otherwise a pinned foreign conversation would be
  // filtered out of the buckets and have no section left to appear in.
  const showOrganizedSections = effectiveScope === 'mine';

  const pinnedSessions = useMemo(
    () =>
      showOrganizedSections
        ? filteredSessions.filter((s) => s.pinned).sort((a, b) => (a.pin_sort ?? 0) - (b.pin_sort ?? 0))
        : [],
    [filteredSessions, showOrganizedSections],
  );

  // Date buckets exclude pinned (lifted up).
  const dateBucketSessions = useMemo(
    () => (showOrganizedSections ? filteredSessions.filter((s) => !s.pinned) : filteredSessions),
    [filteredSessions, showOrganizedSections],
  );
  const groupedSessions = useMemo(
    () => groupSessions(dateBucketSessions.slice(0, dateBucketLimit)),
    [dateBucketSessions, dateBucketLimit],
  );
  const hasMoreDateBuckets = dateBucketSessions.length > dateBucketLimit;

  // ── Multi-select derived state + handlers ──

  // Single source of truth for "visible render order": pinned → date buckets,
  // matching the DOM order below. Collapsed sections are excluded so a
  // Shift range never reaches a hidden row ("看不见却被选中").
  const visibleRows = useMemo(() => {
    const rows: SelectableRow[] = [];
    const push = (sectionKey: string, list: api.Session[]) => {
      for (const s of list) rows.push({ key: `${sectionKey}|${s.id}`, id: s.id });
    };
    if (!collapsedSections.has('pinned')) push('pinned', pinnedSessions);
    for (const group of groupedSessions) {
      if (!collapsedSections.has(`date:${group.group}`)) push(`date:${group.group}`, group.sessions);
    }
    return rows;
  }, [pinnedSessions, groupedSessions, collapsedSections]);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setLastClickedKey(null);
    setBatchConfirm(null);
  }, []);

  const enterSelectModeWith = useCallback((id: string, rowKey: string) => {
    setSelectMode(true);
    setSelectedIds(new Set([id]));
    setLastClickedKey(rowKey);
  }, []);

  // Row click while in select mode: plain = toggle, Shift = visible range,
  // Cmd/Ctrl = toggle single (anchor moves for a following Shift).
  const handleRowSelectClick = useCallback(
    (id: string, rowKey: string, e: React.MouseEvent) => {
      if (e.shiftKey && lastClickedKey) {
        setSelectedIds((prev) => rangeSelect(visibleRows, lastClickedKey, rowKey, prev));
      } else {
        setSelectedIds((prev) => toggleOne(prev, id));
        setLastClickedKey(rowKey);
      }
    },
    [lastClickedKey, visibleRows],
  );

  // Run an action over a list with bounded concurrency; returns the failure
  // count (each item's error is swallowed so the whole batch still resolves).
  const runBatch = useCallback(
    async <T,>(items: T[], fn: (item: T) => Promise<void>, concurrency = BATCH_CONCURRENCY) => {
      let failures = 0;
      await runWithConcurrency(items, concurrency, async (item) => {
        try {
          await fn(item);
        } catch {
          failures++;
        }
      });
      return failures;
    },
    [],
  );

  const handleBatchArchiveOrDelete = useCallback(
    async (action: 'archive' | 'delete') => {
      if (batchBusy) return;
      const ids = [...selectedIds];
      if (ids.length === 0) return;
      setBatchBusy(true);
      const status = action === 'archive' ? 'archived' : 'deleted';
      // Optimistic: pull them out of the active list immediately.
      const snapshot = sessions;
      setSessions((prev) => prev.filter((s) => !selectedIds.has(s.id)));
      const failures = await runBatch(ids, (id) => api.updateSession(id, { status }).then(() => undefined));
      setSelectedIds(new Set());
      setLastClickedKey(null);
      if (failures > 0) {
        // Roll back optimistic state to the truth, then report.
        setSessions(snapshot);
        await loadSessions();
        toast(t('sessionGroups.partialFailed', { n: failures }), 'error');
      } else {
        toast(action === 'archive' ? t('common.archived') : t('sessionGroups.batchMovedToTrash'), 'info');
      }
      bumpSessionListVersion();
      setBatchBusy(false);
    },
    [batchBusy, selectedIds, sessions, runBatch, loadSessions, bumpSessionListVersion, t],
  );

  // Escape exits select mode (unless the batch confirm dialog owns it first).
  useEffect(() => {
    if (!selectMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (batchConfirm) return;
      exitSelectMode();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [selectMode, batchConfirm, exitSelectMode]);

  if (collapsed) return null;

  // ── Row + section renderers (shared by Pinned and date buckets) ──
  const renderRow = (session: api.Session, sectionKey: string, orderable = false, orderedIds?: string[]) => {
    const isActive = session.id === currentSessionId;
    // Local streaming state OR the server-reported run set — the latter is what
    // keeps the dot alive across a page refresh (runs continue in the cloud).
    const isSessionStreaming =
      activeSessions.get(session.id)?.status === 'streaming' || remoteStreamingSessions.has(session.id);
    // The selected row is already being viewed, so never paint a stale unread
    // state while the SessionManager's read update is settling.
    const isUnread = !isActive && unreadSessions.has(session.id);
    const isRenaming = renamingId === session.id;
    const isTypewriting = typewriterIds.has(session.id);
    const isSelected = selectedIds.has(session.id);
    // Identity of this *rendered row*; Shift-ranges anchor on this, not on session.id.
    const rowKey = `${sectionKey}|${session.id}`;
    // Dragging and selecting are mutually exclusive gestures — disable drag in
    // select mode so the two don't stack.
    // All rows are draggable (onto Pinned to pin); only Pinned rows reorder
    // within their section.
    const draggable = !isRenaming && !selectMode;
    const isDragging = dragState?.draggingId === session.id;

    // Long-press (touch) enters select mode; the click that follows is then
    // suppressed so it doesn't immediately toggle the just-selected row off.
    const clearLongPress = () => {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
    };
    const handlePointerDown = (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch' || isRenaming || selectMode) return;
      longPressFired.current = false;
      clearLongPress();
      longPressTimer.current = setTimeout(() => {
        longPressFired.current = true;
        enterSelectModeWith(session.id, rowKey);
      }, LONG_PRESS_MS);
    };

    const handleRowClick = (e: React.MouseEvent) => {
      if (isRenaming) return;
      if (longPressFired.current) {
        // A long-press already handled this interaction.
        longPressFired.current = false;
        return;
      }
      if (selectMode) {
        handleRowSelectClick(session.id, rowKey, e);
      } else if (e.metaKey || e.ctrlKey) {
        // Cmd/Ctrl-click from normal mode: enter select mode + tick this row.
        enterSelectModeWith(session.id, rowKey);
      } else {
        onSelectSession(session.id);
      }
    };

    return (
      <div
        key={session.id}
        role="button"
        tabIndex={0}
        draggable={draggable}
        onDragStart={
          draggable ? (e) => handleRowDragStart(e, sectionKey, orderable, orderedIds ?? [], session.id) : undefined
        }
        onDragOver={draggable ? (e) => handleRowDragOver(e, sectionKey, session.id) : undefined}
        onDragEnd={draggable ? handleRowDragEnd : undefined}
        onPointerDown={handlePointerDown}
        onPointerUp={clearLongPress}
        onPointerLeave={clearLongPress}
        onPointerCancel={clearLongPress}
        onClick={handleRowClick}
        onContextMenu={(e) => handleContextMenu(e, session)}
        aria-current={isActive ? 'page' : undefined}
        className={`group/item w-full text-left px-3 py-2 flex items-center gap-2 transition-colors cursor-pointer ${
          isDragging ? 'opacity-50 ' : ''
        }${
          isActive
            ? 'sidebar-active-item'
            : // Rows are fill-only (see `.sidebar-active-item`). Batch-selected rows
              // use the lighter fill so they stay distinct from the row you are
              // actually viewing; the checkbox is what says "ticked", the tint only
              // has to make the ticked set scannable.
              isSelected
              ? 'bg-primary-subtle'
              : isUnread
                ? 'bg-info-subtle/50 hover:bg-info-subtle'
                : 'hover:bg-surface-muted'
        }`}
      >
        {selectMode && (
          <span className="flex-shrink-0 flex items-center justify-center pointer-events-none">
            <Checkbox checked={isSelected} readOnly tabIndex={-1} className="pointer-events-none" />
          </span>
        )}
        <span className="flex-shrink-0 w-2 flex items-center justify-center">
          {isSessionStreaming && (
            <span title={t('chat.streaming')}>
              <StatusDot color="primary" pulse />
            </span>
          )}
          {isUnread && !isSessionStreaming && (
            <span title={t('chat.newResponse')}>
              <StatusDot color="info" />
            </span>
          )}
          {/* Session type marker (mission cloud / workflow graph) — lowest
              priority in the shared indicator slot. */}
          {!isSessionStreaming && !isUnread && <SessionTypeIcon profileId={session.profile_id} />}
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
            className="flex-1 min-w-0 text-xs bg-surface-sunken border border-accent rounded px-1.5 py-0.5 focus:outline-none text-fg"
            autoFocus
          />
        ) : (
          <span
            className={`flex-1 min-w-0 text-xs truncate ${
              isActive ? 'text-primary-fg-strong font-semibold' : isUnread ? 'text-fg font-medium' : 'text-fg-secondary'
            }${isTypewriting ? ' animate-typewriter' : ''}`}
            title={session.title || t('common.untitled')}
          >
            {session.title || t('common.untitled')}
          </span>
        )}
        {sectionKey !== 'pinned' && session.pinned && (
          <Pin size={10} className="flex-shrink-0 text-fg-faint" aria-label={t('history.pinned')} />
        )}
        {/* In the shared tab every row is shared, so the marker says nothing. */}
        {session.shared && effectiveScope !== 'shared' && (
          <Share2 size={11} className="flex-shrink-0 text-fg-faint" aria-label={t('history.sharedWithMe')} />
        )}
        {/* Whose conversation this is — without it the team view is a wall of
            titles with no author. Present on any row the viewer doesn't own. */}
        {session.owner_nickname && (
          <span
            className="max-w-[72px] flex-shrink-0 truncate text-caption text-fg-faint"
            title={t('history.ownedBy', { name: session.owner_nickname })}
          >
            {session.owner_nickname}
          </span>
        )}
        <span className="sidebar-secondary-meta relative flex-shrink-0 flex items-center">
          <span className="text-caption text-fg-faint tabular-nums group-hover/item:invisible">
            {relativeTime(session.updated_at)}
          </span>
          <button
            onClick={(e) => handleMoreClick(e, session)}
            className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/item:opacity-100 touch-visible transition-opacity text-fg-faint hover:text-fg-secondary"
            title={t('common.moreActions')}
          >
            <MoreHorizontal size={14} />
          </button>
        </span>
        <button
          onClick={(e) => handleMoreClick(e, session)}
          className="sidebar-compact-row-action h-6 w-6 flex-shrink-0 items-center justify-center rounded text-fg-faint hover:bg-surface-muted hover:text-fg-secondary"
          title={t('chat.moreWithTime', { time: relativeTime(session.updated_at) })}
          aria-label={t('chat.moreActionsFor', { title: session.title || t('common.untitled') })}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    );
  };

  const renderSection = (opts: {
    key: string;
    title: string;
    count: number;
    sessions: api.Session[];
    orderable?: boolean;
    showPinIcon?: boolean;
  }) => {
    const { key, title, count, sessions: secSessions, orderable = false, showPinIcon } = opts;
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
      <div key={key} onDragOver={(e) => e.preventDefault()} onDrop={() => handleSectionDrop(key)}>
        <button
          onClick={() => toggleSection(key)}
          className={`w-full flex items-center gap-1.5 px-3 py-1 mt-1 first:mt-0 text-fg-faint hover:text-fg-secondary transition-colors ${
            isDropTarget ? 'bg-primary-subtle/40' : ''
          }`}
        >
          {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          {showPinIcon && <Pin size={11} />}
          <span className="text-caption font-semibold uppercase tracking-wider flex-1 text-left truncate">{title}</span>
          <span className="text-caption tabular-nums">{count}</span>
        </button>
        {!isCollapsed && display.map((s) => renderRow(s, key, orderable, orderedIds))}
        {!isCollapsed && display.length === 0 && isDropTarget && (
          <div className="mx-3 my-1 rounded border border-dashed border-edge px-3 py-2 text-center text-caption text-fg-faint">
            {t('sessionGroups.dropHere')}
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
          <SidebarToolbar
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t('common.search')}
            actions={[
              {
                label: t('sessionGroups.select'),
                icon: CheckSquare,
                onClick: () => (selectMode ? exitSelectMode() : setSelectMode(true)),
              },
              { label: t('history.viewAll'), icon: History, onClick: () => setShowFullHistory(true) },
            ]}
          />
        </div>

        {/* Scope tabs — mine (default) / shared with me / team (super only).
            `segment`, not pills: this is a switch where one option is always on. */}
        <div className="px-3 pb-1.5 flex-shrink-0">
          <FilterPills
            variant="segment"
            items={[
              { key: 'mine', label: t('history.scopeMine') },
              {
                key: 'shared',
                label: t('history.scopeShared'),
                count: unreadShareCount > 0 ? unreadShareCount : undefined,
              },
              ...(isSuper ? [{ key: 'team', label: t('history.scopeTeam') }] : []),
            ]}
            activeKey={effectiveScope}
            onChange={(k) => changeScope((k as SessionScope) ?? 'mine')}
            selectLabel={t('history.scopeFilterLabel')}
            fill
          />
        </div>

        {/* Session list — grouped by date. In select mode, a click on the empty
            padding (target === the scroll container itself) exits. */}
        <div
          className="flex-1 overflow-y-auto"
          onClick={(e) => {
            if (selectMode && e.target === e.currentTarget) exitSelectMode();
          }}
        >
          {loading && sessions.length === 0 && (
            <div className="flex justify-center py-6">
              <Spinner className="h-4 w-4 text-fg-faint" />
            </div>
          )}

          {!loading && filteredSessions.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-fg-faint">
              {searchQuery ? t('chat.noMatches') : t('chat.noConversationsFound')}
            </div>
          )}

          {/* Pinned — cross-cutting, lifted above date buckets */}
          {pinnedSessions.length > 0 &&
            renderSection({
              key: 'pinned',
              title: t('sessionGroups.pinned'),
              count: pinnedSessions.length,
              sessions: pinnedSessions,
              orderable: true,
              showPinIcon: true,
            })}

          {/* Date buckets — the unpinned rest. */}
          <div>
            {groupedSessions.map((group) => {
              const sectionKey = `date:${group.group}`;
              const isCollapsed = collapsedSections.has(sectionKey);
              return (
                <div key={group.group}>
                  <button
                    type="button"
                    onClick={() => toggleSection(sectionKey)}
                    aria-expanded={!isCollapsed}
                    className="mt-1 flex w-full items-center gap-1.5 px-3 py-1 text-fg-faint transition-colors first:mt-0 hover:text-fg-secondary"
                  >
                    {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                    <span className="flex-1 truncate text-left text-caption font-semibold uppercase tracking-wider">
                      {group.label}
                    </span>
                    <span className="text-caption tabular-nums">{group.sessions.length}</span>
                  </button>
                  {!isCollapsed && group.sessions.map((session) => renderRow(session, `date:${group.group}`))}
                </div>
              );
            })}
            {hasMoreDateBuckets && (
              <button
                onClick={() => setDateBucketLimit((n) => n + DATE_BUCKET_PAGE)}
                className="w-full px-3 py-2 text-caption text-fg-faint hover:text-fg-secondary hover:bg-surface-muted transition-colors"
              >
                {t('sessionGroups.showMore')}
              </button>
            )}
          </div>
        </div>

        {/* Batch action bar (multi-select mode) */}
        {selectMode && (
          <BatchActionBar
            count={selectedIds.size}
            busy={batchBusy}
            onArchive={() => setBatchConfirm('archive')}
            onDelete={() => setBatchConfirm('delete')}
            onDone={exitSelectMode}
            onSelectAll={() => setSelectedIds(new Set(visibleRows.map((r) => r.id)))}
            onClear={() => {
              setSelectedIds(new Set());
              setLastClickedKey(null);
            }}
          />
        )}
      </div>

      <FullHistoryModal
        open={showFullHistory}
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
              onTogglePin={handleTogglePin}
              onRegenerateTitle={handleRegenerateTitle}
              onArchive={handleArchive}
              onDelete={handleDelete}
            />
          );
        })()}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!pendingDeleteSession}
        onClose={() => setPendingDeleteSession(null)}
        onConfirm={confirmDelete}
        title={t('chat.trashSessionTitle')}
        description={t('chat.trashSessionDescription')}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />

      {/* Batch archive / delete confirmation */}
      <ConfirmDialog
        open={batchConfirm != null}
        onClose={() => setBatchConfirm(null)}
        onConfirm={() => {
          const action = batchConfirm;
          setBatchConfirm(null);
          if (action) handleBatchArchiveOrDelete(action);
        }}
        title={
          batchConfirm === 'delete'
            ? t('sessionGroups.batchDeleteTitle', { count: selectedIds.size })
            : t('sessionGroups.batchArchiveTitle', { count: selectedIds.size })
        }
        description={
          batchConfirm === 'delete' ? t('sessionGroups.batchDeleteConfirm') : t('sessionGroups.batchArchiveConfirm')
        }
        confirmLabel={batchConfirm === 'delete' ? t('common.delete') : t('common.archive')}
        confirmVariant="destructive"
      />
    </>
  );
}
