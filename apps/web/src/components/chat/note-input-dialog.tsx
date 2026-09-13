/**
 * NoteInputDialog — a small floating input dialog that appears after the user
 * clicks the selection quote icon. Shows the selected text preview and an input
 * for adding a note/comment.
 *
 * This is rendered independently of the text selection state so it doesn't
 * unmount when the browser selection clears.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, X, MessageSquareQuote } from '../../lib/icons';
import { useT } from '../../lib/i18n';

interface NoteInputDialogProps {
  /** The selected/quoted text */
  quote: string;
  /** Position hint (viewport coordinates of where the selection was) */
  anchorRect: DOMRect;
  /** Callback with the note text */
  onSubmit: (note: string) => void;
  /** Dismiss without submitting */
  onDismiss: () => void;
}

export function NoteInputDialog({ quote, anchorRect, onSubmit, onDismiss }: NoteInputDialogProps) {
  const t = useT();
  const [note, setNote] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-focus
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 72)}px`;
  }, [note]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 500);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [onDismiss]);

  const handleSubmit = useCallback(() => {
    onSubmit(note.trim());
  }, [note, onSubmit]);

  // Position: near the selection, clamped to viewport
  const dialogWidth = 520;
  const dialogHeight = 190; // approximate, used only for viewport clamping
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const top = Math.max(8, Math.min(anchorRect.top - 8, viewportHeight - dialogHeight - 16));
  const left = Math.max(8, Math.min(anchorRect.right + 8, viewportWidth - dialogWidth - 16));

  const displayQuote = quote.length > 200 ? quote.slice(0, 200) + '…' : quote;

  return (
    <div
      ref={containerRef}
      className="fixed z-40 max-w-[calc(100vw-1rem)] animate-fade-in rounded-xl border border-edge bg-surface-raised p-3 shadow-xl"
      style={{ top, left, width: dialogWidth }}
    >
      {/* Quote preview */}
      <div className="mb-2 flex items-start gap-2">
        <MessageSquareQuote size={14} className="text-primary-fg flex-shrink-0 mt-0.5" />
        <p className="line-clamp-2 flex-1 text-xs italic leading-relaxed text-fg-muted">"{displayQuote}"</p>
        <button
          onClick={onDismiss}
          className="flex-shrink-0 p-1 rounded text-fg-faint hover:text-fg-secondary transition-colors ml-auto"
        >
          <X size={12} />
        </button>
      </div>

      {/* One compact input row. The textarea grows to three lines, then scrolls. */}
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
            if (e.key === 'Escape') onDismiss();
          }}
          placeholder={t('chat.yourNoteOptional')}
          rows={1}
          className="min-h-9 max-h-[72px] min-w-0 flex-1 resize-none overflow-y-auto rounded-lg border border-edge-strong bg-surface-sunken px-3 py-2 text-sm text-fg placeholder-fg-faint focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
        />
        <button
          onClick={handleSubmit}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary-600 text-white transition-colors hover:bg-primary-700"
          title={t('chat.addAnnotation')}
        >
          <Send size={14} />
        </button>
      </div>
      <p className="mt-1 text-[10px] text-fg-faint">{t('chat.noteKeyboardHint')}</p>
    </div>
  );
}
