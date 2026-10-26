/** Browser surfaces use the shared semantic colors instead of UIKit's grouped fills. */
import { lightHex as nativeLight, darkHex as nativeDark, type HexPalette } from './palette';
import { webColors } from './web-colors.generated';
export type { HexPalette } from './palette';
function palette(native: HexPalette, mode: 'light' | 'dark'): HexPalette {
  const c = webColors[mode];
  return {
    ...native,
    background: c.canvas,
    secondaryBackground: c.chrome,
    tertiaryBackground: c.raised,
    groupedBackground: c.chrome,
    secondaryGroupedBackground: c.raised,
    tertiaryGroupedBackground: c.surface,
    sidebarBackground: c.deep,
    fill: c.fill,
    separator: c.line,
    opaqueSeparator: c.lineStrong,
    scrim: c.scrim,
  };
}
export const lightHex = palette(nativeLight, 'light');
export const darkHex = palette(nativeDark, 'dark');
