import React from 'react';
import { Text, useWindowDimensions } from 'react-native';
import { GreetingSprout } from '../ui/greeting-sprout';
import { space, typo, useTheme } from '../theme';
export function GreetingTitle({ label, assistantLabel }: { label: string; assistantLabel: string }) {
  const { hex: c } = useTheme();
  const { width } = useWindowDimensions();
  return (
    <>
      <GreetingSprout
        size={width >= 760 ? 88 : 72}
        accessibilityLabel={assistantLabel}
        style={{ alignSelf: 'flex-start', marginHorizontal: space.margin + space.xs, marginBottom: space.xxl }}
      />
      <Text
        style={{ ...typo.largeTitle, color: c.label, marginHorizontal: space.margin + space.xs }}
        accessibilityRole="header"
      >
        {label}
      </Text>
    </>
  );
}
