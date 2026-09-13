import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Interactive hover surfaces need enough time for a pointer to cross the visual
 * gap between their trigger and panel. Keep this shared: shorter local timers
 * recreate the exact "opens, then vanishes on the way over" race.
 */
export const HOVER_FLYOUT_CLOSE_DELAY_MS = 320;

interface UseHoverFlyoutOptions {
  defaultOpen?: boolean;
  closeDelayMs?: number;
}

interface HoverFlyoutState {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  openNow: () => void;
  closeNow: () => void;
  closeSoon: () => void;
  cancelClose: () => void;
}

/**
 * Shared open/close state for panels that can be opened by hover and then
 * interacted with. Callers still own placement, outside-click and Escape rules.
 *
 * Use mouse events, not pointer events, at the call site: touch surfaces should
 * open these panels by click and must not synthesize a hover-only state.
 */
export function useHoverFlyout({
  defaultOpen = false,
  closeDelayMs = HOVER_FLYOUT_CLOSE_DELAY_MS,
}: UseHoverFlyoutOptions = {}): HoverFlyoutState {
  const [open, setOpenState] = useState(defaultOpen);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const setOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
    (next) => {
      cancelClose();
      setOpenState(next);
    },
    [cancelClose],
  );

  const openNow = useCallback(() => setOpen(true), [setOpen]);
  const closeNow = useCallback(() => setOpen(false), [setOpen]);

  const closeSoon = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setOpenState(false);
    }, closeDelayMs);
  }, [cancelClose, closeDelayMs]);

  useEffect(() => cancelClose, [cancelClose]);

  return { open, setOpen, openNow, closeNow, closeSoon, cancelClose };
}
