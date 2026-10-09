/**
 * Who speaks next — shown only when the speaker changes (the vendored
 * transcript decides; a DM's own Bot never gets one, its title already says
 * who it is): the Bot's plant and its name. The plant shows how the turn is
 * going (`state`: speaking while it types, error when it failed) and only the
 * Bot talking right now moves (`animate`); history is still. Nothing more on screen: the role is one
 * tap away (the profile), and who handed the turn over is the hand-off strip
 * right above — VoiceOver still hears both. A header for VoiceOver (the rotor
 * jumps between speakers); tapping opens the Bot's profile.
 *
 * `bot` undefined while the directory has not answered: a placeholder bar,
 * never "Deleted Bot" (that's for an id the loaded directory doesn't know).
 */

import React, { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useT } from '../../../lib/i18n';
import type { BotView } from '../../../shared/bots';
import { makeStyles, radius, space, typo, useTheme, weight } from '../../../theme';
import { useFontScaleKey } from '../../../ui/font-scale';
import type { PlantStateInput } from '../../../ui/plant-avatar/plant-ids';
import { BotAvatar } from '../../ui/bot-avatar';

export const SpeakerLine = memo(function SpeakerLine({
  bot,
  loaded,
  askedBy,
  state,
  animate = false,
  onPress,
}: {
  bot: BotView | undefined;
  /** The directory has answered (an unknown id is then a deleted Bot). */
  loaded: boolean;
  /** The Bot that handed the turn over (reason `ask`). */
  askedBy?: string | null;
  /** The plant's pose (default idle). */
  state?: PlantStateInput;
  /** The Bot talking right now. */
  animate?: boolean;
  onPress?: (botId: string) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  // keyed on the text size: re-measures when Dynamic Type changes (src/ui/font-scale.ts)
  const fontKey = useFontScaleKey();
  const t = useT();
  const name = bot?.name ?? (loaded ? t('bots.common.deletedBot') : null);
  const meta = [bot?.role.trim(), askedBy ? t('bots.thread.askedBy', { name: askedBy }) : null]
    .filter(Boolean)
    .join(' · ');
  const label = [name, meta].filter(Boolean).join(', ');
  return (
    <Pressable
      key={fontKey}
      onPress={bot && onPress ? () => onPress(bot.id) : undefined}
      disabled={!bot || !onPress}
      accessibilityRole="header"
      accessibilityLabel={label || undefined}
      accessibilityHint={bot && onPress ? t('bots.thread.titleHintDm') : undefined}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <BotAvatar bot={bot ?? null} size={22} state={state} animate={animate} />
      {name ? <Text style={styles.name}>{name}</Text> : <View style={styles.skeleton} />}
    </Pressable>
  );
});

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.sm,
    marginHorizontal: space.margin,
    paddingTop: space.md,
    paddingBottom: space.xxs,
  },
  pressed: { opacity: 0.55 },
  name: { flexShrink: 1, ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  skeleton: { width: 72, height: 12, borderRadius: radius.xs, backgroundColor: c.tertiaryFill },
}));
