/**
 * Stop for a Bots run (D8 — the web's two-step stop, bots-composer.tsx): the
 * composer draws it between the input capsule and Send, only while a run is
 * live, so the input never locks and Send never moves. This module decides
 * what it is and does:
 *
 *  | phase   | when                                      | tap           | long press (UIMenu)        |
 *  | running | a run, no stop asked                      | soft (light)  | after this step / stop now |
 *  | soft    | a soft stop asked (or `run-interrupting`) | hard (medium) | stop now                   |
 *  | hard    | stopping now                              | — (spinner)   | —                          |
 *
 * VoiceOver hears what a tap would do. While a soft stop is on its way the
 * accessory slot shows `StopHint` ("Stopping after this step · Tap again to
 * stop now"). Haptics live here — the composer stays a pure view.
 */

import React, { memo, useMemo } from 'react';
import { Text } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import type { ComposerStop } from '../../chat/composer';
import { useT } from '../../lib/i18n';
import { HIT, makeStyles, space, typo, useTheme } from '../../theme';
import { Icon } from '../../ui/core';
import { Glass } from '../../ui/glass';
import { tapLight, tapMedium } from '../../ui/haptics';
import type { ThreadController, ThreadSnapshot } from '../contract';

export function stopPhase(snap: Pick<ThreadSnapshot, 'runActive' | 'stopPhase' | 'run'>): ComposerStop['phase'] | null {
  if (!snap.runActive && !snap.stopPhase) return null;
  if (snap.stopPhase === 'hard') return 'hard';
  if (snap.stopPhase === 'soft' || snap.run?.interrupting) return 'soft';
  return 'running';
}

/** The composer's `stop` prop (undefined = no run, no Stop). Stable while the phase holds. */
export function useComposerStop(
  snap: Pick<ThreadSnapshot, 'runActive' | 'stopPhase' | 'run'>,
  ctl: ThreadController,
): ComposerStop | undefined {
  const t = useT();
  const phase = stopPhase(snap);
  return useMemo<ComposerStop | undefined>(() => {
    if (!phase) return undefined;
    return {
      phase,
      onPress: () => {
        if (phase === 'hard') return;
        // a tap: soft first, then hard
        if (phase === 'running') tapLight();
        else tapMedium();
        ctl.stop('next');
      },
      onMenu: (choice) => {
        if (choice === 'soft') tapLight();
        else tapMedium();
        ctl.stop(choice);
      },
      accessibilityLabel:
        phase === 'running'
          ? t('bots.stop.a11yRunning')
          : phase === 'soft'
            ? t('bots.stop.a11ySoft')
            : t('bots.stop.a11yHard'),
      menuLabels: { soft: t('bots.stop.afterStep'), hard: t('bots.stop.now') },
    };
  }, [phase, ctl, t]);
}

/** "Stopping after this step · Tap again to stop now" — above the input row while a soft stop is on its way. */
export const StopHint = memo(function StopHint() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={styles.wrap}>
      <Glass style={styles.capsule}>
        <Icon name="stopCircle" size={14} weight="medium" color={c.secondaryLabel} />
        <Text style={styles.text} accessibilityLiveRegion="polite">
          {t('bots.stop.hint')}
        </Text>
      </Glass>
    </Animated.View>
  );
});

const useStyles = makeStyles((c) => ({
  wrap: { alignItems: 'center' },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    minHeight: HIT - 10,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: (HIT - 10) / 2,
  },
  text: { flexShrink: 1, ...typo.footnote, color: c.secondaryLabel },
}));
