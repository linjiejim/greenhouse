/**
 * Drawers, dialogs and sheets share one base (docs/design-system/components.md, 弹层; layout.md,
 * 抽屉、对话框与 Sheet): focus moves in and stays in, Escape or the scrim closes, focus returns to
 * the opener and the page behind does not scroll. A drawer is ~40% of the window (wide: 60%), a
 * dialog 440 (wide: 640); in the narrow layout (`data-narrow`) both open as a bottom sheet with a
 * drag handle. The header and the actions (OverlayActions) stay put; only the body scrolls.
 *
 * Overlays stack: only the top one answers Escape and Tab, so a confirmation can open over a
 * drawer. Inside a `[data-floating-boundary]` an overlay covers that frame, else the viewport.
 */

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { icon, motion } from '../tokens/haven';
import { Button, IconButton } from './controls';
import { cx, useKitStrings } from './provider';
import { HelpHint } from './tooltip';

/** Open overlays, last on top. */
const stack: object[] = [];
/** The page's own overflow, put back when the last overlay closes. */
let pageOverflow = '';
/** A sheet dragged down further than this closes (layout.md: 下拉约 90px 关闭). */
const DRAG_CLOSE = 90;
const EXIT_MS = parseInt(motion.durationExit, 10);
const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]';

/** Where OverlayActions render: the footer of the enclosing overlay (undefined outside one). */
const FooterSlot = createContext<HTMLElement | null | undefined>(undefined);

export interface OverlayProps {
  title: string;
  /** Explanation behind a "?" next to the title. */
  help?: ReactNode;
  children: ReactNode;
  /** Called once the overlay has finished leaving; the caller unmounts it. */
  onClose: () => void;
  /** Asked before any dismissal (Escape, scrim, close button, drag); return false to stay open. */
  beforeClose?: () => boolean;
  /** drawer: side panel for details and editing. dialog: centred, for short decisions. */
  variant?: 'drawer' | 'dialog';
  /** Drawer 60% (computer view, web previews) or dialog 640. */
  wide?: boolean;
  role?: 'dialog' | 'alertdialog';
  closeButton?: boolean;
}

export function Overlay({
  title,
  help,
  children,
  onClose,
  beforeClose,
  variant = 'drawer',
  wide = false,
  role = 'dialog',
  closeButton = true,
}: OverlayProps) {
  const t = useKitStrings();
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const anchor = useCallback((element: HTMLSpanElement | null) => {
    if (element) setMount(element.closest<HTMLElement>('[data-floating-boundary]') ?? document.body);
  }, []);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [leaving, setLeaving] = useState(false);
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<number | null>(null);
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  const latest = useRef({ onClose, beforeClose });
  latest.current = { onClose, beforeClose };
  const dismiss = () => {
    if (latest.current.beforeClose?.() === false) return;
    setLeaving(true);
  };
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    if (!leaving) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = setTimeout(
      () => {
        latest.current.onClose();
        setLeaving(false);
      },
      reduce ? 0 : EXIT_MS,
    );
    return () => clearTimeout(timer);
  }, [leaving]);

  useEffect(() => {
    if (!mount) return;
    const self = {};
    const root = document.documentElement;
    if (stack.length === 0) {
      pageOverflow = root.style.overflow;
      root.style.overflow = 'hidden';
    }
    stack.push(self);
    const opener = document.activeElement as HTMLElement | null;
    const element = panel.current;
    // After the first commit, so actions portaled into the footer are there to be focused.
    const timer = setTimeout(() => {
      if (element?.contains(document.activeElement)) return;
      const target = element?.querySelector<HTMLElement>('[data-autofocus]');
      (target ?? element)?.focus({ preventScroll: true });
    }, 0);
    const keydown = (event: KeyboardEvent) => {
      if (stack[stack.length - 1] !== self) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissRef.current();
      } else if (event.key === 'Tab') {
        const targets = Array.from(element?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
          (item) => item.tabIndex >= 0 && item.getClientRects().length > 0 && !item.closest('[inert]'),
        );
        const first = targets[0];
        const last = targets[targets.length - 1];
        const active = document.activeElement;
        if (!first) {
          event.preventDefault();
          element?.focus();
        } else if (!element?.contains(active)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && (active === first || active === element)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      stack.splice(stack.indexOf(self), 1);
      if (stack.length === 0) root.style.overflow = pageOverflow;
      clearTimeout(timer);
      document.removeEventListener('keydown', keydown);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [mount]);

  const endDrag = () => {
    dragStart.current = null;
    setDrag(0);
  };
  const content = (
    <div className={cx('gh-overlay', `gh-overlay-${variant}`, leaving && 'is-leaving')}>
      <button type="button" className="gh-scrim" aria-label={t.dismissOverlay} tabIndex={-1} onClick={dismiss} />
      <div
        ref={panel}
        tabIndex={-1}
        className={cx('gh-overlay-panel', wide && 'is-wide')}
        style={drag ? { transform: `translateY(${drag}px)`, animation: 'none', transition: 'none' } : undefined}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <button
          type="button"
          className="gh-sheet-handle"
          tabIndex={-1}
          aria-label={t.dragToClose}
          onClick={dismiss}
          onPointerDown={(event) => {
            dragStart.current = event.clientY;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (dragStart.current !== null) setDrag(Math.max(0, event.clientY - dragStart.current));
          }}
          onPointerUp={() => {
            if (drag > DRAG_CLOSE) dismiss();
            endDrag();
          }}
          onPointerCancel={endDrag}
        />
        <header className="gh-overlay-header">
          <h2 id={titleId} className="gh-overlay-title">
            {title}
          </h2>
          {help && <HelpHint label={title}>{help}</HelpHint>}
          <span className="gh-overlay-spacer" />
          {closeButton && (
            <IconButton label={variant === 'dialog' ? t.close : t.closeDetails} onClick={dismiss}>
              <X size={icon.md} strokeWidth={icon.stroke} />
            </IconButton>
          )}
        </header>
        <FooterSlot.Provider value={footer}>
          <div className="gh-overlay-body">{children}</div>
        </FooterSlot.Provider>
        <footer ref={setFooter} className="gh-overlay-footer" />
      </div>
    </div>
  );
  return (
    <>
      <span hidden ref={anchor} />
      {mount && createPortal(content, mount)}
    </>
  );
}

/**
 * The overlay's own actions (编辑, 取消 / 保存, 创建…): rendered in its fixed footer, right-aligned
 * with the primary action last. A submit button there names its form with `form="<id>"`.
 * Outside an overlay they render in place.
 */
export function OverlayActions({ children }: { children: ReactNode }) {
  const footer = useContext(FooterSlot);
  if (footer === undefined) return <div className="gh-overlay-actions">{children}</div>;
  return footer ? createPortal(children, footer) : null;
}

/**
 * A short decision. The title names the action (「删除 2 条记录？」), the body says what it affects
 * and whether it can be undone, and the confirm button repeats the action. `danger` makes the
 * confirm button solid red and puts the first focus on cancel.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useKitStrings();
  return (
    <Overlay variant="dialog" role="alertdialog" title={title} onClose={onCancel} closeButton={false}>
      {children && <div className="gh-confirm-body">{children}</div>}
      <OverlayActions>
        <Button data-autofocus={danger || undefined} onClick={onCancel}>
          {cancelLabel ?? t.cancel}
        </Button>
        <Button
          kind={danger ? 'danger' : 'primary'}
          className={danger ? 'gh-button-solid' : undefined}
          data-autofocus={danger ? undefined : true}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}
