/**
 * AnnotationList — displays multiple quote annotations above the chat input.
 *
 * Each annotation shows:
 * - A numbered index
 * - The quoted text (truncated)
 * - The user's note/comment (editable)
 * - Edit and delete buttons
 */

import React, { useState, useRef, useEffect } from 'react';
import { X, Pencil, Check } from '../../lib/icons';

export interface Annotation {
  id: string;
  quote: string;
  note: string;
}

interface AnnotationListProps {
  annotations: Annotation[];
  onUpdate: (id: string, note: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
}

export function AnnotationList({ annotations, onUpdate, onDelete, onClearAll }: AnnotationListProps) {
  if (annotations.length === 0) return null;

  return (
    <div className="mb-2 space-y-1.5 animate-fade-in">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] text-fg-faint font-medium uppercase tracking-wider">
          Annotations ({annotations.length})
        </span>
        {annotations.length > 1 && (
          <button
            onClick={onClearAll}
            className="text-[10px] text-fg-faint hover:text-danger transition-colors"
            title="Clear all annotations"
          >
            Clear all
          </button>
        )}
      </div>
      {annotations.map((ann, idx) => (
        <AnnotationItem
          key={ann.id}
          annotation={ann}
          index={idx + 1}
          onUpdate={(note) => onUpdate(ann.id, note)}
          onDelete={() => onDelete(ann.id)}
        />
      ))}
    </div>
  );
}

function AnnotationItem({
  annotation,
  index,
  onUpdate,
  onDelete,
}: {
  annotation: Annotation;
  index: number;
  onUpdate: (note: string) => void;
  onDelete: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editNote, setEditNote] = useState(annotation.note);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const displayQuote = annotation.quote.length > 80 ? annotation.quote.slice(0, 80) + '…' : annotation.quote;

  const handleSave = () => {
    onUpdate(editNote.trim());
    setIsEditing(false);
  };

  return (
    <div className="flex items-start gap-2 px-2.5 py-2 bg-surface-sunken border border-edge rounded-lg group/ann">
      {/* Index badge */}
      <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-full bg-primary-subtle text-primary-fg-strong text-[10px] font-bold mt-0.5">
        {index}
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-0.5">
        {/* Quoted text */}
        <p className="text-[11px] text-fg-muted italic line-clamp-2 leading-relaxed">"{displayQuote}"</p>

        {/* Note */}
        {isEditing ? (
          <div className="flex items-center gap-1 mt-1">
            <input
              ref={inputRef}
              type="text"
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
                if (e.key === 'Escape') {
                  setIsEditing(false);
                  setEditNote(annotation.note);
                }
              }}
              className="flex-1 text-xs bg-surface-raised border border-edge-strong rounded px-2 py-1 text-fg focus:outline-none focus:ring-1 focus:ring-primary-500/40"
              placeholder="Your note…"
            />
            <button
              onClick={handleSave}
              className="p-1 rounded text-primary-fg hover:bg-primary-subtle transition-colors"
              title="Save"
            >
              <Check size={12} />
            </button>
          </div>
        ) : annotation.note ? (
          <p className="text-xs text-fg-secondary font-medium leading-relaxed">→ {annotation.note}</p>
        ) : (
          <p className="text-[11px] text-fg-faint">(no note)</p>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover/ann:opacity-100 touch-visible transition-opacity">
        {!isEditing && (
          <button
            onClick={() => {
              setEditNote(annotation.note);
              setIsEditing(true);
            }}
            className="p-1 rounded text-fg-faint hover:text-fg-secondary hover:bg-surface-muted transition-colors"
            title="Edit note"
          >
            <Pencil size={11} />
          </button>
        )}
        <button
          onClick={onDelete}
          className="p-1 rounded text-fg-faint hover:text-danger hover:bg-danger-subtle transition-colors"
          title="Remove"
        >
          <X size={11} />
        </button>
      </div>
    </div>
  );
}
