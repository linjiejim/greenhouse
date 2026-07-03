/**
 * MentionPopover — floating dropdown for @-mentioning an agent profile.
 *
 * Mirrors SlashCommandPopover's interaction model (↑↓ navigate, Enter/Tab select,
 * Esc dismiss) but lists agent profiles. Selecting a profile switches the active
 * profile for the chat and surfaces it as a pill in the composer.
 *
 * Reuses profileToSprouty + SproutyFace from profile-selector so the avatar
 * styling stays consistent with the toolbar picker.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Bot, Check } from '../../lib/icons';
import type { Profile } from '../../lib/api';
import { SproutyFace } from '../sprouty/index.js';
import { profileToSprouty } from './profile-selector';
import { PopoverWrapper } from './popover-wrapper';

interface MentionPopoverProps {
  query: string;
  profiles: Profile[];
  /** Currently-active profile id, shown with a check. */
  selectedProfileId: string;
  onSelect: (profileId: string) => void;
  onDismiss: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
}

export function MentionPopover({
  query,
  profiles,
  selectedProfileId,
  onSelect,
  onDismiss,
  anchorRef,
}: MentionPopoverProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = profiles.filter((p) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return p.name.toLowerCase().includes(q) || (p.description?.toLowerCase().includes(q) ?? false);
  });

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (filtered.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          onSelect(filtered[selectedIndex].id);
        }
      }
    },
    [filtered, selectedIndex, onSelect, onDismiss],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selectedIndex}"]`) as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (filtered.length === 0) {
    return (
      <PopoverWrapper anchorRef={anchorRef}>
        <div className="px-3 py-3 text-center">
          <p className="text-xs text-fg-faint">No matching profiles</p>
        </div>
      </PopoverWrapper>
    );
  }

  return (
    <PopoverWrapper anchorRef={anchorRef}>
      <div className="px-2.5 py-1.5 text-[10px] font-medium text-fg-faint uppercase tracking-wider flex items-center gap-1">
        <Bot size={10} /> Agent Profile
      </div>
      <div ref={listRef} className="max-h-64 overflow-y-auto">
        {filtered.map((p, idx) => {
          const isSelected = idx === selectedIndex;
          const isActive = p.id === selectedProfileId;
          return (
            <button
              key={p.id}
              data-idx={idx}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(p.id);
              }}
              onMouseEnter={() => setSelectedIndex(idx)}
              className={`w-full flex items-center gap-2 px-2.5 py-2 text-left transition-colors ${
                isSelected ? 'bg-primary-subtle text-primary-fg-strong' : 'text-fg hover:bg-surface-muted'
              }`}
            >
              <SproutyFace {...profileToSprouty(p)} state="idle" size="xs" animate={isSelected} />
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium truncate" title={p.name}>
                  {p.name}
                </span>
                {p.description && (
                  <span className="block text-[11px] text-fg-muted truncate" title={p.description}>
                    {p.description}
                  </span>
                )}
              </span>
              {isActive && <Check size={14} className="flex-shrink-0 text-primary-fg" />}
            </button>
          );
        })}
      </div>
    </PopoverWrapper>
  );
}
