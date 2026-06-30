/**
 * TagSelector — popover for adding/removing tags on a session.
 * Supports searching existing tags and creating new ones inline.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { toast } from '../ui';
import { Check, Plus, Search } from '../../lib/icons';
import { TagBadge } from './tag-badge';
import { TAG_COLORS } from './colors';
import type { SessionTag } from '@greenhouse/types/api';
import * as api from '../../lib/api';

interface TagSelectorProps {
  sessionId: string;
  /** Tags currently on this session */
  sessionTags: Array<{ id: number; name: string; color: string }>;
  /** All available user tags */
  allTags: SessionTag[];
  /** Called after any change (add/remove/create) */
  onChanged: () => void;
  onClose: () => void;
  /** Absolute position */
  x: number;
  y: number;
}

export function TagSelector({ sessionId, sessionTags, allTags, onChanged, onClose, x, y }: TagSelectorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState<number | null>(null);

  const sessionTagIds = useMemo(() => new Set(sessionTags.map((t) => t.id)), [sessionTags]);

  const filtered = useMemo(() => {
    if (!search) return allTags;
    const q = search.toLowerCase();
    return allTags.filter((t) => t.name.toLowerCase().includes(q));
  }, [allTags, search]);

  const canCreate = search.trim() && !allTags.some((t) => t.name.toLowerCase() === search.trim().toLowerCase());

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Adjust position
  useEffect(() => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      if (rect.right > window.innerWidth) ref.current.style.left = `${x - rect.width}px`;
      if (rect.bottom > window.innerHeight) ref.current.style.top = `${y - rect.height}px`;
    }
  }, [x, y]);

  // Focus input
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const handleToggle = useCallback(
    async (tag: SessionTag) => {
      setLoading(tag.id);
      try {
        if (sessionTagIds.has(tag.id)) {
          await api.removeTagFromSession(sessionId, tag.id);
        } else {
          await api.addTagToSession(sessionId, tag.id);
        }
        onChanged();
      } catch (err: any) {
        toast(err.message || 'Failed', 'error');
      }
      setLoading(null);
    },
    [sessionId, sessionTagIds, onChanged],
  );

  const handleCreate = useCallback(async () => {
    const name = search.trim();
    if (!name) return;
    try {
      const randomColor = TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)].value;
      const tag = await api.createSessionTag(name, randomColor);
      await api.addTagToSession(sessionId, tag.id);
      setSearch('');
      onChanged();
    } catch (err: any) {
      toast(err.message || 'Failed to create tag', 'error');
    }
  }, [search, sessionId, onChanged]);

  return (
    <div
      ref={ref}
      className="fixed z-50 w-56 bg-surface-raised border border-edge rounded-lg shadow-lg animate-fade-in"
      style={{ left: x, top: y }}
    >
      {/* Search */}
      <div className="p-2 border-b border-edge">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-faint" />
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canCreate) handleCreate();
              if (e.key === 'Escape') onClose();
            }}
            placeholder="Search tags..."
            className="w-full text-xs bg-surface-sunken border border-edge rounded pl-7 pr-2 py-1.5 focus:outline-none focus:border-primary-500 text-fg placeholder:text-fg-faint"
          />
        </div>
      </div>

      {/* Tag list */}
      <div className="max-h-48 overflow-y-auto py-1">
        {filtered.length === 0 && !canCreate && (
          <div className="px-3 py-2 text-xs text-fg-faint text-center">No tags found</div>
        )}
        {filtered.map((tag) => {
          const isActive = sessionTagIds.has(tag.id);
          const isLoading = loading === tag.id;
          return (
            <button
              key={tag.id}
              onClick={() => handleToggle(tag)}
              disabled={isLoading}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-muted transition-colors disabled:opacity-50"
            >
              <span
                className={`w-4 flex items-center justify-center ${isActive ? 'text-primary-500' : 'text-fg-faint'}`}
              >
                {isActive && <Check size={12} />}
              </span>
              <TagBadge name={tag.name} color={tag.color} />
            </button>
          );
        })}
      </div>

      {/* Create new */}
      {canCreate && (
        <div className="border-t border-edge py-1">
          <button
            onClick={handleCreate}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-primary-fg-strong hover:bg-surface-muted transition-colors"
          >
            <Plus size={12} />
            <span>Create &ldquo;{search.trim()}&rdquo;</span>
          </button>
        </div>
      )}
    </div>
  );
}
