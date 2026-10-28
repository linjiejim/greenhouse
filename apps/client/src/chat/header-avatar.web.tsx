import React from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { AssistantAvatar } from '../ui/avatar';
import type { PlantState } from '../ui/plant-avatar/plant-ids';
import { space, typo, useTheme } from '../theme';
export const SMALL = 28;
/** Browser headers occupy layout space; UIKit's under-bar band is unnecessary. */
export function HeaderBand(_props: { height: number }) {
  return null;
}
export function HeaderTitle({ title, subtitle, state }: { title: string; subtitle: string; state: PlantState }) {
  const { hex: c } = useTheme();
  const { width } = useWindowDimensions();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, maxWidth: width - 208 }}>
      <AssistantAvatar size={SMALL} state={state} animate />
      <View style={{ minWidth: 0, flexShrink: 1 }}>
        <Text numberOfLines={1} accessibilityRole="header" aria-level={1} style={{ ...typo.title3, color: c.label }}>
          {title}
        </Text>
        {subtitle ? (
          <Text
            numberOfLines={1}
            accessibilityLiveRegion="polite"
            style={{ ...typo.caption1, color: c.secondaryLabel }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
