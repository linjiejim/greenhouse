/**
 * useBottomPadStyle — a Reanimated style whose `paddingBottom` follows the
 * keyboard frame-by-frame (true lockstep, like iMessage/WeChat), via
 * react-native-keyboard-controller's `useReanimatedKeyboardAnimation` (driven by
 * WindowInsetsAnimation on Android / the keyboard frame on iOS — far smoother
 * than RN's KeyboardAvoidingView, which under-shifts under edge-to-edge).
 *
 * Apply to a `Animated.View` (from react-native-reanimated) wrapping the screen.
 * `resting` is the closed-keyboard bottom inset (e.g. the safe-area bottom); the
 * padding eases between `resting` and the keyboard height as it animates.
 *
 * Requires <KeyboardProvider> mounted at the app root (see app/_layout.tsx).
 */

import { useAnimatedStyle, type AnimatedStyle } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from './keyboard-controller-compat';
import type { ViewStyle } from 'react-native';

export function useBottomPadStyle(resting = 0): AnimatedStyle<ViewStyle> {
  const { height } = useReanimatedKeyboardAnimation();
  return useAnimatedStyle(() => ({
    paddingBottom: Math.max(Math.abs(height.value), resting),
  }));
}

/**
 * useCollapsingInsetStyle — a `paddingBottom` that eases from `inset` (keyboard
 * closed) to 0 (keyboard open), tracking the keyboard `progress`. Used on the
 * composer bar so its surface clears the gesture bar at rest but sits flush on
 * the keyboard once it's up (pair with `useBottomPadStyle(0)` on the root).
 */
export function useCollapsingInsetStyle(inset: number): AnimatedStyle<ViewStyle> {
  const { progress } = useReanimatedKeyboardAnimation();
  return useAnimatedStyle(() => ({
    paddingBottom: inset * (1 - progress.value),
  }));
}
