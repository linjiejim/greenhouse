/**
 * The thread's footer row:
 *  - "Working…" — the server is busy for this thread but this device has no
 *    stream to show (another API slot holds the run, or it's between turns):
 *    a still plant and a static line, never a fake "typing" (D14);
 *  - a run that ended in an error — "This reply was interrupted: {reason}",
 *    dismissible (nothing retries by itself).
 */

import React, { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useT } from '../../../lib/i18n';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme } from '../../../theme';
import { Icon } from '../../../ui/core';
import { BotAvatar, type AvatarSource } from '../../ui/bot-avatar';

export const RunTail = memo(function RunTail({
  working,
  bot,
  runError,
  onDismissError,
}: {
  working: boolean;
  /** Who is presumably at work (the DM's Bot, a group's lead). */
  bot: AvatarSource | null;
  runError: string | null;
  onDismissError: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  if (!working && !runError) return null;
  return (
    <View style={styles.wrap}>
      {working ? (
        <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)} style={styles.working}>
          <BotAvatar bot={bot} size={28} state="waiting" animate={false} />
          <Text style={styles.workingText}>{t('bots.thread.working')}</Text>
        </Animated.View>
      ) : null}
      {runError ? (
        <View style={styles.error}>
          <Icon name="alert" size={15} weight="semibold" color={c.red} />
          <Text style={styles.errorText} selectable>
            {t('bots.thread.runFailed', { reason: runError })}
          </Text>
          <Pressable
            onPress={onDismissError}
            hitSlop={(HIT - 20) / 2}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Icon name="x" size={13} weight="semibold" color={c.red} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  wrap: { paddingHorizontal: space.margin, paddingBottom: space.md, gap: space.sm },
  working: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  workingText: { ...typo.subheadline, color: c.secondaryLabel },
  error: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: c.redFill,
    ...squircle,
  },
  errorText: { flex: 1, ...typo.footnote, color: c.red },
  pressed: { opacity: 0.55 },
}));
