/**
 * The launch splash (app/_layout.tsx), over the app while it starts: the mark
 * builds itself (houses slide in, the seed pops — `MARK_BUILD_MS`), holds a
 * beat, then fades away over the app, which mounted under it as soon as it
 * authenticated. Fonts and the first focused conversation settle under the
 * cover; the latter has a bounded grace period so slow/offline loads still
 * reach the screen's retry UI. It always plays in full (2026-10: a quick sign-in cut it off
 * mid-build); with Reduce Motion the mark is static and the splash leaves as
 * soon as the app is ready.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { typo, useTheme } from '../theme';
import { GreenhouseMark } from './logo';
import { STARTUP_CONTENT_GRACE_MS } from '../startup/content';

/** A beat on the finished mark before the app shows. */
const HOLD_MS = 150;
const FADE_MS = 200;

export function Splash({ ready, contentReady, onGone }: { ready: boolean; contentReady: boolean; onGone: () => void }) {
  const { colors: c } = useTheme();
  const [built, setBuilt] = useState(false);
  const [waitExpired, setWaitExpired] = useState(false);
  const opacity = useRef(new Animated.Value(1)).current;
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  // Slow / failed requests must never hold the user on a logo indefinitely.
  // The deadline does not depend on content changes, so retries cannot extend it.
  useEffect(() => {
    if (!ready || !built) {
      setWaitExpired(false);
      return;
    }
    const timer = setTimeout(() => setWaitExpired(true), STARTUP_CONTENT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [ready, built]);

  const canLeave = ready && built && (contentReady || waitExpired);

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
      <GreenhouseMark size={96} animate onBuilt={() => setBuilt(true)} />
      <Text style={{ ...typo.title2, color: c.label, marginTop: 16 }}>Greenhouse</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({ center: { alignItems: 'center', justifyContent: 'center' } });
