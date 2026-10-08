/**
 * Android speaks Material 3: the theme tokens are backed by the M3 color roles
 * of a tonal palette seeded from Haven forest green — the same palette every
 * Compose `Host` in the app is themed with (`seedColor`), so RN surfaces and
 * native Material components match exactly (and follow the brand, not the
 * wallpaper). Grouped lists follow @expo/ui's `FieldGroup`: rows on
 * `surfaceContainer` over a `surface` page, as in Android Settings.
 */
import { getMaterialColors } from '@expo/ui/jetpack-compose';
import type { HexPalette } from './theme';

export function materialPalette(base: HexPalette, scheme: 'light' | 'dark', seed: string): HexPalette {
  const m = getMaterialColors({ scheme, seedColor: seed });
  return {
    ...base,
    accent: m.primary,
    onAccent: m.onPrimary,
    accentFill: m.primaryContainer,
    accentText: m.onPrimaryContainer,
    link: m.primary,
    background: m.surface,
    secondaryBackground: m.surfaceContainer,
    tertiaryBackground: m.surfaceContainerHigh,
    groupedBackground: m.surface,
    secondaryGroupedBackground: m.surfaceContainer,
    tertiaryGroupedBackground: m.surfaceContainerHigh,
    label: m.onSurface,
    secondaryLabel: m.onSurfaceVariant,
    tertiaryLabel: m.outline,
    quaternaryLabel: m.outlineVariant,
    placeholder: m.onSurfaceVariant,
    separator: m.outlineVariant,
    opaqueSeparator: m.outlineVariant,
    fill: m.surfaceContainerHighest,
    secondaryFill: m.surfaceContainerHigh,
    tertiaryFill: m.surfaceContainerHigh,
    quaternaryFill: m.surfaceContainer,
    red: m.error,
    redFill: m.errorContainer,
    bubble: m.surfaceContainerHigh,
  };
}
