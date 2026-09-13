/**
 * OverlayFrame — the single implementation of overlay containment.
 *
 * Callers ask for a variant and hand over their content; the frame owns the
 * parts that used to be copy-pasted (and contradicted each other) across the
 * dialog family:
 *
 * - safe-area consumption and the resulting height cap,
 * - Escape / body-scroll lock / focus restore (via `useOverlayBehavior`),
 * - backdrop rendering and the enter/exit animation,
 * - the `isClosing` state and the delayed `onClose`.
 *
 * **The one rule this file exists to enforce:** safe-area padding lives on the
 * outermost container and the surface caps itself with `max-h-full`. A
 * percentage max-height resolves against the container's *content box*, so the
 * insets are already deducted and the cap follows them for free. Writing a
 * constant (`max-h-[calc(100dvh-1rem)]`) instead misses `env()` — measured at
 * 62 + 34px on a notched phone — and since mobile aligns to `items-end`, the
 * ~80px of overflow is pushed off the *top*: title bar and close button gone,
 * dialog unclosable (fixed 2026-08-01).
 *
 * Variants land in batches. `center`/`alert` are here; `side` (Drawer) and
 * `sheet` (OverlayPanel bottom) follow once this batch has shipped a dev
 * version — see docs/specs/20260801-overlay-foundation-and-history-modal-split.md.
 */

import React from 'react';
import { useOverlayBehavior } from '../hooks/use-overlay-behavior';

export type OverlayVariant = 'center' | 'alert' | 'palette';

interface VariantSpec {
  role: 'dialog' | 'alertdialog';
  /** Outermost element: positioning + the safe-area padding the cap resolves against. */
  container: string;
  backdrop: string;
  /** Dialogs blur the page behind them; alerts only dim it (existing product decision). */
  animateBackdrop: boolean;
  surface: string;
}

const VARIANTS: Record<OverlayVariant, VariantSpec> = {
  center: {
    role: 'dialog',
    container:
      'fixed inset-0 flex items-end justify-center p-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:items-center sm:p-4',
    backdrop: 'absolute inset-0 bg-black/30 dark:bg-black/55 backdrop-blur-sm',
    animateBackdrop: true,
    surface:
      'relative flex w-full flex-col overflow-hidden rounded-xl border border-edge bg-surface-raised shadow-xl max-h-full',
  },
  alert: {
    role: 'alertdialog',
    container:
      'fixed inset-0 flex items-end justify-center p-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:items-center',
    backdrop: 'absolute inset-0 bg-black/20',
    animateBackdrop: false,
    surface: 'relative w-full overflow-y-auto rounded-xl border border-edge bg-surface-raised shadow-xl max-h-full',
  },
  // Search palette: `center` but anchored near the top. A palette's height is
  // driven by how many results came back, and a vertically centred one slides up
  // and down under the cursor while you type. Anchoring holds the input still.
  palette: {
    role: 'dialog',
    container:
      'fixed inset-0 flex items-end justify-center p-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:items-start sm:p-4 sm:pt-[10vh]',
    backdrop: 'absolute inset-0 bg-black/30 dark:bg-black/55 backdrop-blur-sm',
    animateBackdrop: true,
    surface:
      'relative flex w-full flex-col overflow-hidden rounded-xl border border-edge bg-surface-raised shadow-xl max-h-full',
  },
};

export interface OverlayFrameHandle {
  /** Dismiss the overlay, playing the exit animation when the variant has one. */
  close: () => void;
  isClosing: boolean;
}

interface OverlayFrameProps {
  open: boolean;
  onClose: () => void;
  variant: OverlayVariant;
  /** Accessible name for the surface. */
  ariaLabel: string;
  /** Sizing and layout classes for the surface (widths, fixed heights, padding). */
  surfaceClassName?: string;
  /** Stacking class for the container. Raise it only for overlays that must sit above dialogs. */
  zClassName?: string;
  /** Exit-animation duration before `onClose` fires. 0 closes immediately. */
  closeDelayMs?: number;
  children: React.ReactNode | ((frame: OverlayFrameHandle) => React.ReactNode);
}

export function OverlayFrame({
  open,
  onClose,
  variant,
  ariaLabel,
  surfaceClassName = '',
  zClassName = 'z-50',
  closeDelayMs = 0,
  children,
}: OverlayFrameProps) {
  const [isClosing, setIsClosing] = React.useState(false);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const closeDelayRef = React.useRef(closeDelayMs);
  closeDelayRef.current = closeDelayMs;
  const exitTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = React.useCallback(() => {
    if (closeDelayRef.current <= 0) {
      onCloseRef.current();
      return;
    }
    setIsClosing(true);
    exitTimer.current = setTimeout(() => {
      exitTimer.current = null;
      setIsClosing(false);
      onCloseRef.current();
    }, closeDelayRef.current);
  }, []);

  React.useEffect(
    () => () => {
      if (exitTimer.current) clearTimeout(exitTimer.current);
    },
    [],
  );

  useOverlayBehavior(open, close);

  if (!open) return null;

  const spec = VARIANTS[variant];
  const motion = isClosing ? 'animate-toast-out' : 'animate-fade-in';

  return (
    <div className={`${spec.container} mobile-visual-viewport ${zClassName}`}>
      <div className={`${spec.backdrop} ${spec.animateBackdrop ? motion : ''}`} onClick={close} />
      <div
        role={spec.role}
        aria-modal="true"
        aria-label={ariaLabel}
        className={`${spec.surface} ${surfaceClassName} ${motion}`}
      >
        {typeof children === 'function' ? children({ close, isClosing }) : children}
      </div>
    </div>
  );
}
