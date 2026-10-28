/**
 * Android-only (imported by `*.android.tsx` files): Jetpack Compose theming.
 *
 *  - `M3Host` — a Compose `Host` themed like the rest of the app: the in-app
 *    color scheme and the Material 3 palette seeded from the brand Teal (the
 *    palette src/theme-m3.android.ts backs the RN tokens with, so Compose and
 *    RN surfaces match, and the brand wins over the wallpaper's colors).
 *  - `useM3()` — that palette's full color roles, for Compose `colors` props.
 *
 * Use these instead of a bare `Host` so no Compose island falls back to the
 * baseline purple or the wallpaper palette.
 */

import React from 'react';
import { Host, useMaterialColors, type MaterialColors } from '@expo/ui/jetpack-compose';
import { SEED, useTheme } from '../theme';

type HostProps = React.ComponentProps<typeof Host>;

export function M3Host({ children, ...props }: Omit<HostProps, 'colorScheme' | 'seedColor'>) {
  const { isDark } = useTheme();
  return (
    <Host colorScheme={isDark ? 'dark' : 'light'} seedColor={SEED} {...props}>
      {children}
    </Host>
  );
}

export function useM3(): MaterialColors {
  const { isDark } = useTheme();
  return useMaterialColors({ colorScheme: isDark ? 'dark' : 'light', seedColor: SEED });
}
