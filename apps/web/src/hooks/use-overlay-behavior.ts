import { useEffect, useRef } from 'react';

const overlayStack: symbol[] = [];
let bodyScrollLockCount = 0;
let previousBodyOverflow = '';

/**
 * Shared modal behavior for dialogs, drawers, and floating panels.
 *
 * Only the top-most overlay handles Escape. Body scrolling is reference-counted
 * so nested confirmation dialogs do not accidentally unlock the page beneath
 * their parent overlay.
 */
export function useOverlayBehavior(active: boolean, onClose: () => void) {
  const idRef = useRef(Symbol('overlay'));
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;

    const id = idRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayStack.push(id);

    if (bodyScrollLockCount === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    bodyScrollLockCount += 1;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || overlayStack[overlayStack.length - 1] !== id) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      const stackIndex = overlayStack.lastIndexOf(id);
      if (stackIndex >= 0) overlayStack.splice(stackIndex, 1);

      bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
      if (bodyScrollLockCount === 0) {
        document.body.style.overflow = previousBodyOverflow;
      }

      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [active]);
}
