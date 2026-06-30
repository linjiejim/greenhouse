/**
 * PinnedSection — shows user-pinned navigation shortcuts in the sidebar.
 *
 * Features:
 * - 4-column icon grid layout (icon + title, vertical)
 * - Hover tooltip shows full title
 * - Drag-and-drop reordering (HTML5 DnD API)
 * - Right-click to unpin
 * - Highlights active module
 * - Collapsed sidebar mode: icon-only with tooltips
 * - Mobile mode: simplified list (no drag)
 */

import React, { useState, useRef, useCallback } from 'react';
import { Pin, ChevronDown, MoreHorizontal } from '../../../lib/icons';
import { getNavModule } from '../../../lib/nav-registry';
import { useAuthStore, usePinStore } from '../../../stores';
import { ContextMenu, useContextMenu } from '../context-menu';

// 4-col grid: show up to 8 items (2 rows) before collapsing
const GRID_VISIBLE_LIMIT = 8;
const COLLAPSED_VISIBLE_LIMIT = 5;

function canViewPinnedModule(moduleId: string, isSuper: boolean): boolean {
  const mod = getNavModule(moduleId);
  return !!mod && (!mod.requireRole || (mod.requireRole.includes('super') && isSuper));
}

// ─── Grid pin item renderer ─────────────────────────────

interface PinItemProps {
  moduleId: string;
  isActive: boolean;
  onNavigate: (path: string) => void;
  /** Right-click handler for context menu */
  onContextMenu?: (e: React.MouseEvent, id: string) => void;
  /** Drag handlers */
  dragHandlers?: {
    onDragStart: (e: React.DragEvent, id: string) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent, targetId: string) => void;
    onDragEnd: () => void;
    draggingId: string | null;
  };
}

function PinItem({ moduleId, isActive, onNavigate, onContextMenu, dragHandlers }: PinItemProps) {
  const mod = getNavModule(moduleId);
  if (!mod) return null;

  const Icon = mod.icon;
  const isDragging = dragHandlers?.draggingId === moduleId;

  return (
    <button
      draggable={!!dragHandlers}
      onDragStart={dragHandlers ? (e) => dragHandlers.onDragStart(e, moduleId) : undefined}
      onDragOver={dragHandlers ? (e) => dragHandlers.onDragOver(e) : undefined}
      onDrop={dragHandlers ? (e) => dragHandlers.onDrop(e, moduleId) : undefined}
      onDragEnd={dragHandlers ? () => dragHandlers.onDragEnd() : undefined}
      onClick={() => onNavigate(mod.path)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, moduleId) : undefined}
      className={`group relative flex flex-col items-center justify-center gap-1 p-1.5 rounded-lg text-center transition-colors ${
        isDragging ? 'opacity-40' : ''
      } ${
        isActive ? 'bg-primary-subtle text-primary-fg-strong' : 'text-fg-secondary hover:text-fg hover:bg-surface-muted'
      }`}
      title={mod.label}
    >
      <Icon size={18} className={`flex-shrink-0 ${isActive ? 'text-primary-fg' : 'text-fg-faint'}`} />
      <span className="text-[10px] leading-tight truncate w-full">{mod.label}</span>
    </button>
  );
}

// ─── Desktop Expanded Pinned Section (4-col grid) ────────

interface PinnedSectionProps {
  /** Current hash to determine active state */
  currentHash: string;
}

