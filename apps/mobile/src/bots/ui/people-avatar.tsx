/**
 * People in a room (P5) as initials — where a plant would stand for an Agent (an Agent's identity is
 * its plant, a person's is their initial — src/ui/avatar.tsx): one disc for one person (a private
 * chat: the other one), else the first `max` overlapped like `AvatarStack`, each wearing the colour
 * that person wears everywhere (../rooms.ts `personTint`). Decorative: the row or title prints the
 * names.
 */

import React from 'react';
import { View, type ColorValue } from 'react-native';
import { useTheme } from '../../theme';
import { InitialAvatar } from '../../ui/avatar';
import { personTint } from '../rooms';

/** Ring width around each overlapped disc (pt) — the same as `AvatarStack`'s. */
const RING = 1.5;

export interface PersonFace {
  id: string;
  name: string;
}

export function PeopleAvatar({
  people,
  size,
  max = 2,
  ring,
}: {
  people: readonly PersonFace[];
  size: number;
  max?: number;
  /** The surface behind the stack (default `background`); null = no ring. */
  ring?: ColorValue | null;
}) {
  const { colors: c } = useTheme();
  const shown = people.slice(0, Math.max(1, max));
  if (shown.length <= 1) {
    const person = shown[0];
    return (
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <InitialAvatar name={person?.name ?? '?'} size={size} tint={person ? c[personTint(person.id)] : c.gray} />
      </View>
    );
  }
  // Overlapped discs are a little smaller, so two fit where one would.
  const disc = Math.round(size * 0.72);
  const overlap = Math.round(disc / 3);
  const ringColor = ring === undefined ? c.background : ring;
  const outer = disc + (ringColor ? RING * 2 : 0);
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center' }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {shown.map((person, index) => (
        <View
          key={person.id}
          style={[
            ringColor
              ? { borderWidth: RING, borderColor: ringColor, borderRadius: outer / 2, backgroundColor: ringColor }
              : null,
            { zIndex: shown.length - index, marginLeft: index > 0 ? -overlap : 0 },
          ]}
        >
          <InitialAvatar name={person.name} size={disc} tint={c[personTint(person.id)]} />
        </View>
      ))}
    </View>
  );
}
