/** One rail entry (design system RailItem): icon over a short label, accent pill when selected. */
import React from 'react';
import { Pressable, Text } from 'react-native';
import { typo, useTheme } from '../theme';
import { Icon, type IconName } from './core';

/** The 72-wide rail leaves ~62 for a label at the rail's small type. */
const LABEL = { fontSize: 11, lineHeight: 14, fontWeight: '600' } as const;

export function RailItem({
  id,
  label,
  icon,
  selected = false,
  expanded,
  width,
  onPress,
}: {
  id: string;
  label: string;
  icon: IconName;
  selected?: boolean;
  /** Set on an entry that opens a menu (More): whether it is open. It draws like a selected entry. */
  expanded?: boolean;
  width: number;
  onPress: () => void;
}) {
  const { hex: c } = useTheme();
  const lit = selected || !!expanded;
  const tint = lit ? c.accentText : c.secondaryLabel;
  return (
    <Pressable
      testID={`rail-${id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      // the web reads these, not accessibilityState
      aria-current={selected ? 'page' : undefined}
      {...(expanded === undefined ? null : { 'aria-haspopup': 'menu', 'aria-expanded': expanded })}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        minHeight: 48,
        marginHorizontal: 5,
        marginVertical: 1,
        borderRadius: 12,
        backgroundColor: lit ? c.sidebarSelection : pressed || hovered ? c.fill : 'transparent',
      })}
    >
      <Icon name={icon} size={21} color={tint} />
      <Text numberOfLines={1} style={{ ...LABEL, fontFamily: typo.caption1.fontFamily, maxWidth: width - 10, color: tint }}>
        {label}
      </Text>
    </Pressable>
  );
}
