/**
 * GroupSelector — popover for filing a session into a folder (single-home).
 * Pick one folder, remove from folder, or create a new folder inline.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { toast } from '../ui';
import { Check, Plus, Search, X } from '../../lib/icons';
import { TAG_COLORS } from '../session-tags/colors';
import { useT } from '../../lib/i18n';
import type { SessionGroup } from '@greenhouse/types/api';
import * as api from '../../lib/api';

interface GroupSelectorProps {
  sessionId: string;
  /** The session's current folder id (null = unfiled). */
  currentGroupId: number | null;
  /** All of the user's folders (Pinned is filtered out internally). */
  allGroups: SessionGroup[];
  /** Called after any change (move/remove/create). */
  onChanged: () => void;
  onClose: () => void;
  x: number;
  y: number;
}

export function GroupSelector({ sessionId, currentGroupId, allGroups, onChanged, onClose, x, y }: GroupSelectorProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const folders = useMemo(() => allGroups.filter((g) => g.kind !== 'pinned'), [allGroups]);
  const filtered = useMemo(() => {
    if (!search) return folders;
    const q = search.toLowerCase();
    return folders.filter((g) => g.name.toLowerCase().includes(q));
  }, [folders, search]);

  const canCreate = search.trim() && !folders.some((g) => g.name.toLowerCase() === search.trim().toLowerCase());

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

  const handlePick = useCallback(
    async (groupId: number | null) => {
      setBusy(true);
      try {
        // Single-home toggle: re-picking the current folder removes the session from it.
        const next = groupId != null && groupId === currentGroupId ? null : groupId;
        await api.setSessionGroup(sessionId, next);
        onChanged();
        onClose();
      } catch (err: any) {
        toast(err.message || 'Failed', 'error');
      }
      setBusy(false);
    },
    [sessionId, currentGroupId, onChanged, onClose],
  );

  const handleCreate = useCallback(async () => {
    const name = search.trim();
    if (!name) return;
    setBusy(true);
    try {
      const color = TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)].value;
      const group = await api.createSessionGroup(name, color);
      await api.setSessionGroup(sessionId, group.id);
      setSearch('');
      onChanged();
      onClose();
    } catch (err: any) {
      toast(err.message || 'Failed to create group', 'error');
    }
    setBusy(false);
  }, [search, sessionId, onChanged, onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 w-56 bg-surface-raised border border-edge rounded-lg shadow-lg animate-fade-in"
      style={{ left: x, top: y }}
    >
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
            placeholder={t('sessionGroups.moveToGroup') || 'Move to group...'}
            className="w-full text-xs bg-surface-sunken border border-edge rounded pl-7 pr-2 py-1.5 focus:outline-none focus:border-primary-500 text-fg placeholder:text-fg-faint"
          />
        </div>
      </div>

      <div className="max-h-48 overflow-y-auto py-1">
        {/* Remove from folder */}
        {currentGroupId != null && (
          <button
            onClick={() => handlePick(null)}
            disabled={busy}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg-secondary hover:bg-surface-muted transition-colors disabled:opacity-50"
          >
            <span className="w-4 flex items-center justify-center text-fg-faint">
              <X size={12} />
            </span>
            <span>{t('sessionGroups.removeFromGroup') || 'Remove from group'}</span>
          </button>
        )}
        {filtered.length === 0 && !canCreate && (
          <div className="px-3 py-2 text-xs text-fg-faint text-center">
            {t('sessionGroups.noGroups') || 'No groups'}
          </div>
        )}
        {filtered.map((group) => {
          const isActive = group.id === currentGroupId;
          return (
            <button
              key={group.id}
              onClick={() => handlePick(group.id)}
              disabled={busy}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-muted transition-colors disabled:opacity-50"
            >
              <span
                className={`w-4 flex items-center justify-center ${isActive ? 'text-primary-500' : 'text-transparent'}`}
              >
                <Check size={12} />
              </span>
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: group.color }} />
              <span className="flex-1 text-left truncate text-fg">{group.name}</span>
            </button>
          );
        })}
      </div>

      {canCreate && (
        <div className="border-t border-edge py-1">
          <button
            onClick={handleCreate}
            disabled={busy}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-primary-fg-strong hover:bg-surface-muted transition-colors disabled:opacity-50"
          >
            <Plus size={12} />
            <span>
              {t('common.create') || 'Create'} &ldquo;{search.trim()}&rdquo;
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