export function PinnedSection({ currentHash }: PinnedSectionProps) {
  const { pinnedIds, unpinItem, reorderPins } = usePinStore();
  const isSuper = useAuthStore((s) => s.currentUser?.role === 'super');
  const { menu, openMenu, closeMenu } = useContextMenu();
  const [expanded, setExpanded] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragOverId = useRef<string | null>(null);
  const visiblePinnedIds = pinnedIds.filter((id) => canViewPinnedModule(id, isSuper));

  // ── Drag & Drop (hooks must be before any early return) ──
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      const sourceId = e.dataTransfer.getData('text/plain');
      if (!sourceId || sourceId === targetId) return;

      const newOrder = [...pinnedIds];
      const sourceIdx = newOrder.indexOf(sourceId);
      const targetIdx = newOrder.indexOf(targetId);
      if (sourceIdx === -1 || targetIdx === -1) return;

      newOrder.splice(sourceIdx, 1);
      newOrder.splice(targetIdx, 0, sourceId);
      reorderPins(newOrder);
    },
    [pinnedIds, reorderPins],
  );

  const handleDragEnd = useCallback(() => {
    setDraggingId(null);
    dragOverId.current = null;
  }, []);

  if (visiblePinnedIds.length === 0) return null;

  const visiblePins = expanded ? visiblePinnedIds : visiblePinnedIds.slice(0, GRID_VISIBLE_LIMIT);
  const hiddenCount = visiblePinnedIds.length - GRID_VISIBLE_LIMIT;

  const handleNavigate = (path: string) => {
    window.location.hash = path.replace(/^#/, '');
  };

  const handleContextMenu = (e: React.MouseEvent, id: string) => {
    openMenu(e, [{ label: 'Unpin', icon: Pin, onClick: () => unpinItem(id), danger: true }]);
  };

  const dragHandlers = {
    onDragStart: handleDragStart,
    onDragOver: handleDragOver,
    onDrop: handleDrop,
    onDragEnd: handleDragEnd,
    draggingId,
  };

  return (
    <div className="px-2 pb-1 flex-shrink-0">
      {/* Section header */}
      <div className="flex items-center gap-1.5 px-1 py-1.5">
        <Pin size={11} className="text-fg-faint" />
        <span className="text-[10px] font-semibold text-fg-faint uppercase tracking-wider flex-1">Pinned</span>
        <span className="text-[10px] text-fg-faint">{visiblePinnedIds.length}</span>
      </div>

      {/* Pinned items — 4-col icon grid */}
      <div className="grid grid-cols-4 gap-0.5">
        {visiblePins.map((id) => (
          <PinItem
            key={id}
            moduleId={id}
            isActive={currentHash === getNavModule(id)?.path}
            onNavigate={handleNavigate}
            onContextMenu={handleContextMenu}
            dragHandlers={dragHandlers}
          />
        ))}
      </div>

      {/* Expand/collapse for >8 items */}
      {hiddenCount > 0 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-center gap-1 py-1 text-[10px] text-fg-faint hover:text-fg-secondary transition-colors"
        >
          <ChevronDown size={10} className={`transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`} />
          <span>{expanded ? 'Show less' : `${hiddenCount} more`}</span>
        </button>
      )}

      {/* Separator after pinned section */}
      <div className="mx-1 mt-1.5 border-t border-edge" />

      {/* Context menu portal */}
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
    </div>
  );
}

// ─── Collapsed Sidebar Pinned Icons ──────────────────────

export function PinnedSectionCollapsed({ currentHash }: PinnedSectionProps) {
  const { pinnedIds } = usePinStore();
  const isSuper = useAuthStore((s) => s.currentUser?.role === 'super');
  const [showOverflow, setShowOverflow] = useState(false);
  const visiblePinnedIds = pinnedIds.filter((id) => canViewPinnedModule(id, isSuper));

  if (visiblePinnedIds.length === 0) return null;

  const visiblePins = visiblePinnedIds.slice(0, COLLAPSED_VISIBLE_LIMIT);
  const hasOverflow = visiblePinnedIds.length > COLLAPSED_VISIBLE_LIMIT;

  const handleNavigate = (path: string) => {
    window.location.hash = path.replace(/^#/, '');
  };

  return (
    <div className="flex flex-col items-center gap-1 px-1.5 py-1">
      {/* Small separator */}
      <div className="w-5 border-t border-edge mb-0.5" />

      {visiblePins.map((id) => {
        const mod = getNavModule(id);
        if (!mod) return null;
        const Icon = mod.icon;
        const isActive = currentHash === mod.path;

        return (
          <button
            key={id}
            onClick={() => handleNavigate(mod.path)}
            className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
              isActive
                ? 'bg-primary-subtle text-primary-fg-strong'
                : 'text-fg-muted hover:text-fg-secondary hover:bg-surface-muted'
            }`}
            title={mod.label}
          >
            <Icon size={14} />
          </button>
        );
      })}

      {hasOverflow && (
        <button
          onClick={() => setShowOverflow(!showOverflow)}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-fg-faint hover:text-fg-secondary hover:bg-surface-muted transition-colors"
          title={`${visiblePinnedIds.length - COLLAPSED_VISIBLE_LIMIT} more pinned items`}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
    </div>
  );
}

// ─── Mobile Pinned Section ───────────────────────────────

interface MobilePinnedProps {
  currentHash: string;
  onNavigate?: () => void;
}

export function MobilePinnedSection({ currentHash, onNavigate }: MobilePinnedProps) {
  const { pinnedIds } = usePinStore();
  const isSuper = useAuthStore((s) => s.currentUser?.role === 'super');
  const visiblePinnedIds = pinnedIds.filter((id) => canViewPinnedModule(id, isSuper));

  if (visiblePinnedIds.length === 0) return null;

  const handleNavigate = (path: string) => {
    window.location.hash = path.replace(/^#/, '');
    onNavigate?.();
  };

  return (
    <div className="px-2 py-1">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <Pin size={11} className="text-fg-faint" />
        <span className="text-[10px] font-semibold text-fg-faint uppercase tracking-wider">Pinned</span>
      </div>
      <div className="space-y-0.5">
        {visiblePinnedIds.map((id) => {
          const mod = getNavModule(id);
          if (!mod) return null;
          const Icon = mod.icon;
          const isActive = currentHash === mod.path;
          return (
            <button
              key={id}
              onClick={() => handleNavigate(mod.path)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-primary-subtle text-primary-fg-strong font-medium'
                  : 'text-fg-secondary hover:text-fg hover:bg-surface-sunken'
              }`}
            >
              <Icon size={16} />
              <span>{mod.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
