/**
 * Avatars. `InitialAvatar` is a filled circle with the first letter of a name
 * (accounts, members, assignees); the AI's identity is the Sprouty mascot
 * (src/ui/sprouty.tsx), never a letter.
 */

import React from 'react';
import { Text, View, type ColorValue } from 'react-native';
import { useTheme, weight } from '../theme';

export function InitialAvatar({
  name,
  size = 34,
  tint,
}: {
  name: string;
  size?: number;
  /** Fill color; defaults to the accent. Use system colors (`c.gray`…) for non-accent fills. */
  tint?: ColorValue;
}) {
  const { colors: c, hex } = useTheme();
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  // the accent gets its own readable foreground (dark on the bright dark-mode teal)
  const onAccent = !tint || tint === c.accent || tint === hex.accent;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: tint ?? c.accent,
        alignItems: 'center',
        justifyContent: 'center',
      }}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Text style={{ fontSize: Math.round(size * 0.44), fontWeight: weight.semibold, color: onAccent ? c.onAccent : c.onTint }}>
        {letter}
      </Text>
    </View>
  );
}
