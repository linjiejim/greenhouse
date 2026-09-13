/**
 * CommandMenuPopover — floating dropdown for the `/` picker.
 *
 * Two sections in one keyboard-navigable list (↑↓ walk straight across
 * sections, Enter/Tab select, Esc dismiss):
 *   • Tasks — grouped team-wide then personal; selecting one attaches
 *     structured Task context.
 *   • Skills — mission-ready Skill Center skills (only passed in when the
 *     user can launch Cloud Agent missions); selecting one attaches a skill
 *     chip whose send launches a mission directly.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Globe, Sparkles, User, Zap } from '../../lib/icons';
import { PopoverWrapper } from './popover-wrapper';
import type { UserPrompt } from '@greenhouse/types/api';
import { useT } from '../../lib/i18n';
import { Tag } from '../ui';
import type { MissionRuntimeAvailability } from '../../lib/api/cloud-agent';
import type { SkillSourceGroup } from '../../lib/api/skills';

export type { UserPrompt };

/** The slice of a Skill Center entry the composer needs. */
export interface SlashSkill {
  name: string;
  display_name: string;
  description: string;
  group: SkillSourceGroup;
}

const SKILL_GROUP_ORDER: SkillSourceGroup[] = ['branding', 'business'];

type MenuEntry = { kind: 'prompt'; prompt: UserPrompt } | { kind: 'skill'; skill: SlashSkill };

interface CommandMenuPopoverProps {
  query: string;
  prompts: UserPrompt[];
  /** Mission-ready skills; empty when the user lacks the cloud-agent feature. */
  skills?: SlashSkill[];
  /** Present for feature-enabled users so a closed runtime is visible, not a missing section. */
  missionAvailability?: MissionRuntimeAvailability;
  onSelectPrompt: (prompt: UserPrompt) => void;
  onSelectSkill?: (skill: SlashSkill) => void;
  onDismiss: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
}

export function CommandMenuPopover({
  query,
  prompts,
  skills = [],
  missionAvailability,
  onSelectPrompt,
  onSelectSkill,
  onDismiss,
  anchorRef,
}: CommandMenuPopoverProps) {
  const t = useT();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.toLowerCase();
  const { filteredPrompts, globalPrompts, personalPrompts, skillGroups, flat } = useMemo(() => {
    const filtered = prompts.filter(
      (p) => !q || p.title.toLowerCase().includes(q) || (p.shortcut?.toLowerCase().includes(q) ?? false),
    );
    const global = filtered.filter((p) => p.is_global);
    const personal = filtered.filter((p) => !p.is_global);
    const matchingSkills = skills.filter(
      (s) => !q || s.display_name.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
    );
    const groupedSkills = SKILL_GROUP_ORDER.map((group) => ({
      group,
      skills: matchingSkills.filter((skill) => skill.group === group),
    })).filter((entry) => entry.skills.length > 0);
    return {
      filteredPrompts: filtered,
      globalPrompts: global,
      personalPrompts: personal,
      skillGroups: groupedSkills,
      // Render order MUST match this for data-idx alignment.
      flat: [
        ...[...global, ...personal].map((prompt): MenuEntry => ({ kind: 'prompt', prompt })),
        ...groupedSkills.flatMap((entry) => entry.skills.map((skill): MenuEntry => ({ kind: 'skill', skill }))),
      ],
    };
  }, [prompts, skills, q]);

  const dispatch = useCallback(
    (entry: MenuEntry) => {
      if (entry.kind === 'prompt') onSelectPrompt(entry.prompt);
      else onSelectSkill?.(entry.skill);
    },
    [onSelectPrompt, onSelectSkill],
  );

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
          dispatch(flat[selectedIndex]);
        }
      }
    },
    [flat, selectedIndex, dispatch, onDismiss],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selectedIndex}"]`) as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const showMissionStatus = missionAvailability !== undefined && missionAvailability !== 'ready';

  if (flat.length === 0 && !showMissionStatus) {
    return (
      <PopoverWrapper anchorRef={anchorRef}>
        <div className="px-3 py-3 text-center">
          <p className="mb-1 text-xs text-fg-faint">{t('chat.noMatchingTasks')}</p>
          <p className="text-[11px] text-fg-faint">
            <button
              type="button"
              className="text-primary-500 hover:underline"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                window.location.hash = '#/tasks';
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
        {/* Skills — selecting one arms a mission launch, hence the Tag. */}
        {skillGroups.length > 0 && (
          <>
            <SectionHeader icon={<Sparkles size={10} />} label={t('chat.skillsSection')} />
            {skillGroups.map(({ group, skills: grouped }) => (
              <React.Fragment key={group}>
                <SubHeader icon={<Sparkles size={10} />} label={t(`skillHub.group.${group}`)} />
                {grouped.map((s) => {
                  const i = idx++;
                  return (
                    <SkillRow
                      key={`s-${s.name}`}
                      skill={s}
                      dataIdx={i}
                      isSelected={i === selectedIndex}
                      onSelect={(skill) => onSelectSkill?.(skill)}
                      onHover={() => setSelectedIndex(i)}
                    />
                  );
                })}
              </React.Fragment>
            ))}
          </>
        )}
        {showMissionStatus && (
          <>
            <SectionHeader icon={<Sparkles size={10} />} label={t('chat.skillsSection')} />
            <div className="px-3 py-2.5" role="status">
              <p className="text-xs font-medium text-fg-secondary">
                {missionAvailability === 'checking'
                  ? t('chat.missionRuntimeChecking')
                  : t('chat.missionRuntimeUnavailable')}
              </p>
              <p className="mt-0.5 text-[11px] text-fg-faint">{t('chat.missionRuntimeUnavailableHint')}</p>
            </div>
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
        isSelected ? 'bg-primary-600 text-white' : 'text-fg hover:bg-surface-muted'
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

function SkillRow({
  skill,
  dataIdx,
  isSelected,
  onSelect,
  onHover,
}: {
  skill: SlashSkill;
  dataIdx: number;
  isSelected: boolean;
  onSelect: (s: SlashSkill) => void;
  onHover: () => void;
}) {
  const t = useT();
  return (
    <button
      data-idx={dataIdx}
      data-selected={isSelected ? 'true' : 'false'}
      role="option"
      aria-selected={isSelected}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect(skill);
      }}
      onMouseEnter={onHover}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
        isSelected ? 'bg-primary-600 text-white' : 'text-fg hover:bg-surface-muted'
      }`}
    >
      <Sparkles size={12} className={`flex-shrink-0 ${isSelected ? 'text-white' : 'text-primary-fg'}`} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={skill.display_name}>
        {skill.display_name}
      </span>
      <span className={`flex-shrink-0 font-mono text-[11px] ${isSelected ? 'text-white' : 'text-fg-faint'}`}>
        /{skill.name}
      </span>
      <Tag tone={isSelected ? 'neutral' : 'primary'}>{t('chat.skillMissionTag')}</Tag>
    </button>
  );
}
