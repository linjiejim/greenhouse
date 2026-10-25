/**
 * CommandMenuPopover — floating dropdown for the `/` picker.
 *
 * Tasks in one keyboard-navigable list (↑↓ walk across the team-wide then
 * personal groups, Enter/Tab select, Esc dismiss); selecting one attaches
 * structured Task context.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Globe, User, Zap } from '../../lib/icons';
import { PopoverWrapper } from './popover-wrapper';
import type { UserPrompt } from '@greenhouse/types/api';
import { useT } from '../../lib/i18n';
import { SKILLHUB_PROMPTS_HASH } from '../../lib/workspace-routes';

export type { UserPrompt };

interface CommandMenuPopoverProps {
  query: string;
  prompts: UserPrompt[];
  onSelectPrompt: (prompt: UserPrompt) => void;
  onDismiss: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
}

export function CommandMenuPopover({ query, prompts, onSelectPrompt, onDismiss, anchorRef }: CommandMenuPopoverProps) {
  const t = useT();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.toLowerCase();
  const { filteredPrompts, globalPrompts, personalPrompts, flat } = useMemo(() => {
    const filtered = prompts.filter(
      (p) => !q || p.title.toLowerCase().includes(q) || (p.shortcut?.toLowerCase().includes(q) ?? false),
    );
    const global = filtered.filter((p) => p.is_global);
    const personal = filtered.filter((p) => !p.is_global);
    return {
      filteredPrompts: filtered,
      globalPrompts: global,
      personalPrompts: personal,
      // Render order MUST match this for data-idx alignment.
      flat: [...global, ...personal],
    };
  }, [prompts, q]);

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
        setSelectedIndex((i) => Math.min(i + 1, flat.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (flat.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          onSelectPrompt(flat[selectedIndex]);
        }
      }
    },
    [flat, selectedIndex, onSelectPrompt, onDismiss],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selectedIndex}"]`) as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (flat.length === 0) {
    return (
      <PopoverWrapper anchorRef={anchorRef}>
        <div className="px-3 py-3 text-center">
          <p className="mb-1 text-xs text-fg-faint">{t('chat.noMatchingTasks')}</p>
          <p className="text-[11px] text-fg-faint">
            <button
              type="button"
              className="text-accent hover:underline"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                window.location.hash = SKILLHUB_PROMPTS_HASH;
                onDismiss();
              }}
            >
              {t('chat.openTasks')}
            </button>
          </p>
        </div>
      </PopoverWrapper>
    );
  }

  // Running index shared across all groups so data-idx matches `flat`.
  let idx = 0;

  return (
    <PopoverWrapper anchorRef={anchorRef}>
      <div ref={listRef} className="max-h-72 overflow-y-auto" role="listbox" aria-label={t('chat.tasks')}>
        {/* Tasks — team-wide rows first, then personal rows. */}
        {filteredPrompts.length > 0 && (
          <>
            <SectionHeader icon={<Zap size={10} />} label={t('chat.tasks')} />
            {globalPrompts.length > 0 && <SubHeader icon={<Globe size={10} />} label={t('chat.teamTasks')} />}
            {globalPrompts.map((p) => {
              const i = idx++;
              return (
                <PromptRow
                  key={`g-${p.id}`}
                  prompt={p}
                  dataIdx={i}
                  isSelected={i === selectedIndex}
                  onSelect={onSelectPrompt}
                  onHover={() => setSelectedIndex(i)}
                />
              );
            })}
            {personalPrompts.length > 0 && <SubHeader icon={<User size={10} />} label={t('chat.myTasks')} />}
            {personalPrompts.map((p) => {
              const i = idx++;
              return (
                <PromptRow
                  key={`p-${p.id}`}
                  prompt={p}
                  dataIdx={i}
                  isSelected={i === selectedIndex}
                  onSelect={onSelectPrompt}
                  onHover={() => setSelectedIndex(i)}
                />
              );
            })}
          </>
        )}
      </div>
    </PopoverWrapper>
  );
}

// ─── Rows & headers ──────────────────────────────────────

function SectionHeader({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="px-2 py-1.5 text-[10px] font-medium text-fg-faint uppercase tracking-wider flex items-center gap-1 sticky top-0 bg-surface-raised">
      {icon} {label}
    </div>
  );
}

function SubHeader({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="px-2.5 py-1 text-[10px] font-semibold text-fg-faint uppercase tracking-wider flex items-center gap-1 bg-surface-muted">
      {icon} {label}
    </div>
  );
}

function PromptRow({
  prompt,
  dataIdx,
  isSelected,
  onSelect,
  onHover,
}: {
  prompt: UserPrompt;
  dataIdx: number;
  isSelected: boolean;
  onSelect: (p: UserPrompt) => void;
  onHover: () => void;
}) {
  return (
    <button
      data-idx={dataIdx}
      data-selected={isSelected ? 'true' : 'false'}
      role="option"
      aria-selected={isSelected}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect(prompt);
      }}
      onMouseEnter={onHover}
      className={`flex w-full items-center gap-3 px-2.5 py-1.5 text-left transition-colors ${
        isSelected ? 'bg-accent text-on-accent' : 'text-fg hover:bg-surface-muted'
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={prompt.title}>
        {prompt.title}
      </span>
      {prompt.shortcut && (
        <span className={`flex-shrink-0 font-mono text-[11px] ${isSelected ? 'text-white' : 'text-fg-faint'}`}>
          /{prompt.shortcut}
        </span>
      )}
    </button>
  );
}
