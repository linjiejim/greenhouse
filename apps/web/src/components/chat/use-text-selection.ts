/**
 * useTextSelection — detects text selection within a container element.
 *
 * Returns the selected text and bounding rect (relative to the container)
 * for positioning a floating action popover.
 */

import { useState, useCallback, useEffect, useRef } from 'react';

export interface TextSelectionState {
  /** The selected plain text */
  text: string;
  /** Bounding rect of the selection range, relative to viewport */
  rect: DOMRect | null;
}

const EMPTY: TextSelectionState = { text: '', rect: null };

/**
 * Track text selection inside a given container ref.
 * Returns selection state and a clear function.
 */
export function useTextSelection(containerRef: React.RefObject<HTMLElement | null>) {
  const [selection, setSelection] = useState<TextSelectionState>(EMPTY);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const update = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      setSelection(EMPTY);
      return;
    }

    const container = containerRef.current;
    if (!container) {
      setSelection(EMPTY);
      return;
    }

    const range = sel.getRangeAt(0);

    // Ensure the selection is within our container
    if (!container.contains(range.commonAncestorContainer)) {
      setSelection(EMPTY);
      return;
    }

    const text = sel.toString().trim();
    if (!text || text.length < 2) {
      setSelection(EMPTY);
      return;
    }

    const rect = range.getBoundingClientRect();
    setSelection({ text, rect });
  }, [containerRef]);

  useEffect(() => {
    const handleSelectionChange = () => {
      // Debounce to avoid rapid updates during drag-select
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(update, 80);
    };

    // mouseup also captures the final selection after a drag
    const handleMouseUp = () => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(update, 50);
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      clearTimeout(debounceRef.current);
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [update]);

  const clear = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelection(EMPTY);
  }, []);

  return { selection, clear };
}
