/**
 * The thread's footer row: a run that ended in an error — "This reply was
 * interrupted: {reason}", dismissible (nothing retries by itself).
 *
 * Nothing while a run is busy: the title's status line already says it
 * ("Working…", "Thinking…" — D14's static line), so the transcript stays
 * quiet until a Bot has something to show.
 */

import React, { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useT } from '../../../lib/i18n';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme } from '../../../theme';
import { Icon } from '../../../ui/core';

export const RunTail = memo(function RunTail({
  runError,
  onDismissError,
}: {
  runError: string | null;
  onDismissError: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  if (!runError) return null;
  return (
    <View style={styles.wrap}>
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
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  wrap: { paddingHorizontal: space.margin, paddingBottom: space.md },
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
