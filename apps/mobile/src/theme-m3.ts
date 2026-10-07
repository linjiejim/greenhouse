/**
 * Material 3 palette for Android — see ./theme-m3.android.ts. Other platforms
 * keep the iOS-mirrored hex palette, so this is the identity.
 */
import type { HexPalette } from './theme';

export function materialPalette(base: HexPalette, _scheme: 'light' | 'dark', _seed: string): HexPalette {
  return base;
}
