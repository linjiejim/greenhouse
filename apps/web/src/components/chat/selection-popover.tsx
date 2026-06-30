/**
 * SelectionPopover — a tiny floating icon button that appears near the
 * text selection inside an assistant message.
 *
 * The selected text and rect are passed as props and captured on mount
 * (into refs), so they survive even if the parent re-renders due to
 * the selection clearing.
 */

import React, { useEffect, useState, useRef } from 'react';
import { MessageSquareQuote } from '../../lib/icons';

interface SelectionPopoverProps {
  /** Viewport-relative bounding rect of the selection */
  rect: DOMRect;
  /** Selected text */
  text: string;
  /** Callback when the user clicks to start annotating */
  onActivate: (text: string, rect: DOMRect) => void;
}

export function SelectionPopover({ rect, text, onActivate }: SelectionPopoverProps) {
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Capture initial values on mount so they survive re-renders
  const capturedTextRef = useRef(text);
  const capturedRectRef = useRef(rect);

  useEffect(() => {
    const top = rect.top - 32;
    const left = rect.right + 6;
    const clampedLeft = Math.min(left, window.innerWidth - 40);
    const clampedTop = Math.max(top, 4);
    setPos({ top: clampedTop, left: clampedLeft });
  }, [rect]);

  return (
    <button
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onActivate(capturedTextRef.current, capturedRectRef.current);
      }}
      className="fixed z-30 w-7 h-7 flex items-center justify-center rounded-lg
        bg-surface-raised border border-edge shadow-md
        text-fg-faint hover:text-primary-fg hover:border-primary-300 hover:bg-primary-subtle
        transition-all duration-150 animate-fade-in"
      style={{ top: pos.top, left: pos.left }}
      title="Quote & add note"
    >
      <MessageSquareQuote size={14} />
    </button>
  );
}
