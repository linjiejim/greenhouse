/**
 * Keep the mobile application shell stable while the software keyboard owns the
 * visual viewport. The shell keeps its pre-keyboard height; only the composer
 * consumes the obscured bottom inset.
 */

import { useEffect } from 'react';

const MOBILE_BREAKPOINT = 768;
const KEYBOARD_HEIGHT_THRESHOLD = 80;

export function resolveMobileKeyboardViewport({
  stableHeight,
  layoutHeight,
  visualHeight,
  visualOffsetTop,
  editableFocused,
  keyboardWasOpen,
  widthChanged,
}: {
  stableHeight: number;
  layoutHeight: number;
  visualHeight: number;
  visualOffsetTop: number;
  editableFocused: boolean;
  keyboardWasOpen: boolean;
  widthChanged: boolean;
}): { stableHeight: number; keyboardInset: number; viewportOffsetTop: number; keyboardOpen: boolean } {
  let nextStableHeight = stableHeight;

  // Ordinary resizes (rotation, split view, browser chrome) establish a new
  // baseline. Once an editable control owns focus, a shorter visual viewport is
  // treated as keyboard occlusion instead of a reason to resize the whole app.
  if (widthChanged || (!editableFocused && !keyboardWasOpen)) {
    nextStableHeight = Math.max(layoutHeight, visualHeight);
  }

  let hiddenBottom = Math.max(0, nextStableHeight - visualHeight);
  const keyboardOpen = (editableFocused || keyboardWasOpen) && hiddenBottom >= KEYBOARD_HEIGHT_THRESHOLD;

  // Blur happens before the closing keyboard has restored the viewport. Keep
  // the old baseline until that restoration arrives, then resume normal sizing.
  if (!keyboardOpen && !editableFocused) {
    nextStableHeight = Math.max(layoutHeight, visualHeight);
    hiddenBottom = 0;
  }

  return {
    stableHeight: nextStableHeight,
    keyboardInset: keyboardOpen ? hiddenBottom : 0,
    viewportOffsetTop: keyboardOpen ? Math.max(0, visualOffsetTop) : 0,
    keyboardOpen,
  };
}

function hasEditableFocus(): boolean {
  const element = document.activeElement;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'color', 'file', 'hidden', 'radio', 'range', 'reset', 'submit'].includes(
      element.type,
    );
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

export function useMobileKeyboardViewport(): void {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let lastWidth = window.innerWidth;
    let stableHeight = Math.max(window.innerHeight, viewport?.height ?? 0);
    let keyboardOpen = false;

    const clear = () => {
      root.style.removeProperty('--app-viewport-height');
      root.style.removeProperty('--mobile-keyboard-inset');
      root.style.removeProperty('--mobile-viewport-offset-top');
      delete root.dataset.mobileKeyboardOpen;
    };

    const sync = () => {
      if (window.innerWidth >= MOBILE_BREAKPOINT) {
        lastWidth = window.innerWidth;
        stableHeight = Math.max(window.innerHeight, viewport?.height ?? 0);
        keyboardOpen = false;
        clear();
        return;
      }

      const widthChanged = Math.abs(window.innerWidth - lastWidth) > 1;
      const metrics = resolveMobileKeyboardViewport({
        stableHeight,
        layoutHeight: window.innerHeight,
        visualHeight: viewport?.height ?? window.innerHeight,
        visualOffsetTop: viewport?.offsetTop ?? 0,
        editableFocused: hasEditableFocus(),
        keyboardWasOpen: keyboardOpen,
        widthChanged,
      });

      lastWidth = window.innerWidth;
      stableHeight = metrics.stableHeight;
      keyboardOpen = metrics.keyboardOpen;
      root.style.setProperty('--app-viewport-height', `${metrics.stableHeight}px`);
      root.style.setProperty('--mobile-keyboard-inset', `${metrics.keyboardInset}px`);
      root.style.setProperty('--mobile-viewport-offset-top', `${metrics.viewportOffsetTop}px`);
      if (metrics.keyboardOpen) root.dataset.mobileKeyboardOpen = 'true';
      else delete root.dataset.mobileKeyboardOpen;
    };

    sync();
    window.addEventListener('resize', sync);
    viewport?.addEventListener('resize', sync);
    viewport?.addEventListener('scroll', sync);
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', sync);

    return () => {
      window.removeEventListener('resize', sync);
      viewport?.removeEventListener('resize', sync);
      viewport?.removeEventListener('scroll', sync);
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', sync);
      clear();
    };
  }, []);
}
