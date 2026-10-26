/** All browser floating UI shares a portal, focus management, dismissal and theme. */
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../theme';
let nextLayer = 0;
const layers: number[] = [];
export function Overlay({
  children,
  onClose,
  modal = true,
  label,
  point,
  role = 'dialog',
}: {
  children: React.ReactNode;
  onClose: () => void;
  modal?: boolean;
  label?: string;
  point?: { x: number; y: number };
  role?: 'dialog' | 'menu' | 'status' | 'tooltip';
}) {
  const { hex: c, isDark } = useTheme();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const interactive = role !== 'status' && role !== 'tooltip';
  useEffect(() => {
    if (!interactive) return;
    const layer = ++nextLayer;
    layers.push(layer);
    const previous = document.activeElement as HTMLElement | null;
    const root = panel.current;
    const tabbables = () =>
      Array.from(
        root?.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select,a[href],[tabindex="0"]') ?? [],
      );
    (tabbables()[0] ?? root)?.focus();
    const key = (e: KeyboardEvent) => {
      if (layers.at(-1) !== layer) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
      }
      if (e.key === 'Tab') {
        const nodes = tabbables();
        const first = nodes[0];
        const last = nodes.at(-1);
        if (!first) {
          e.preventDefault();
          root?.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
      if (role === 'menu' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        const nodes = tabbables();
        let i = nodes.indexOf(document.activeElement as HTMLElement);
        i =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? nodes.length - 1
              : (i + (e.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length;
        nodes[i]?.focus();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', key, true);
    const box = root?.getBoundingClientRect();
    if (root && point && box) {
      root.style.left = `${Math.max(8, Math.min(point.x, innerWidth - box.width - 8))}px`;
      root.style.top = `${Math.max(8, Math.min(point.y, innerHeight - box.height - 8))}px`;
    }
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      document.removeEventListener('keydown', key, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [interactive, role, point]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: point ? 'flex-start' : role === 'status' ? 'flex-start' : 'center',
        justifyContent: 'center',
        padding: role === 'status' ? 24 : 16,
        background: modal ? c.scrim : 'transparent',
        pointerEvents: interactive ? 'auto' : 'none',
        color: c.label,
        fontFamily: 'Nunito, sans-serif',
        colorScheme: isDark ? 'dark' : 'light',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close.current();
      }}
    >
      <div
        ref={panel}
        role={role}
        aria-modal={modal && interactive ? true : undefined}
        aria-label={label}
        tabIndex={interactive ? -1 : undefined}
        style={{
          position: point ? 'fixed' : 'relative',
          left: point?.x,
          top: point?.y,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 32px)',
          overflow: 'auto',
          minWidth: role === 'status' || role === 'tooltip' ? undefined : 220,
          background: c.secondaryGroupedBackground,
          border: `1px solid ${c.separator}`,
          borderRadius: 12,
          padding: role === 'menu' ? 4 : 20,
          boxShadow: isDark ? undefined : '0 8px 32px rgba(0,0,0,.14)',
          pointerEvents: interactive ? 'auto' : 'none',
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
