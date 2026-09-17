/**
 * ComposerChips — the pill/tag bar inside the chat composer.
 *
 * Visualises structured composer context selected via `@` and `/`. Pills stay
 * compact while their details remain available on hover/focus.
 *
 * Lives above the textarea inside the composer card (same region as the image
 * preview row), so selections read as "attached to this message".
 */

import React from 'react';
import { Cloud, Sparkles, X, Zap } from '../../lib/icons';
import type { Profile } from '../../lib/api';
import type { UserPrompt } from '@greenhouse/types/api';
import type { SlashSkill } from './command-menu-popover';
import { SproutyAvatar } from '../sprouty/index.js';
import { profileToSprouty } from './profile-avatar';
import { useLocalized, useT } from '../../lib/i18n';
import { Tag } from '../ui';

interface ComposerChipsProps {
  /** Active profile pill (only shown when the user explicitly @-mentioned one). */
  profile?: Profile | null;
  onRemoveProfile?: () => void;
  /** Quick prompt attached to this turn without expanding its body into the textarea. */
  prompt?: UserPrompt | null;
  onRemovePrompt?: () => void;
  /** Skill attached to this draft — sending launches a Cloud Agent mission. */
  skill?: SlashSkill | null;
  onRemoveSkill?: () => void;
  /** Explicit route for the next composer send to continue a Mission. */
  missionInstruction?: boolean;
  onRemoveMissionInstruction?: () => void;
}

export function ComposerChips({
  profile,
  onRemoveProfile,
  prompt,
  onRemovePrompt,
  skill,
  onRemoveSkill,
  missionInstruction,
  onRemoveMissionInstruction,
}: ComposerChipsProps) {
  const t = useT();
  const localized = useLocalized();
  if (!profile && !prompt && !skill && !missionInstruction) return null;
  const profileLabel = profile ? localized(profile.name_i18n, profile.name) : '';

  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2 pt-3">
      {profile && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill
            onRemove={onRemoveProfile}
            label={profileLabel}
            title={t('chat.agentChipTitle', { name: profileLabel })}
            removeLabel={t('chat.removeAgent', { name: profileLabel })}
          >
            <SproutyAvatar {...profileToSprouty(profile)} state="idle" size="xs" animate={false} />
          </Pill>
        </div>
      )}
      {prompt && (
        <span className="group relative block min-w-0" tabIndex={0} data-selected-task>
          <span className="flex w-full items-center gap-2 rounded-lg border border-edge bg-surface-muted px-2.5 py-2 text-left text-xs font-medium text-fg-secondary">
            <Zap size={12} className="flex-shrink-0 text-primary-fg" />
            <span className="min-w-0 flex-1 truncate" title={prompt.title}>
              {prompt.title}
            </span>
            {onRemovePrompt && (
              <button
                type="button"
                onClick={onRemovePrompt}
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
                aria-label={t('chat.removeTask', { title: prompt.title })}
              >
                <X size={12} />
              </button>
            )}
          </span>
          <span
            role="tooltip"
            className="pointer-events-none absolute bottom-full left-0 z-40 mb-2 hidden max-h-40 w-max min-w-56 max-w-[min(28rem,calc(100vw-2rem))] overflow-y-auto whitespace-pre-wrap rounded-lg border border-edge bg-surface-raised px-3 py-2 text-left text-xs font-normal leading-relaxed text-fg-secondary shadow-lg group-hover:block group-focus-within:block"
          >
            <span className="mb-1 block font-medium text-fg">{prompt.title}</span>
            {prompt.content}
          </span>
        </span>
      )}
      {skill && (
        <span className="group relative block min-w-0" tabIndex={0} data-selected-skill>
          <span className="flex w-full items-center gap-2 rounded-lg border border-edge bg-surface-muted px-2.5 py-2 text-left text-xs font-medium text-fg-secondary">
            <Sparkles size={12} className="flex-shrink-0 text-primary-fg" />
            <span className="min-w-0 flex-1 truncate" title={skill.display_name}>
              {skill.display_name}
            </span>
            <Tag tone="primary">{t('chat.skillMissionTag')}</Tag>
            {onRemoveSkill && (
              <button
                type="button"
                onClick={onRemoveSkill}
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
                aria-label={t('chat.removeSkill', { name: skill.display_name })}
              >
                <X size={12} />
              </button>
            )}
          </span>
          {skill.description && (
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-0 z-40 mb-2 hidden max-h-40 w-max min-w-56 max-w-[min(28rem,calc(100vw-2rem))] overflow-y-auto whitespace-pre-wrap rounded-lg border border-edge bg-surface-raised px-3 py-2 text-left text-xs font-normal leading-relaxed text-fg-secondary shadow-lg group-hover:block group-focus-within:block"
            >
              <span className="mb-1 block font-medium text-fg">{skill.display_name}</span>
              {skill.description}
            </span>
          )}
        </span>
      )}
      {missionInstruction && (
        <span className="block min-w-0" data-mission-instruction>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary-edge bg-primary-subtle px-2 py-1 text-xs font-medium text-primary-fg-strong">
            <Cloud size={12} className="flex-shrink-0" />
            <span>{t('chat.skillMissionTag')}</span>
            {onRemoveMissionInstruction && (
              <button
                type="button"
                onClick={onRemoveMissionInstruction}
                className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-primary-fg transition-colors hover:bg-primary-edge/40 hover:text-primary-fg-strong"
                aria-label={t('cloudAgent.removeMissionInstruction')}
              >
                <X size={11} />
              </button>
            )}
          </span>
        </span>
      )}
    </div>
  );
}

function Pill({
  children,
  label,
  title,
  removeLabel,
  onRemove,
}: {
  children: React.ReactNode;
  label: string;
  title?: string;
  removeLabel?: string;
  onRemove?: () => void;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 max-w-[180px] rounded-full border border-primary-edge bg-primary-subtle pl-1.5 pr-1 py-0.5 text-xs font-medium text-primary-fg-strong"
    >
      {children}
      <span className="truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-primary-fg hover:bg-primary-edge/40 transition-colors"
          aria-label={removeLabel ?? `Remove ${label}`}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}
