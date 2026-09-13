/**
 * MentionPopover — floating dropdown for selecting an Agent Profile with `@`.
 *
 * Mirrors SlashCommandPopover's interaction model (↑↓ navigate, Enter/Tab select,
 * Esc dismiss) and lists Agent Profiles only. Selecting one switches the active
 * profile for a new chat and surfaces it as a pill in the composer.
 *
 * Reuses profileToSprouty + SproutyAvatar from profile-selector so the avatar
 * styling stays consistent with the toolbar picker.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Check } from '../../lib/icons';
import type { Profile } from '../../lib/api';
import { SproutyAvatar } from '../sprouty/index.js';
import { profileToSprouty } from './profile-selector';
import { PopoverWrapper } from './popover-wrapper';
import { useLocalized, useT } from '../../lib/i18n';
import { Tag } from '../ui';

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
  const t = useT();
  const localized = useLocalized();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = profiles.filter((p) => {
    if (!query) return true;
    const q = query.toLowerCase();
    const name = localized(p.name_i18n, p.name);
    const description = localized(p.description_i18n, p.description ?? '');
    return name.toLowerCase().includes(q) || description.toLowerCase().includes(q);
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
          <p className="text-xs text-fg-faint">{t('chat.noMatchingAgentProfiles')}</p>
        </div>
      </PopoverWrapper>
    );
  }

  return (
    <PopoverWrapper anchorRef={anchorRef}>
      <div ref={listRef} className="max-h-64 overflow-y-auto" role="listbox" aria-label={t('chat.agentProfile')}>
        {filtered.map((p, idx) => {
          const isSelected = idx === selectedIndex;
          const isActive = p.id === selectedProfileId;
          const name = localized(p.name_i18n, p.name);
          const source = !p.is_custom ? 'system' : p.is_shared ? 'shared' : 'personal';
          return (
            <button
              key={p.id}
              data-idx={idx}
              data-selected={isSelected ? 'true' : 'false'}
              role="option"
              aria-selected={isSelected}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(p.id);
              }}
              onMouseEnter={() => setSelectedIndex(idx)}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
                isSelected ? 'bg-primary-600 text-white' : 'text-fg hover:bg-surface-muted'
              }`}
            >
              <SproutyAvatar {...profileToSprouty(p)} state="idle" size="xs" animate={isSelected} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={name}>
                {name}
              </span>
              <Tag tone={source === 'system' ? 'neutral' : source === 'shared' ? 'info' : 'primary'}>
                {t(`profileSelector.${source}`)}
              </Tag>
              {isActive && <Check size={14} className="flex-shrink-0" />}
            </button>
          );
        })}
      </div>
    </PopoverWrapper>
  );
}
