/**
 * A Bot's face: its stored avatar resolved to a plant (the web's resolution —
 * `resolvePlantAvatar(avatar, { templateKey, stableId: id })` — so a Bot shows
 * the same species and colour on every surface and client), drawn by the RN
 * `PlantAvatar`.
 *
 * Motion budget (plant-avatar spec §6, src/ui/plant-avatar/plant-avatar-native.ts):
 * the avatars that stand for a Bot being here — a DM's title, the thread's
 * start, a profile, the Bot talking right now — pass `animate` and play their
 * state (an idle float every few seconds, thinking's nod, speaking's stretch,
 * waiting's lean, …); lists, rows and pickers pass `animate={false}` and only
 * change face. The float is offset by the Bot's id, so two never move in
 * step. Decorative: the name is always printed next to it.
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
  /** Play the state's motion. Default: PlantAvatar's (thinking nods; hero sizes float). Lists pass false. */
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
  return (
    <PlantAvatar plant={resolved.plant} tint={resolved.tint} state={state} size={size} animate={animate} seed={id} />
  );
}
