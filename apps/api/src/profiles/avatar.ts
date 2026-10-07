/**
 * Custom-Agent avatar JSON → the `ProfileAvatar` the profile routes store and return.
 *
 * Custom-profile avatars were stored raw for a long time, and version rows are
 * immutable and hashed into `manifest_hash`, so they are never rewritten. This
 * one tolerant normaliser reads every era and bounds every new write. Each key
 * is kept on its own when it passes its `avatarConfigSchema` field, so one bad
 * value never costs the Agent its plant. Unknown keys are dropped. The legacy
 * `leafStyle` / `eyeStyle` keep only the ids the old editor wrote. Turning the
 * result into a plant is `legacyToPlant` (`@greenhouse/types/plant-avatar`) at
 * render time — and on fork, where the source's rendered plant is pinned.
 */

import type { ProfileAvatar } from '@greenhouse/types/api';
import { avatarConfigSchema } from '@greenhouse/types/profile-manifest';

const FIELD = avatarConfigSchema.shape;
const ACCESSORY = FIELD.accessories.unwrap().element;
/** Same cap as `avatarConfigSchema.accessories`. Accessories are no longer drawn, only kept for rollback. */
const MAX_ACCESSORIES = 10;
const LEAF_STYLES = ['normal', 'big', 'mini', 'double'] as const;
const EYE_STYLES = ['classic', 'dot', 'soft', 'focused'] as const;

function oneOf<T extends string>(ids: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (ids as readonly string[]).includes(value);
}

function text(field: 'plant' | 'mood' | 'color' | 'faceStyle', value: unknown): string | undefined {
  const parsed = FIELD[field].safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function normalizeProfileAvatar(raw: unknown): ProfileAvatar {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const avatar = raw as Record<string, unknown>;
  const plant = text('plant', avatar.plant);
  const mood = text('mood', avatar.mood);
  const color = text('color', avatar.color);
  const faceStyle = text('faceStyle', avatar.faceStyle);
  const accessories = Array.isArray(avatar.accessories)
    ? avatar.accessories.filter((item): item is string => ACCESSORY.safeParse(item).success).slice(0, MAX_ACCESSORIES)
    : undefined;
  const palette = FIELD.palette.safeParse(avatar.palette);
  return {
    ...(plant !== undefined ? { plant } : {}),
    ...(mood !== undefined ? { mood } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(accessories ? { accessories } : {}),
    ...(oneOf(LEAF_STYLES, avatar.leafStyle) ? { leafStyle: avatar.leafStyle } : {}),
    ...(oneOf(EYE_STYLES, avatar.eyeStyle) ? { eyeStyle: avatar.eyeStyle } : {}),
    ...(faceStyle !== undefined ? { faceStyle } : {}),
    ...(palette.success && palette.data ? { palette: palette.data } : {}),
  };
}
