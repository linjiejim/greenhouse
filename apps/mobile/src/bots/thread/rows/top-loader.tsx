/**
 * The top of a thread with more history above (D15): earlier pages load by
 * themselves as the member scrolls near the top — a small spinner meanwhile;
 * a failure says so and retries on a tap; after a run of automatic pages the
 * next one waits for a button (the transcript isn't virtualised, so it grows
 * on purpose, not by a long fling).
 */

import React, { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useT } from '../../../lib/i18n';
import { HIT, makeStyles, space, typo, useTheme } from '../../../theme';
import { NativeButton } from '../../../ui/button';
import { Spinner } from '../../../ui/core';

export const TopLoader = memo(function TopLoader({
  state,
  manual,
  onLoad,
}: {
  state: 'idle' | 'loading' | 'error';
  /** Automatic paging paused: offer the button. */
  manual: boolean;
  onLoad: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <View style={styles.wrap}>
      {state === 'loading' ? (
        <Spinner />
      ) : state === 'error' ? (
        <Pressable
          onPress={onLoad}
          accessibilityRole="button"
          style={({ pressed }) => [styles.tap, pressed && styles.pressed]}
        >
          <Text style={styles.text}>{t('bots.thread.earlierFailed')}</Text>
        </Pressable>
      ) : manual ? (
        <NativeButton label={t('bots.thread.loadEarlier')} size="small" onPress={onLoad} />
      ) : null}
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  // keeps its height while idle: the content below doesn't jump when the spinner comes and goes
  wrap: { minHeight: HIT, alignItems: 'center', justifyContent: 'center', paddingVertical: space.sm },
  tap: { minHeight: HIT, justifyContent: 'center', paddingHorizontal: space.lg },
  text: { ...typo.footnote, color: c.secondaryLabel, textAlign: 'center' },
  pressed: { opacity: 0.55 },
}));
