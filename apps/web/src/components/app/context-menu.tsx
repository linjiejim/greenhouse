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
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

// ─── Component ───────────────────────────────────────────

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState(position);

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
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
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
  }, [onClose]);

  if (items.length === 0) return null;

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[160px] py-1 bg-surface-raised border border-edge rounded-lg shadow-lg animate-fade-in"
      style={{ left: adjustedPos.x, top: adjustedPos.y }}
    >
      {items.map((item, i) => {
        const Icon = item.icon;
        return (
          <button
            key={i}
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
