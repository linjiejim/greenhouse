/** Launch cover: auth/fonts plus the first focused page, with a bounded content grace.
 * Ready content exits immediately; the short brand animation never holds the page back.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { typo, useTheme } from '../theme';
import { GreenhouseMark } from './logo';
import { STARTUP_CONTENT_GRACE_MS } from '../startup/content';

/** Ready content has no artificial hold. */
const HOLD_MS = 0;
const FADE_MS = 160;

export function Splash({ ready, contentReady, onGone }: { ready: boolean; contentReady: boolean; onGone: () => void }) {
  const { colors: c } = useTheme();
  const [waitExpired, setWaitExpired] = useState(false);
  const opacity = useRef(new Animated.Value(1)).current;
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  // Slow / failed requests must never hold the user on a logo indefinitely.
  // The deadline does not depend on content changes, so retries cannot extend it.
  useEffect(() => {
    if (!ready) {
      setWaitExpired(false);
      return;
    }
    const timer = setTimeout(() => setWaitExpired(true), STARTUP_CONTENT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  const canLeave = ready && (contentReady || waitExpired);

  useEffect(() => {
    if (!canLeave) {
      opacity.setValue(1);
      return;
    }
    const fade = Animated.timing(opacity, { toValue: 0, duration: FADE_MS, delay: HOLD_MS, useNativeDriver: true });
    fade.start(({ finished }) => {
      if (finished) onGoneRef.current();
    });
    return () => fade.stop();
  }, [canLeave, opacity]);

  return (
    <Animated.View
      pointerEvents="auto"
      style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: c.background, opacity }]}
    >
      <GreenhouseMark size={96} animate={!canLeave} />
      <Text style={{ ...typo.title2, color: c.label, marginTop: 16 }}>Greenhouse</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({ center: { alignItems: 'center', justifyContent: 'center' } });
