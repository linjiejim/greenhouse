/**
 * GreenhouseMark — the brand house-with-sprout mark as an inline SVG, tinted
 * with the theme accent. Canonical geometry: logos/greenhouse-mark.svg (keep in
 * sync if the brand mark changes). Used on the login screen in place of the
 * Sprouty mascot; pass `color` to override the accent tint.
 */

import React from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { useTheme } from '../theme';

const PATHS =
  '<path d="M22 104 L22 56 L65 22 L108 56 L108 104 Z"/>' +
  '<path d="M22 56 L108 56"/>' +
  '<path d="M44 56 L44 104"/>' +
  '<path d="M86 56 L86 104"/>' +
  '<path d="M65 104 L65 84"/>' +
  '<path d="M65 84 C69 78 74 75 76 65 C72 69 67 77 65 84 Z"/>' +
  '<path d="M65 84 C61 78 56 75 54 65 C58 69 63 77 65 84 Z"/>';

function markSvg(color: string): string {
  return (
    `<svg viewBox="9 7 112 112" xmlns="http://www.w3.org/2000/svg">` +
    `<g fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${PATHS}</g>` +
    `</svg>`
  );
}

/** Greenhouse brand mark (house + sprout), accent-tinted. */
export function GreenhouseMark({ size = 72, color }: { size?: number; color?: string }) {
  const { colors: c } = useTheme();
  return (
    <View style={{ width: size, height: size }}>
      <SvgXml xml={markSvg(color ?? c.accent)} width="100%" height="100%" />
    </View>
  );
}
