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
import { X, Zap } from '../../lib/icons';
import type { Profile } from '../../lib/api';
import type { UserPrompt } from '@greenhouse/types/api';
import { PlantAvatar } from '@greenhouse/ui/components/plant-avatar';
import { profileAvatarProps } from './profile-selector';
import { useLocalized, useT } from '../../lib/i18n';

interface ComposerChipsProps {
  /** Active profile pill (only shown when the user explicitly @-mentioned one). */
  profile?: Profile | null;
  onRemoveProfile?: () => void;
  /** Quick prompt attached to this turn without expanding its body into the textarea. */
  prompt?: UserPrompt | null;
  onRemovePrompt?: () => void;
}

export function ComposerChips({ profile, onRemoveProfile, prompt, onRemovePrompt }: ComposerChipsProps) {
  const t = useT();
  const localized = useLocalized();
  if (!profile && !prompt) return null;
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
            <PlantAvatar {...profileAvatarProps(profile)} size="xs" animate={false} />
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
                aria-label={t('chat.removePrompt', { title: prompt.title })}
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
