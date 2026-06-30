/**
 * Inline feedback controls for assistant messages.
 * Visible after AI response — star rating, thumbs up/down, admin notes.
 * Data is stored at the session level via the API.
 */

import React, { useState, useRef, useEffect } from 'react';
import { ThumbsUp, ThumbsDown, Pencil, Star, Check, X } from '../../lib/icons';
import * as api from '../../lib/api';
import { useT } from '../../lib/i18n';

interface MessageFeedbackProps {
  messageId: string;
  sessionId: string | null;
  /** Initial values from session-level data */
  initialRating?: number | null;
  initialComment?: string | null;
  /** Compact inline mode (no border/padding, smaller) — used in header */
  inline?: boolean;
  /** Render persisted feedback without allowing edits (e.g. shared read-only sessions). */
  readonly?: boolean;
}

export function MessageFeedback({
  messageId: _messageId,
  sessionId,
  initialRating,
  initialComment,
  inline,
  readonly = false,
}: MessageFeedbackProps) {
  const t = useT();
  const [rating, setRating] = useState<number>(initialRating ?? 0);
  const [hoverRating, setHoverRating] = useState<number>(0);
  const [vote, setVote] = useState<'up' | 'down' | null>(
    initialRating ? (initialRating >= 4 ? 'up' : initialRating <= 2 ? 'down' : null) : null,
  );
  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState(initialComment || '');
  const [_saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [loaded, setLoaded] = useState(!!initialRating || !!initialComment);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Sync with parent prop changes (e.g., after session reload/switch)
  useEffect(() => {
    const nextRating = initialRating ?? 0;
    setRating(nextRating);
    setVote(nextRating >= 4 ? 'up' : nextRating > 0 && nextRating <= 2 ? 'down' : null);
    setNote(initialComment || '');
    setLoaded(!!initialRating || !!initialComment);
  }, [initialRating, initialComment]);

  // Load persisted feedback from session on mount
  useEffect(() => {
    if (!sessionId || loaded) return;
    (async () => {
      try {
        const data = await api.getSession(sessionId);
        const sess = data.session;
        if (sess.rating != null) {
          setRating(sess.rating);
          setVote(sess.rating >= 4 ? 'up' : sess.rating <= 2 ? 'down' : null);
        }
        if (sess.comment) {
          setNote(sess.comment);
        }
      } catch (_err) {
        /* silent */
      }
      setLoaded(true);
    })();
  }, [sessionId, loaded]);

  useEffect(() => {
    if (showNote && noteRef.current) {
      noteRef.current.focus();
    }
  }, [showNote]);

  const persistRating = async (newRating: number | null) => {
    if (!sessionId || readonly) return;
    setSaveError(false);
    try {
      await api.updateSession(sessionId, { rating: newRating });
      showSaved();
    } catch (_err) {
      setSaveError(true);
      setTimeout(() => setSaveError(false), 2000);
    }
  };

  const showSaved = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleStarClick = (star: number) => {
    if (readonly) return;
    const newRating = rating === star ? 0 : star; // Toggle off if same star
    setRating(newRating);
    // Sync thumbs
    if (newRating >= 4) setVote('up');
    else if (newRating > 0 && newRating <= 2) setVote('down');
    else setVote(null);
    persistRating(newRating || null);
  };

  const handleVote = async (newVote: 'up' | 'down') => {
    if (readonly) return;
    const toggled = vote === newVote ? null : newVote;
    setVote(toggled);
    // Sync star rating
    const newRating = toggled === 'up' ? 5 : toggled === 'down' ? 1 : 0;
    setRating(newRating);
    persistRating(newRating || null);
    // Auto-open note popover after voting
    if (toggled) {
      setShowNote(true);
    }
  };

  const handleSaveNote = async () => {
    if (readonly) {
      setShowNote(false);
      return;
    }
    if (sessionId) {
      setSaveError(false);
      try {
        await api.updateSession(sessionId, { comment: note || null });
        showSaved();
      } catch (_err) {
        setSaveError(true);
        setTimeout(() => setSaveError(false), 2000);
      }
    }
    setShowNote(false);
  };

  return (
    <div className="relative inline-flex max-w-full">
      <div
        className={
          inline
            ? 'flex items-center gap-1 rounded-lg border border-edge bg-surface-muted px-1.5 py-1 max-w-full'
            : 'flex items-center gap-2 mt-2 pt-1.5 border-t border-edge'
        }
      >
        {/* Star rating */}
        <div className="flex items-center gap-0 flex-shrink-0" onMouseLeave={() => setHoverRating(0)}>
          {[1, 2, 3, 4, 5].map((star) => {
            const filled = star <= (hoverRating || rating);
            return (
              <button
                key={star}
                onClick={() => handleStarClick(star)}
                onMouseEnter={() => !readonly && setHoverRating(star)}
                className={`text-sm transition-colors p-0.5 ${
                  filled ? 'text-star' : readonly ? 'text-fg-faint' : 'text-fg-faint hover:text-star-hover'
                } ${readonly ? 'cursor-default' : ''}`}
                title={`${star} star${star > 1 ? 's' : ''}${readonly ? ' (read only)' : ''}`}
                aria-disabled={readonly}
              >
                <Star size={12} className={`${filled ? 'fill-current' : ''}`} />
              </button>
            );
          })}
        </div>

        <span className="h-3.5 w-px bg-edge-strong flex-shrink-0" />

        {/* Thumbs up */}
        <button
          onClick={() => handleVote('up')}
          className={`p-0.5 rounded transition-colors text-xs flex-shrink-0 ${
            vote === 'up'
              ? 'text-success bg-success-subtle'
              : readonly
                ? 'text-fg-faint'
                : 'text-fg-faint hover:text-fg-muted hover:bg-surface-sunken'
          } ${readonly ? 'cursor-default' : ''}`}
          title={`${t('chat.goodResponse')}${readonly ? ' (read only)' : ''}`}
          aria-disabled={readonly}
        >
          <ThumbsUp size={14} />
        </button>

        {/* Thumbs down */}
        <button
          onClick={() => handleVote('down')}
          className={`p-0.5 rounded transition-colors text-xs flex-shrink-0 ${
            vote === 'down'
              ? 'text-danger bg-danger-subtle'
              : readonly
                ? 'text-fg-faint'
                : 'text-fg-faint hover:text-fg-muted hover:bg-surface-sunken'
          } ${readonly ? 'cursor-default' : ''}`}
          title={`${t('chat.badResponse')}${readonly ? ' (read only)' : ''}`}
          aria-disabled={readonly}
        >
          <ThumbsDown size={14} />
        </button>

        <span className="h-3.5 w-px bg-edge-strong flex-shrink-0" />

        {/* Note toggle */}
        <button
          onClick={() => {
            if (readonly && !note) return;
            setShowNote(!showNote);
          }}
          className={`flex items-center gap-1 p-0.5 rounded transition-colors text-xs min-w-0 ${
            note
              ? 'text-star bg-warning-subtle'
              : readonly
                ? 'text-fg-faint'
                : 'text-fg-faint hover:text-fg-muted hover:bg-surface-sunken'
          } ${readonly && !note ? 'cursor-default' : ''}`}
          title={readonly ? note || 'No note' : note ? t('chat.editNote') : t('chat.addNote')}
          aria-disabled={readonly && !note}
        >
          <Pencil size={12} className="flex-shrink-0" />
          {note && <span className="text-[10px] text-warning max-w-[120px] truncate">{note}</span>}
        </button>

        {/* Error indicator only */}
        {saveError && <span className="text-[10px] text-danger ml-1 animate-fade-in flex-shrink-0">error</span>}
      </div>

      {/* Note content opens as a long bar above the feedback controls. */}
      {showNote && (
        <div className="absolute bottom-full left-0 mb-2 z-30 w-[640px] max-w-[calc(100vw-2rem)] animate-fade-in">
          {readonly ? (
            <div className="bg-surface-raised border border-edge rounded-xl shadow-lg p-3">
              <ReadOnlyNote note={note} onClose={() => setShowNote(false)} />
            </div>
          ) : (
            <NoteBar
              noteRef={noteRef}
              note={note}
              setNote={setNote}
              onSave={handleSaveNote}
              onCancel={() => setShowNote(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── ReadOnlyNote ────────────────────────────────────────

function ReadOnlyNote({ note, onClose }: { note: string; onClose: () => void }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-fg-secondary">
          <Pencil size={12} className="text-fg-faint" />
          Note
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded text-fg-faint hover:text-fg-secondary hover:bg-surface-muted transition-colors"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>
      <p className="text-sm text-fg-secondary whitespace-pre-wrap break-words">{note}</p>
    </div>
  );
}

// ─── NoteBar ─────────────────────────────────────────────

function NoteBar({
  noteRef,
  note,
  setNote,
  onSave,
  onCancel,
}: {
  noteRef: React.RefObject<HTMLTextAreaElement | null>;
  note: string;
  setNote: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  // Auto-grow: default 1 line, max 3 lines
  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    // ~3 lines of text-sm (line-height ~20px) + py-1.5 (12px) = ~72px
    el.style.height = Math.min(el.scrollHeight, 72) + 'px';
  };

  useEffect(() => {
    if (noteRef.current) autoGrow(noteRef.current);
  }, [note]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 p-2 bg-surface-raised border border-edge rounded-xl shadow-lg">
      <div className="flex items-center gap-1.5 text-xs font-medium text-fg-muted flex-shrink-0 px-1">
        <Pencil size={13} className="text-fg-faint" />
        <span>Note</span>
      </div>
      <textarea
        ref={noteRef as React.RefObject<HTMLTextAreaElement>}
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          autoGrow(e.target);
        }}
        placeholder="Admin notes..."
        rows={1}
        className="flex-1 min-w-0 text-sm bg-surface-sunken border border-edge-strong rounded-lg px-3 py-1.5 text-fg placeholder-fg-faint focus:outline-none focus:ring-1 focus:ring-primary-500/40 resize-none"
        style={{ height: '32px', maxHeight: '72px' }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSave();
          }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="flex items-center justify-end gap-1 flex-shrink-0">
        <button
          onClick={onCancel}
          className="p-1 rounded text-fg-faint hover:text-fg-secondary hover:bg-surface-muted transition-colors"
          title="Cancel"
        >
          <X size={14} />
        </button>
        <button
          onClick={onSave}
          className="p-1 rounded text-primary-fg hover:text-primary-fg-strong hover:bg-primary-subtle transition-colors"
          title="Save"
        >
          <Check size={14} />
        </button>
      </div>
    </div>
  );
}
