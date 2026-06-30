/**
 * CommandMenuPopover — floating dropdown for the `/` composer menu.
 *
 * Lists quick-prompt commands in one grouped, keyboard-navigable list (↑↓
 * navigate, Enter/Tab select, Esc dismiss). Selecting a command expands it into
 * the editable composer text.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Globe, User, Zap } from '../../lib/icons';
import { PopoverWrapper } from './popover-wrapper';
import type { UserPrompt } from '@greenhouse/types/api';

export type { UserPrompt };

interface CommandMenuPopoverProps {
  query: string;
  prompts: UserPrompt[];
  onSelectPrompt: (prompt: UserPrompt) => void;
  onDismiss: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
}

export function CommandMenuPopover({ query, prompts, onSelectPrompt, onDismiss, anchorRef }: CommandMenuPopoverProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.toLowerCase();

  const filteredPrompts = prompts.filter(
    (p) => !q || p.title.toLowerCase().includes(q) || (p.shortcut?.toLowerCase().includes(q) ?? false),
  );
  const globalPrompts = filteredPrompts.filter((p) => p.is_global);
  const personalPrompts = filteredPrompts.filter((p) => !p.is_global);

  // Flat selectable list — render order MUST match this for data-idx alignment.
  const flat: UserPrompt[] = [...globalPrompts, ...personalPrompts];

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
          <p className="text-xs text-fg-faint mb-1">No matching commands</p>
          <p className="text-[11px] text-fg-faint">
            Create quick prompts in{' '}
            <a
              href="#/settings/prompts"
              className="text-primary-500 hover:underline"
              onMouseDown={(e) => e.stopPropagation()}
            >
              Settings
            </a>
          </p>
        </div>
      </PopoverWrapper>
    );
  }

  // Running index shared across all groups so data-idx matches `flat`.
  let idx = 0;

  return (
    <PopoverWrapper anchorRef={anchorRef}>
      <div ref={listRef} className="max-h-72 overflow-y-auto">
        {/* Commands (quick prompts) */}
        <SectionHeader icon={<Zap size={10} />} label="Commands" />
        {globalPrompts.length > 0 && <SubHeader icon={<Globe size={10} />} label="Global" />}
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
        {personalPrompts.length > 0 && <SubHeader icon={<User size={10} />} label="My Prompts" />}
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
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect(prompt);
      }}
      onMouseEnter={onHover}
      className={`w-full flex flex-col gap-0.5 px-2.5 py-2 text-left transition-colors ${
        isSelected ? 'bg-primary-subtle text-primary-fg-strong' : 'text-fg hover:bg-surface-muted'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium truncate" title={prompt.title}>
          {prompt.title}
        </span>
        {prompt.shortcut && (
          <span className="text-[10px] text-fg-faint font-mono bg-surface-muted px-1 py-0.5 rounded flex-shrink-0">
            /{prompt.shortcut}
          </span>
        )}
      </div>
      <div className="text-[11px] text-fg-muted truncate">{prompt.content.slice(0, 80)}</div>
    </button>
  );
}
