/**
 * PinnedSection — shows user-pinned navigation shortcuts in the sidebar.
 *
 * Features:
 * - 4-column icon grid layout (icon + title, vertical)
 * - Hover tooltip shows full title
 * - Drag to reorder (shared pointer sensor — see hooks/use-list-reorder.ts;
 *   these tiles are `<button>`s, which HTML5 DnD refuses to start a drag from)
 * - Right-click to unpin
 * - Highlights active module
 * - Collapsed sidebar mode: icon-only with tooltips
 * - Mobile mode: simplified list (no drag)
 */

import React, { useState } from 'react';
import { Pin, ChevronDown, MoreHorizontal } from '../../../lib/icons';
import { getNavModule, localizeNavModule } from '../../../lib/nav-registry';
import { useT } from '../../../lib/i18n';
import { canUseFeature } from '../../../lib/features';
import { useAuthStore, usePinStore } from '../../../stores';
import { ContextMenu, useContextMenu } from '../context-menu';
import { useListReorder } from '../../../hooks/use-list-reorder';
import type { AuthenticatedUser } from '@greenhouse/types/api';

// 4-col grid: show up to 8 items (2 rows) before collapsing
const GRID_VISIBLE_LIMIT = 8;
const COLLAPSED_VISIBLE_LIMIT = 5;

function canViewPinnedModule(moduleId: string, user: AuthenticatedUser | null | undefined): boolean {
  const mod = getNavModule(moduleId);
  if (!mod) return false;
  const roleAllowed = !mod.requireRole || (mod.requireRole.includes('super') && user?.role === 'super');
  const featureAllowed = !mod.requireFeature || canUseFeature(user, mod.requireFeature);
  return roleAllowed && featureAllowed;
}

// ─── Grid pin item renderer ─────────────────────────────

interface PinItemProps {
  moduleId: string;
  isActive: boolean;
  onNavigate: (path: string) => void;
  /** Right-click handler for context menu */
  onContextMenu?: (e: React.MouseEvent, id: string) => void;
  /** From `useListReorder().itemProps(id)` — makes the tile a drag source and drop target. */
  dragProps?: Record<string, unknown>;
  isDragging?: boolean;
}

function PinItem({ moduleId, isActive, onNavigate, onContextMenu, dragProps, isDragging }: PinItemProps) {
  const t = useT();
  const source = getNavModule(moduleId);
  if (!source) return null;
  const mod = localizeNavModule(source, t);

  const Icon = mod.icon;

  return (
    <button
      {...dragProps}
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
  const t = useT();
  const { pinnedIds, unpinItem, reorderPins } = usePinStore();
  const currentUser = useAuthStore((s) => s.currentUser);
  const { menu, openMenu, closeMenu } = useContextMenu();
  const [expanded, setExpanded] = useState(false);
  const visiblePinnedIds = pinnedIds.filter((id) => canViewPinnedModule(id, currentUser));

  // Reorder writes back the FULL pin list: what is filtered out here (modules the
  // user cannot see) still belongs to them and must keep its place.
  const reorder = useListReorder(visiblePinnedIds, (next) => {
    const reordered = next[Symbol.iterator]();
    reorderPins(pinnedIds.map((id) => (visiblePinnedIds.includes(id) ? reordered.next().value! : id)));
  });

  if (visiblePinnedIds.length === 0) return null;

  const visiblePins = expanded ? reorder.order : reorder.order.slice(0, GRID_VISIBLE_LIMIT);
  const hiddenCount = visiblePinnedIds.length - GRID_VISIBLE_LIMIT;

  const handleNavigate = (path: string) => {
    // The click that ends a drag must not also navigate.
    if (reorder.didDrag()) return;
    window.location.hash = path.replace(/^#/, '');
  };

  const handleContextMenu = (e: React.MouseEvent, id: string) => {
    openMenu(e, [{ label: t('sessionGroups.unpin'), icon: Pin, onClick: () => unpinItem(id), danger: true }]);
  };

  return (
    <div className="px-2 pb-1 flex-shrink-0">
      {/* Section header */}
      <div className="flex items-center gap-1.5 px-1 py-1.5">
        <Pin size={11} className="text-fg-faint" />
        <span className="text-[10px] font-semibold text-fg-faint uppercase tracking-wider flex-1">
          {t('sessionGroups.pinned')}
        </span>
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
            dragProps={reorder.itemProps(id)}
            isDragging={reorder.draggingId === id}
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
          <span>{expanded ? t('navigation.showLess') : t('navigation.moreCount', { count: hiddenCount })}</span>
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
  const t = useT();
  const { pinnedIds } = usePinStore();
  const currentUser = useAuthStore((s) => s.currentUser);
  const [showOverflow, setShowOverflow] = useState(false);
  const visiblePinnedIds = pinnedIds.filter((id) => canViewPinnedModule(id, currentUser));

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
        const source = getNavModule(id);
        if (!source) return null;
        const mod = localizeNavModule(source, t);
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
          title={t('navigation.morePinnedCount', { count: visiblePinnedIds.length - COLLAPSED_VISIBLE_LIMIT })}
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
  const t = useT();
  const { pinnedIds } = usePinStore();
  const currentUser = useAuthStore((s) => s.currentUser);
  const visiblePinnedIds = pinnedIds.filter((id) => canViewPinnedModule(id, currentUser));

  if (visiblePinnedIds.length === 0) return null;

  const handleNavigate = (path: string) => {
    window.location.hash = path.replace(/^#/, '');
    onNavigate?.();
  };

  return (
    <div className="px-2 py-1">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <Pin size={11} className="text-fg-faint" />
        <span className="text-[10px] font-semibold text-fg-faint uppercase tracking-wider">
          {t('sessionGroups.pinned')}
        </span>
      </div>
      <div className="space-y-0.5">
        {visiblePinnedIds.map((id) => {
          const source = getNavModule(id);
          if (!source) return null;
          const mod = localizeNavModule(source, t);
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
