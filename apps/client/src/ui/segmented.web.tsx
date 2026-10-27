import React from 'react';
import { Pressable, Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { radius, space, typo, useTheme } from '../theme';
import { WIDE_MIN } from '../shell/wide-model';
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  style,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { hex: c } = useTheme();
  const { width } = useWindowDimensions();
  return (
    <View
      accessibilityRole="tablist"
      style={[
        { flexDirection: 'row', backgroundColor: c.tertiaryFill, borderRadius: radius.sm, padding: space.xxs },
        style,
      ]}
    >
      {options.map((o) => (
        <Pressable
          key={o.value}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === o.value }}
          onPress={() => onChange(o.value)}
          style={({ pressed }) => ({
            flex: 1,
            minHeight: width < WIDE_MIN ? 44 : 28,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: value === o.value ? c.secondaryGroupedBackground : pressed ? c.fill : 'transparent',
            borderRadius: radius.xs,
            paddingHorizontal: space.sm,
          })}
        >
          <Text style={{ ...typo.footnote, fontWeight: '600', color: c.label }}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
