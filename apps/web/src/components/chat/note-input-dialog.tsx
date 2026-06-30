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
  const [note, setNote] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-focus
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

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
  const dialogWidth = 640;
  const dialogHeight = 340; // approximate
  const top = Math.max(8, Math.min(anchorRect.top - 8, window.innerHeight - dialogHeight - 16));
  const left = Math.max(8, Math.min(anchorRect.right + 8, window.innerWidth - dialogWidth - 16));

  const displayQuote = quote.length > 200 ? quote.slice(0, 200) + '…' : quote;

  return (
    <div
      ref={containerRef}
      className="fixed z-40 bg-surface-raised border border-edge shadow-xl rounded-xl p-4 animate-fade-in max-w-[calc(100vw-2rem)]"
      style={{ top, left, width: dialogWidth }}
    >
      {/* Quote preview */}
      <div className="flex items-start gap-2 mb-3">
        <MessageSquareQuote size={14} className="text-primary-fg flex-shrink-0 mt-0.5" />
        <p className="text-xs text-fg-muted italic line-clamp-3 leading-relaxed flex-1">"{displayQuote}"</p>
        <button
          onClick={onDismiss}
          className="flex-shrink-0 p-1 rounded text-fg-faint hover:text-fg-secondary transition-colors ml-auto"
        >
          <X size={12} />
        </button>
      </div>

      {/* Note input */}
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
        placeholder="Your note (optional)…"
        rows={5}
        className="w-full text-sm bg-surface-sunken border border-edge-strong rounded-lg px-3 py-2.5 text-fg placeholder-fg-faint focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500 resize-none"
        style={{ minHeight: '140px', maxHeight: '240px' }}
      />
      <div className="flex items-center justify-between mt-2">
        <p className="text-[10px] text-fg-faint">Enter to add · Esc to cancel</p>
        <button
          onClick={handleSubmit}
          className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-primary-600 text-white hover:bg-primary-700 transition-colors"
          title="Add annotation"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
