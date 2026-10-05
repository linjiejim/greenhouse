/**
 * Bot avatars — a Bot's Sprouty, and the stacked roster used for groups.
 *
 * Static by default: SproutyAvatar is a canvas + rAF loop, and lists show many
 * of them. Only the Bot that is speaking right now animates (header roster),
 * so motion always means "this one is talking".
 */

import type { AvatarConfig } from '@greenhouse/types/profile-manifest';
import type { BotView } from '@greenhouse/types/bots';
import { SproutyAvatar, COLOR_PRESETS, LEAF_STYLES, EYE_STYLES } from '../sprouty';
import type { SproutyExpression, SproutySize, SproutyState, LeafStyle, EyeStyle } from '../sprouty';

/** The avatar DSL's face styles → the mascot's resting expression. */
const FACE_EXPRESSION: Record<string, SproutyExpression | undefined> = {
  happy: 'happy',
  sparkle: 'wink',
  sleepy: 'sleep',
};

export function sproutyPropsFor(avatar: AvatarConfig | null | undefined) {
  const config = avatar ?? {};
  const leafStyle = LEAF_STYLES.some((style) => style.id === config.leafStyle)
    ? (config.leafStyle as LeafStyle)
    : undefined;
  // `eyeStyle` is not in the Bot DSL yet, but profile-designed avatars carry it.
  const rawEye = (config as { eyeStyle?: unknown }).eyeStyle;
  const eyeStyle = EYE_STYLES.some((style) => style.id === rawEye) ? (rawEye as EyeStyle) : undefined;
  return {
    variant: 'custom' as const,
    color: config.color && COLOR_PRESETS[config.color] ? config.color : 'forest',
    accessories: config.accessories,
    leafStyle,
    eyeStyle,
    restingExpression: config.faceStyle ? FACE_EXPRESSION[config.faceStyle] : undefined,
  };
}

export function BotAvatar({
  bot,
  avatar,
  size = 'sm',
  speaking = false,
  state,
  className = '',
}: {
  bot?: Pick<BotView, 'avatar' | 'name'> | null;
  /** Explicit config (forms preview an unsaved avatar). */
  avatar?: AvatarConfig;
  size?: SproutySize;
  /** Animate with the responding expression — the one Bot talking right now. */
  speaking?: boolean;
  state?: SproutyState;
  className?: string;
}) {
  const { restingExpression, ...props } = sproutyPropsFor(avatar ?? bot?.avatar);
  const effectiveState: SproutyState = speaking ? 'responding' : (state ?? 'idle');
  return (
    <SproutyAvatar
      {...props}
      state={effectiveState}
      // The resting face is personality; any live state (speaking, error) wins over it.
      expression={!speaking && !state ? restingExpression : undefined}
      size={size}
      animate={speaking}
      className={className}
    />
  );
}

/** Overlapping roster for group rows and headers; the speaking Bot comes to the front and animates. */
export function BotAvatarStack({
  bots,
  max = 3,
  size = 'xs',
  speakingId,
}: {
  bots: Array<Pick<BotView, 'id' | 'avatar' | 'name'>>;
  max?: number;
  size?: SproutySize;
  speakingId?: string | null;
}) {
  const ordered = speakingId
    ? [...bots.filter((bot) => bot.id === speakingId), ...bots.filter((bot) => bot.id !== speakingId)]
    : bots;
  const shown = ordered.slice(0, max);
  const rest = ordered.length - shown.length;
  return (
    <span className="flex flex-shrink-0 items-center">
      {shown.map((bot, index) => (
        <span
          key={bot.id}
          title={bot.name}
          className={`relative inline-flex rounded-full bg-surface-raised ring-2 ring-surface-raised ${index > 0 ? '-ml-2' : ''}`}
          style={{ zIndex: shown.length - index }}
        >
          <BotAvatar bot={bot} size={size} speaking={bot.id === speakingId} />
        </span>
      ))}
      {rest > 0 && (
        <span className="-ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-muted px-1 text-[9px] font-semibold text-fg-muted ring-2 ring-surface-raised">
          +{rest}
        </span>
      )}
    </span>
  );
}
