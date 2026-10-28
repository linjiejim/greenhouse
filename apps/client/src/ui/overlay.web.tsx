/** All browser floating UI shares a portal, focus management, dismissal and theme. */
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../theme';
let nextLayer = 0;
const layers: number[] = [];
export const hasInteractiveOverlay = () => layers.length > 0;
/**
 * Centered dialogs come in fixed sizes so they never jump with their content: `sm` is for
 * confirm / prompt (fixed width, height follows the text); `md` and `lg` hold lists and forms
 * (fixed width and height, the body scrolls inside, see DialogBody); `xl` is the settings window.
 * The viewport clamps both.
 */
export const DIALOG_SIZES = {
  sm: { width: 420 },
  md: { width: 560, height: 600 },
  lg: { width: 760, height: 640 },
  /** The settings window: its own nav column plus a page. */
  xl: { width: 960, height: 680 },
} as const;
export type DialogSize = keyof typeof DIALOG_SIZES;
const TABBABLE = 'button:not(:disabled),input,textarea,select,a[href],[tabindex="0"]';
export const tabbablesIn = (root: HTMLElement | null) =>
  Array.from(root?.querySelectorAll<HTMLElement>(TABBABLE) ?? []).filter((node) => !node.closest('[inert]'));
/** Keeps Tab and Shift+Tab inside a modal surface; returns whether it handled the key. */
export function trapTabIn(root: HTMLElement | null, e: KeyboardEvent) {
  if (e.key !== 'Tab' || !root) return false;
  const nodes = tabbablesIn(root);
  const first = nodes[0];
  const last = nodes.at(-1);
  const inside = root.contains(document.activeElement);
  if (!first) {
    e.preventDefault();
    root.focus();
  } else if (!inside) {
    e.preventDefault();
    (e.shiftKey ? last : first)?.focus();
  } else if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
    e.preventDefault();
    last?.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
  return true;
}
/**
 * Names a dialog that was given no label after its first heading (the title its content draws),
 * watching until one renders. Returns the cleanup.
 */
export function labelByHeading(root: HTMLElement | null) {
  if (!root || root.hasAttribute('aria-label')) return () => {};
  const find = () => {
    const heading = root.querySelector<HTMLElement>('h1,h2,h3,[role="heading"],.gh-dialog-header > strong');
    if (!heading) return false;
    heading.id ||= `gh-dialog-title-${++nextTitle}`;
    root.setAttribute('aria-labelledby', heading.id);
    return true;
  };
  if (find()) return () => {};
  const watch = new MutationObserver(() => {
    if (find()) watch.disconnect();
  });
  watch.observe(root, { childList: true, subtree: true });
  return () => watch.disconnect();
}
let nextTitle = 0;
export function Overlay({
  children,
  onClose,
  modal = true,
  label,
  point,
  role = 'dialog',
  panelStyle,
  testID,
  trapTab = true,
  initialFocus = 'first',
  size,
}: {
  children: React.ReactNode;
  onClose: () => void;
  modal?: boolean;
  label?: string;
  point?: { x: number; y: number };
  role?: 'dialog' | 'menu' | 'status' | 'tooltip';
  panelStyle?: React.CSSProperties;
  testID?: string;
  trapTab?: boolean;
  /** 'panel' focuses the dialog itself, for large surfaces (settings) where the first control is not a choice. */
  initialFocus?: 'first' | 'panel';
  /** A centered dialog's fixed size (ignored for anchored popovers, which size to content). */
  size?: DialogSize;
}) {
  const { hex: c, isDark } = useTheme();
  const pointX = point?.x,
    pointY = point?.y;
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
    const tabbables = () => tabbablesIn(root);
    const unlabel = role === 'dialog' ? labelByHeading(root) : () => {};
    (initialFocus === 'panel' ? root : (tabbables()[0] ?? root))?.focus();
    const key = (e: KeyboardEvent) => {
      if (layers.at(-1) !== layer) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
      }
      if (trapTab) trapTabIn(root, e);
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
    if (root && pointX !== undefined && pointY !== undefined && box) {
      root.style.left = `${Math.max(8, Math.min(pointX, innerWidth - box.width - 8))}px`;
      root.style.top = `${Math.max(8, Math.min(pointY, innerHeight - box.height - 8))}px`;
    }
    return () => {
      unlabel();
      layers.splice(layers.indexOf(layer), 1);
      document.removeEventListener('keydown', key, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [interactive, role, pointX, pointY, trapTab, initialFocus]);
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
        data-testid={testID}
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
          // the panel only holds focus for the dialog; its controls draw the visible ring
          outline: 'none',
          ...(size && !point ? sizeStyle(size) : null),
          ...panelStyle,
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function sizeStyle(size: DialogSize): React.CSSProperties {
  const box: { width: number; height?: number } = DIALOG_SIZES[size];
  return box.height
    ? { width: box.width, height: box.height, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }
    : { width: box.width };
}

/** The fixed-size dialog's layout: a header row, a scrolling body, an optional footer. */
export function DialogBody({
  title,
  actions,
  footer,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="gh-dialog-header">
        <strong>{title}</strong>
        {actions}
      </div>
      <div className="gh-dialog-body">{children}</div>
      {footer ? <div className="gh-dialog-footer">{footer}</div> : null}
    </>
  );
}
