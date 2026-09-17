/**
 * OverlayPanel — shared backdrop + panel shell for floating overlays.
 *
 * Variants:
 * - "side"   — fixed right panel (desktop: positioned, mobile: full-screen)
 * - "bottom" — bottom sheet (mobile-first, slides up)
 *
 * Replaces hand-rolled `fixed inset-0` + `bg-black/20` backdrop patterns
 * in agent-panel, sync-panel, agent-avatar-picker.
 */

import React from 'react';
import { useOverlayBehavior } from '../../hooks/use-overlay-behavior';

interface OverlayPanelProps {
  /** Whether modal behavior (Escape + body scroll lock) is active. Default true. */
  active?: boolean;
  /** Close callback (backdrop click + optional close button) */
  onClose: () => void;
  children: React.ReactNode;
  /** "side" = right-docked panel, "bottom" = bottom sheet */
  variant?: 'side' | 'bottom';
  /** CSS class on the panel container (overrides default sizing) */
  className?: string;
  /** Inline style on the panel container (for dynamic width/height) */
  style?: React.CSSProperties;
  /** z-index for backdrop (default: 40) */
  zBackdrop?: number;
  /** z-index for panel (default: 50) */
  zPanel?: number;
  /** Ref forwarded to the panel div */
  panelRef?: React.Ref<HTMLDivElement>;
  /** Extra content rendered inside the portal but outside the panel (e.g. resize handles) */
  extraContent?: React.ReactNode;
  /** Accessible name for the dialog surface */
  ariaLabel?: string;
  /** Optional motion classes for the backdrop (e.g. presence-driven opacity). */
  backdropClassName?: string;
  /**
   * Optional presence animation for a top-right anchored side panel.
   * The parent must keep the panel mounted through the exit phase.
   */
  motionState?: 'enter' | 'exit';
  /** Fired after the panel's own exit animation completes. */
  onExited?: () => void;
}

export function OverlayPanel({
  active = true,
  onClose,
  children,
  variant = 'side',
  className,
  style,
  zBackdrop = 40,
  zPanel = 50,
  panelRef,
  extraContent,
  ariaLabel = 'Panel',
  backdropClassName = '',
  motionState,
  onExited,
}: OverlayPanelProps) {
  useOverlayBehavior(active, onClose);
  // `inert` is supported by target browsers, but the current React DOM types
  // in this repo do not declare it yet. A spread preserves the boolean runtime
  // value without widening the project's global JSX types.
  const inactiveAttributes = active ? {} : ({ inert: true } as const);

  if (variant === 'bottom') {
    return (
      <div className="mobile-visual-viewport fixed inset-0 flex flex-col justify-end" style={{ zIndex: zPanel }}>
        <div className={`absolute inset-0 bg-black/20 ${backdropClassName}`} onClick={onClose} />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal={active || undefined}
          aria-hidden={!active}
          {...inactiveAttributes}
          aria-label={ariaLabel}
          className={`safe-area-panel ${
            className ||
            'relative bg-surface-raised rounded-t-2xl shadow-xl max-h-[min(70dvh,42rem)] flex flex-col animate-slide-up'
          }`}
          style={style}
        >
          {children}
        </div>
      </div>
    );
  }

  // variant === 'side'
  const backdropMotionClass =
    motionState === 'enter'
      ? 'animate-backdrop-fade'
      : motionState === 'exit'
        ? 'animate-backdrop-fade-out pointer-events-none'
        : '';
  const panelMotionClass =
    motionState === 'enter'
      ? 'animate-panel-enter'
      : motionState === 'exit'
        ? 'animate-panel-exit pointer-events-none'
        : '';

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/20 ${backdropMotionClass} ${backdropClassName}`}
        style={{ zIndex: zBackdrop }}
        onClick={onClose}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={active || undefined}
        aria-hidden={!active}
        {...inactiveAttributes}
        aria-label={ariaLabel}
        className={`safe-area-panel mobile-visual-viewport ${
          className ||
          'fixed inset-0 md:inset-auto md:bottom-4 md:right-4 bg-surface-raised md:rounded-2xl shadow-2xl md:border md:border-edge flex flex-col overflow-hidden'
        } ${panelMotionClass}`}
        style={{ zIndex: zPanel, ...style }}
        onAnimationEnd={(event) => {
          if (motionState === 'exit' && event.target === event.currentTarget) onExited?.();
        }}
      >
        {extraContent}
        {children}
      </div>
    </>
  );
}
