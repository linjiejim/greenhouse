/**
 * How far a screen's content must start below the top edge to clear its
 * navigation bar. iOS: the bar is transparent glass and content scrolls under
 * it, so this is the header height. Android: the bar is an opaque Material top
 * app bar and content already starts below it, so 0. Use it wherever content
 * is offset by hand (padding, centring, "is the title under the bar" checks)
 * instead of `useHeaderHeight()`.
 */
import { Platform } from 'react-native';
import { useHeaderHeight } from 'expo-router/react-navigation';

export function useHeaderInset(): number {
  const height = useHeaderHeight();
  return Platform.OS === 'ios' ? height : 0;
}
