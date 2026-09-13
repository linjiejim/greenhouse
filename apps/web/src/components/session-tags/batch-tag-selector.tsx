/**
 * BatchTagSelector — popover for adding tags to MANY sessions at once.
 *
 * Deliberately a separate component from {@link TagSelector}: the single-session
 * selector mutates immediately on every toggle (add/remove), whereas the batch
 * flow *collects* a set of tags first and applies them to N sessions in one go
 * with **add semantics only** (existing tags on those sessions are never
 * removed). It reuses the display primitives (TagBadge / TAG_COLORS / the
 * create-inline UI) so the two selectors stay visually identical.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { toast } from '../ui';
import { Check, Plus, Search } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { TagBadge } from './tag-badge';
import { TAG_COLORS } from './colors';
import type { SessionTag } from '@greenhouse/types/api';
import * as api from '../../lib/api';

interface BatchTagSelectorProps {
  /** Sessions the picked tags will be applied to (drives the count label). */
  sessionIds: string[];
  /** All available user tags. */
  allTags: SessionTag[];
  /** Apply the collected tag ids to every session (add-only). */
  onApply: (tagIds: number[]) => Promise<void>;
  /** Refresh the parent tag library after an inline create. */
  onTagsChanged: () => void;
  onClose: () => void;
  x: number;
  y: number;
}

export function BatchTagSelector({
  sessionIds,
  allTags,
  onApply,
  onTagsChanged,
  onClose,
  x,
  y,
}: BatchTagSelectorProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  // Tags created inside this popover (parent `allTags` refreshes async).
  const [extraTags, setExtraTags] = useState<SessionTag[]>([]);
  const [busy, setBusy] = useState(false);

  const tags = useMemo(() => {
    const seen = new Set(allTags.map((tag) => tag.id));
    return [...allTags, ...extraTags.filter((tag) => !seen.has(tag.id))];
  }, [allTags, extraTags]);

  const filtered = useMemo(() => {
    if (!search) return tags;
    const q = search.toLowerCase();
    return tags.filter((tag) => tag.name.toLowerCase().includes(q));
  }, [tags, search]);

  const canCreate = search.trim() && !tags.some((tag) => tag.name.toLowerCase() === search.trim().toLowerCase());

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useEffect(() => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      if (rect.right > window.innerWidth) ref.current.style.left = `${x - rect.width}px`;
      if (rect.bottom > window.innerHeight) ref.current.style.top = `${y - rect.height}px`;
    }
  }, [x, y]);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const toggle = useCallback((id: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleCreate = useCallback(async () => {
    const name = search.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const color = TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)].value;
      const tag = await api.createSessionTag(name, color);
      setExtraTags((prev) => [...prev, tag]);
      setPicked((prev) => new Set(prev).add(tag.id));
      setSearch('');
      onTagsChanged();
    } catch (err: any) {
      toast(err.message || 'Failed to create tag', 'error');
    }
    setBusy(false);
  }, [search, busy, onTagsChanged]);

  const handleApply = useCallback(async () => {
    if (picked.size === 0 || busy) return;
    setBusy(true);
    try {
      await onApply([...picked]);
      onClose();
    } catch (err: any) {
      toast(err.message || 'Failed', 'error');
      setBusy(false);
    }
  }, [picked, busy, onApply, onClose]);

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
            placeholder={t('sessionGroups.batchTagPlaceholder')}
            className="w-full text-xs bg-surface-sunken border border-edge rounded pl-7 pr-2 py-1.5 focus:outline-none focus:border-primary-500 text-fg placeholder:text-fg-faint"
          />
        </div>
      </div>

      {/* Tag list */}
      <div className="max-h-48 overflow-y-auto py-1">
        {filtered.length === 0 && !canCreate && (
          <div className="px-3 py-2 text-xs text-fg-faint text-center">{t('sessionGroups.noTags')}</div>
        )}
        {filtered.map((tag) => {
          const isPicked = picked.has(tag.id);
          return (
            <button
              key={tag.id}
              onClick={() => toggle(tag.id)}
              disabled={busy}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-muted transition-colors disabled:opacity-50"
            >
              <span
                className={`w-4 flex items-center justify-center ${isPicked ? 'text-primary-500' : 'text-fg-faint'}`}
              >
                {isPicked && <Check size={12} />}
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
            disabled={busy}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-primary-fg-strong hover:bg-surface-muted transition-colors disabled:opacity-50"
          >
            <Plus size={12} />
            <span>
              {t('common.create')} &ldquo;{search.trim()}&rdquo;
            </span>
          </button>
        </div>
      )}

      {/* Apply */}
      <div className="border-t border-edge p-2">
        <button
          onClick={handleApply}
          disabled={busy || picked.size === 0}
          className="w-full rounded-md bg-primary-500 px-2 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-40 disabled:hover:bg-primary-500"
        >
          {t('sessionGroups.applyToCount', { count: sessionIds.length })}
        </button>
      </div>
    </div>
  );
}
