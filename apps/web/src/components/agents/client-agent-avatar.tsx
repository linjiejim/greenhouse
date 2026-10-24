/**
 * A member's connected agent (an MCP / OAuth client) as a plant: the connection's own
 * `avatar {plant, tint}` when the API carries one, else a deterministic pick by client name
 * (`plantForClient`: Claude Code → fern, Codex → opuntia, Cursor → clover, others hashed).
 * People never use this — they keep initials (`<Avatar>`), so a person and an agent never
 * look alike.
 */

import { PlantAvatar, type PlantAvatarSize } from '@greenhouse/ui/components/plant-avatar';
import { plantForClient } from '@greenhouse/types';

export interface ClientAgentAvatarProps {
  /** The client's display name (`client_name`). */
  name: string | null | undefined;
  /** `avatar` from the connection, when the API exposes one (`{ plant?, tint? }`). */
  avatar?: unknown;
  size?: PlantAvatarSize;
  /** Accessible name; omit when the row already prints the client name. */
  label?: string;
  className?: string;
}

/** Read an optional `avatar` field off an API object without widening its type. */
export function connectionAvatar(source: unknown): unknown {
  return source && typeof source === 'object' ? (source as { avatar?: unknown }).avatar : undefined;
}

export function ClientAgentAvatar({ name, avatar, size = 'xs', label, className }: ClientAgentAvatarProps) {
  const { plant, tint } = plantForClient(name, avatar);
  return (
    <PlantAvatar
      plant={plant}
      avatar={{ tint }}
      stableId={`client:${name ?? ''}`}
      size={size}
      animate={false}
      label={label}
      className={className}
    />
  );
}
