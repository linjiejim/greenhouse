/**
 * ComposerChips — the pill/tag bar inside the chat composer.
 *
 * Visualises the agent profile selected via `@`. The pill is removable; removing
 * reverts the underlying selection state. Renders nothing when there is no
 * selection.
 *
 * Lives above the textarea inside the composer card (same region as the image
 * preview row), so selections read as "attached to this message".
 */

import React from 'react';
import { X } from '../../lib/icons';
import type { Profile } from '../../lib/api';
import { SproutyAvatar } from '../sprouty/index.js';
import { profileToSprouty } from './profile-selector';

interface ComposerChipsProps {
  /** Active profile pill (only shown when the user explicitly @-mentioned one). */
  profile?: Profile | null;
  onRemoveProfile?: () => void;
  /** Extra chips rendered after the profile pill (e.g. the session-context trigger). */
  extra?: React.ReactNode;
}

export function ComposerChips({ profile, onRemoveProfile, extra }: ComposerChipsProps) {
  const hasAny = !!profile || !!extra;
  if (!hasAny) return null;

  return (
    <div className="px-3 pt-3 pb-1 flex flex-wrap items-center gap-1.5">
      {profile && (
        <Pill onRemove={onRemoveProfile} label={profile.name} title={`Agent: ${profile.name}`}>
          <SproutyAvatar {...profileToSprouty(profile)} state="idle" size="xs" animate={false} />
        </Pill>
      )}
      {extra}
    </div>
  );
}

function Pill({
  children,
  label,
  title,
  onRemove,
}: {
  children: React.ReactNode;
  label: string;
  title?: string;
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
          aria-label={`Remove ${label}`}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}
