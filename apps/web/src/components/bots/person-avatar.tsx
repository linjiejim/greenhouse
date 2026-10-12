/**
 * A person in a room (spec 20261011-agent-first-class P5): their initial in a round chip, sized
 * like the plant avatars beside it (24 / 32 / 48 / 80 px) so people and Agents line up in one
 * row. People never get a plant — the plant is how an Agent looks.
 */

const SIZES = {
  xs: 'h-6 w-6 text-[10px]',
  sm: 'h-8 w-8 text-xs',
  md: 'h-12 w-12 text-base',
  lg: 'h-20 w-20 text-2xl',
} as const;

export type PersonAvatarSize = keyof typeof SIZES;

function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toLocaleUpperCase() : '?';
}

export function PersonAvatar({
  name,
  size = 'sm',
  className = '',
}: {
  name: string;
  size?: PersonAvatarSize;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex flex-shrink-0 select-none items-center justify-center rounded-full bg-surface-muted font-semibold text-fg-secondary ${SIZES[size]} ${className}`}
      aria-hidden="true"
      data-testid="person-avatar"
    >
      {initialOf(name)}
    </span>
  );
}

/**
 * Overlapped initials for a room's people. `ringClassName` must match the surface the stack sits
 * on in every state (the same rule as `BotAvatarStack`), or each chip shows a halo.
 */
export function PeopleAvatarStack({
  names,
  max = 3,
  size = 'xs',
  ringClassName = 'ring-surface-raised',
}: {
  names: readonly string[];
  max?: number;
  size?: PersonAvatarSize;
  ringClassName?: string;
}) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className="inline-flex items-center -space-x-1.5" aria-hidden="true">
      {shown.map((name, index) => (
        <PersonAvatar key={`${name}:${index}`} name={name} size={size} className={`ring-2 ${ringClassName}`} />
      ))}
      {extra > 0 && (
        <span
          className={`inline-flex flex-shrink-0 items-center justify-center rounded-full bg-surface-sunken font-medium text-fg-muted ring-2 ${ringClassName} ${SIZES[size]}`}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
