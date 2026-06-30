/**
 * OverlayPanel — shared backdrop + panel shell for floating overlays.
 *
 * Variants:
 * - "side"   — fixed right panel (desktop: positioned, mobile: full-screen)
 * - "bottom" — bottom sheet (mobile-first, slides up)
 *
 * Replaces hand-rolled `fixed inset-0` + `bg-black/20` backdrop patterns
 * in agent-panel, sync-panel, profile-selector.
 */

import React from 'react';

interface OverlayPanelProps {
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
  /**
   * Play the exit animation instead of the entrance (side variant only). The
   * parent keeps this mounted while true, then unmounts on `onExited`.
   */
  closing?: boolean;
  /** Fired when the exit animation finishes — the parent should unmount now. */
  onExited?: () => void;
}

export function OverlayPanel({
  onClose,
  children,
  variant = 'side',
  className,
  style,
  zBackdrop = 40,
  zPanel = 50,
  panelRef,
  extraContent,
  closing = false,
  onExited,
}: OverlayPanelProps) {
  if (variant === 'bottom') {
    return (
      <div className="fixed inset-0 flex flex-col justify-end" style={{ zIndex: zPanel }}>
        <div className="absolute inset-0 bg-black/20 animate-backdrop-fade" onClick={onClose} />
        <div
          ref={panelRef}
          className={
            className ||
            'relative bg-surface-raised rounded-t-2xl shadow-xl max-h-[70vh] flex flex-col animate-slide-up'
          }
          style={style}
        >
          {children}
        </div>
      </div>
    );
  }

  // variant === 'side'
  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/20 ${closing ? 'animate-backdrop-fade-out' : 'animate-backdrop-fade'}`}
        style={{ zIndex: zBackdrop }}
        onClick={onClose}
      />
      {/* Panel — opens from the top-right anchor toward bottom-left (desktop) / slides up (mobile);
          close reverses it. While `closing`, the parent keeps us mounted until onAnimationEnd. */}
      <div
        ref={panelRef}
        className={`${
          className ||
          'fixed inset-0 md:inset-auto md:bottom-4 md:right-4 bg-surface-raised md:rounded-2xl shadow-2xl md:border md:border-edge flex flex-col overflow-hidden'
        } ${closing ? 'animate-panel-exit' : 'animate-panel-enter'}`}
        style={{ zIndex: zPanel, ...style }}
        onAnimationEnd={(e) => {
          // Only the panel's OWN exit animation finalizes the unmount — ignore
          // bubbled animationend from children (message bubbles, spinners, …).
          if (closing && e.target === e.currentTarget) onExited?.();
        }}
      >
        {extraContent}
        {children}
      </div>
    </>
  );
}
