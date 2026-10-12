/**
 * ContextMenu — lightweight right-click context menu.
 *
 * Usage:
 *   const { menu, openMenu, closeMenu } = useContextMenu();
 *
 *   <button onContextMenu={(e) => openMenu(e, [
 *     { label: 'Pin', icon: Pin, onClick: () => pin(id) },
 *   ])}>
 *     ...
 *   </button>
 *   {menu && <ContextMenu {...menu} onClose={closeMenu} />}
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { LucideIcon } from '../../lib/icons';

// ─── Types ───────────────────────────────────────────────

export interface ContextMenuItem {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  danger?: boolean;
  testId?: string;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
  /** Button-anchored menus restore focus here; right-click menus use the previous focus. */
  returnFocusTo?: HTMLElement | null;
}

// ─── Component ───────────────────────────────────────────

export function ContextMenu({ items, position, onClose, returnFocusTo }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState(position);

  useEffect(() => {
    const menu = menuRef.current;
    const previous = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      // An action may have opened a dialog and moved focus there already.
      if (
        previous?.isConnected &&
        (document.activeElement === document.body || menu?.contains(document.activeElement))
      ) {
        previous.focus();
      }
    };
  }, [returnFocusTo]);

  // Adjust position to prevent overflow
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = position.x;
    let y = position.y;
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    setAdjustedPos({ x, y });
  }, [position]);

  // Close on outside click or Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) && !returnFocusTo?.contains(e.target as Node))
        onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Use capture phase + slight delay so the context menu event itself doesn't close it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
      document.addEventListener('keydown', handleKey);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose, returnFocusTo]);

  if (items.length === 0) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 min-w-[160px] py-1 bg-surface-raised border border-edge rounded-lg shadow-lg animate-fade-in"
      style={{ left: adjustedPos.x, top: adjustedPos.y }}
      onKeyDown={(event) => {
        const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'ArrowDown'
            ? (current + 1) % buttons.length
            : event.key === 'ArrowUp'
              ? (current - 1 + buttons.length) % buttons.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : null;
        if (next !== null) {
          event.preventDefault();
          event.stopPropagation();
          buttons[next]?.focus();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {items.map((item, i) => {
        const Icon = item.icon;
        return (
          <button
            key={i}
            role="menuitem"
            data-testid={item.testId}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
              item.danger
                ? 'text-danger hover:bg-danger-subtle'
                : 'text-fg-secondary hover:text-fg hover:bg-surface-muted'
            }`}
          >
            {Icon && <Icon size={13} className="flex-shrink-0" />}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Hook ────────────────────────────────────────────────

export function useContextMenu() {
  const [menu, setMenu] = useState<{ items: ContextMenuItem[]; position: { x: number; y: number } } | null>(null);

  const openMenu = useCallback((e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ items, position: { x: e.clientX, y: e.clientY } });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  return { menu, openMenu, closeMenu };
}
