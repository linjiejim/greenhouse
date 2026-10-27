import React from 'react';
import { Text, useWindowDimensions } from 'react-native';
import { GreetingSprout } from '../ui/greeting-sprout';
import { space, typo, useTheme } from '../theme';
import { WIDE_MIN } from '../shell/wide-model';
export function GreetingTitle({ label, assistantLabel }: { label: string; assistantLabel: string }) {
  const { hex: c } = useTheme();
  const { width } = useWindowDimensions();
  return (
    <>
      <GreetingSprout
        size={width >= WIDE_MIN ? 88 : 72}
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
