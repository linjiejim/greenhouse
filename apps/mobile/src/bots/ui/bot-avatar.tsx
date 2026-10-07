/**
 * A Bot's face: its stored avatar resolved to a plant (the web's resolution —
 * `resolvePlantAvatar(avatar, { templateKey, stableId: id })` — so a Bot shows
 * the same species and mood on every surface and client), drawn by the RN
 * `PlantAvatar`.
 *
 * Motion budget (plant-avatar spec §6, web bot-avatar.tsx): lists, rows,
 * pickers and speaker lines pass `animate={false}` — only the Bot speaking
 * right now may move. Decorative: the name is always printed next to it.
 * `bot` null = the directory has not answered yet → a neutral placeholder
 * disc, never "Deleted Bot".
 */

import React, { useMemo } from 'react';
import { View } from 'react-native';
import type { BotView } from '../../shared/bots';
import { useTheme } from '../../theme';
import { PlantAvatar } from '../../ui/plant-avatar/plant-avatar';
import { resolvePlantAvatar, type PlantStateInput } from '../../ui/plant-avatar/plant-ids';

export type AvatarSource = Pick<BotView, 'id' | 'avatar' | 'template_key'>;

export function BotAvatar({
  bot,
  size,
  state,
  animate,
}: {
  bot: AvatarSource | null;
  size: number;
  /** idle (default) | thinking | speaking | waiting | sleep (archived) … or a product alias. */
  state?: PlantStateInput;
  /** Default: PlantAvatar's (thinking nods; hero sizes breathe). Lists pass false. */
  animate?: boolean;
}) {
  const { colors: c } = useTheme();
  const avatar = bot?.avatar;
  const templateKey = bot?.template_key;
  const id = bot?.id;
  const resolved = useMemo(
    () => (id === undefined ? null : resolvePlantAvatar(avatar, { templateKey, stableId: id })),
    [avatar, templateKey, id],
  );
  if (!resolved) {
    return (
      <View
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.tertiaryFill }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
    );
  }
  return <PlantAvatar plant={resolved.plant} mood={resolved.mood} state={state} size={size} animate={animate} />;
}
