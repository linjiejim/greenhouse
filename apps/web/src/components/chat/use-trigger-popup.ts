/**
 * useTriggerPopup — shared hook for @mention and /slash-command trigger detection.
 *
 * Monitors a textarea for a trigger character, extracts the query text after it,
 * and calculates popover position relative to the cursor.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { RefObject } from 'react';

export interface TriggerState {
  /** Whether the trigger popup is currently active */
  isActive: boolean;
  /** The query text typed after the trigger character */
  query: string;
  /** Position for the popover (above the textarea) */
  position: { top: number; left: number };
  /** Index in the textarea value where trigger char was typed */
  triggerIndex: number;
}

const INITIAL_STATE: TriggerState = {
  isActive: false,
  query: '',
  position: { top: 0, left: 0 },
  triggerIndex: -1,
};

interface UseTriggerPopupOpts {
  /** The trigger character: '@' or '/' */
  triggerChar: string;
  /** Ref to the textarea element */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Current textarea value (controlled) */
  value: string;
  /** Whether trigger is enabled */
  enabled?: boolean;
  /**
   * For '/' trigger: only activate when the trigger is at the start of input
   * (no other text before it). Default false.
   */
  requireLineStart?: boolean;
}

export function useTriggerPopup({
  triggerChar,
  textareaRef,
  value,
  enabled = true,
  requireLineStart = false,
}: UseTriggerPopupOpts) {
  const [state, setState] = useState<TriggerState>(INITIAL_STATE);
  const wasActiveRef = useRef(false);

  // Dismiss the popup
  const dismiss = useCallback(() => {
    setState(INITIAL_STATE);
    wasActiveRef.current = false;
  }, []);

  // Update state based on current textarea value and cursor position
  const update = useCallback(() => {
    if (!enabled) {
      if (wasActiveRef.current) dismiss();
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = value.slice(0, cursorPos);

    // Find the last trigger char before cursor
    const lastTriggerIdx = textBeforeCursor.lastIndexOf(triggerChar);
    if (lastTriggerIdx === -1) {
      if (wasActiveRef.current) dismiss();
      return;
    }

    // Check requireLineStart: trigger must be at position 0 or preceded by a newline
    if (requireLineStart) {
      if (lastTriggerIdx !== 0 && textBeforeCursor[lastTriggerIdx - 1] !== '\n') {
        if (wasActiveRef.current) dismiss();
        return;
      }
    } else {
      // For @: trigger must be at start or preceded by whitespace
      if (lastTriggerIdx > 0 && !/\s/.test(textBeforeCursor[lastTriggerIdx - 1])) {
        if (wasActiveRef.current) dismiss();
        return;
      }
    }

    // Extract query: text between trigger char and cursor (no spaces allowed for @)
    const queryText = textBeforeCursor.slice(lastTriggerIdx + 1);

    // For @mention: dismiss if there's a space in the query (finished typing)
    if (triggerChar === '@' && queryText.includes(' ')) {
      if (wasActiveRef.current) dismiss();
      return;
    }

    // Calculate position — place popover above the textarea
    const rect = textarea.getBoundingClientRect();
    const position = {
      top: rect.top - 4, // Above the textarea
      left: rect.left + 16,
    };

    wasActiveRef.current = true;
    setState({
      isActive: true,
      query: queryText,
      position,
      triggerIndex: lastTriggerIdx,
    });
  }, [value, triggerChar, enabled, requireLineStart, textareaRef, dismiss]);

  // Re-evaluate on value changes
  useEffect(() => {
    update();
  }, [update]);

  // Insert selected text at trigger position, replacing the trigger+query
  const insertSelection = useCallback(
    (insertText: string) => {
      if (!state.isActive || state.triggerIndex === -1) return value;
      const textarea = textareaRef.current;
      const cursorPos = textarea?.selectionStart ?? value.length;
      const before = value.slice(0, state.triggerIndex);
      const after = value.slice(cursorPos);
      dismiss();
      return before + insertText + after;
    },
    [state, value, textareaRef, dismiss],
  );

  // Replace entire input value (for / commands)
  const replaceAll = useCallback(
    (newValue: string) => {
      dismiss();
      return newValue;
    },
    [dismiss],
  );

  return {
    ...state,
    dismiss,
    insertSelection,
    replaceAll,
  };
}
