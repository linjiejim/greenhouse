import { font } from '@expo/ui/swift-ui/modifiers';
import { typo } from '../theme';

/** Preserve SwiftUI text-style/Dynamic Type semantics while choosing the brand face. */
export function brandFont(options: Parameters<typeof font>[0] = {}) {
  if (options.design === 'monospaced') return font(options);
  const textStyle = options.textStyle ?? 'body';
  const role = textStyle === 'title' ? 'title1' : textStyle === 'caption' ? 'caption1' : textStyle;
  const style = typo[role];
  const weight =
    options.weight ?? (style.fontWeight === '700' ? 'bold' : style.fontWeight === '600' ? 'semibold' : 'regular');
  const face =
    weight === 'bold' || weight === 'heavy' || weight === 'black'
      ? 'Bold'
      : weight === 'semibold'
        ? 'SemiBold'
        : weight === 'medium'
          ? 'Medium'
          : 'Regular';
  // Expo's custom-family branch otherwise uses 17pt for every textStyle.
  // Keep both the original base size and SwiftUI's relativeTo scaling role.
  return font({ textStyle, family: `Nunito-${face}`, size: style.fontSize, weight, ...options });
}
