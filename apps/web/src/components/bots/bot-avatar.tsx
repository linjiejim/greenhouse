/**
 * Bot avatars — a Bot's plant, and the stacked roster a retired group chat shows.
 *
 * Thin adapters over `<PlantAvatar/>` / `<PlantAvatarStack/>` that pass the
 * Bot's identity (stored avatar + template key + id), so a Bot resolves to the
 * same plant on every surface and its loop phase never syncs with another Bot's.
 *
 * Animation budget (plant-avatar spec §6): static by default — lists, rows,
 * pickers and speaker headers never move. Only the Bot that is speaking right
 * now animates, so motion always means "this one is talking"; when it stops it
 * morphs back to idle before going static.
 */

import type { AvatarConfig } from '@greenhouse/types/profile-manifest';
import type { PlantStateInput } from '@greenhouse/types';
import type { BotView } from '@greenhouse/types/bots';
import {
  PlantAvatar,
  PlantAvatarStack,
  usePlantSettling,
  type PlantAvatarSize,
  type PlantAvatarStackItem,
} from '@greenhouse/ui/components/plant-avatar';

type BotIdentity = Partial<Pick<BotView, 'id' | 'avatar' | 'template_key'>>;

export function BotAvatar({
  bot,
  avatar,
  templateKey,
  size = 'sm',
  speaking = false,
  state,
  animate,
  label,
  className,
}: {
  bot?: BotIdentity | null;
  /** Explicit config (forms preview an unsaved avatar); wins over `bot.avatar`. */
  avatar?: AvatarConfig;
  /** Template of an unsaved Bot (gallery cards, drafts); defaults to `bot.template_key`. */
  templateKey?: string | null;
  size?: PlantAvatarSize;
  /** The one Bot talking right now: loops `speaking`, then morphs back to idle. */
  speaking?: boolean;
  state?: PlantStateInput;
  /** Default: only while speaking (and hero sizes ≥ 80px, which play a capped idle). */
  animate?: boolean;
  /** Full localised name; omit when the row prints the Bot's name. */
  label?: string;
  className?: string;
}) {
  const live = usePlantSettling(speaking);
  return (
    <PlantAvatar
      avatar={avatar ?? bot?.avatar ?? null}
      templateKey={templateKey ?? bot?.template_key ?? null}
      stableId={bot?.id}
      state={speaking ? 'speaking' : (state ?? 'idle')}
      size={size}
      animate={animate ?? (live || undefined)}
      label={label}
      className={className}
    />
  );
}

/**
 * Overlapping roster (a retired group chat's row, header and intro); the speaking Bot comes to
 * the front and animates.
 */
export function BotAvatarStack({
  bots,
  max = 3,
  size = 'xs',
  speakingId,
  className,
  ringClassName,
}: {
  bots: ReadonlyArray<Pick<BotView, 'id' | 'avatar' | 'name'> & Partial<Pick<BotView, 'template_key'>>>;
  max?: number;
  size?: PlantAvatarSize;
  speakingId?: string | null;
  className?: string;
  /** Ring separating overlapped chips; match the row background (see PlantAvatarStack). */
  ringClassName?: string;
}) {
  const items: PlantAvatarStackItem[] = bots.map((bot) => ({
    id: bot.id,
    avatar: bot.avatar,
    templateKey: bot.template_key ?? null,
    name: bot.name,
  }));
  return (
    <PlantAvatarStack
      items={items}
      max={max}
      size={size}
      speakingId={speakingId}
      className={className}
      ringClassName={ringClassName}
    />
  );
}
