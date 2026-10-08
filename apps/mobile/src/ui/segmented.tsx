/**
 * Native segmented control (SwiftUI `Picker` with `.segmented` style) for
 * switching between a few peer views or filters (知识库 scope, project view
 * mode). Sizes to its content height; give it a width via `style`.
 */

import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Host, Picker, Text } from '@expo/ui/swift-ui';
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../theme';
import { useLocaleEnv } from './native-form';

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
  const { isDark } = useTheme();
  const locale = useLocaleEnv();
  return (
    <Host
      matchContents={{ vertical: true }}
      ignoreSafeArea="all"
      style={style}
      colorScheme={isDark ? 'dark' : 'light'}
      modifiers={[locale]}
    >
      <Picker selection={value} onSelectionChange={(v) => onChange(v as T)} modifiers={[pickerStyle('segmented')]}>
        {options.map((o) => (
          <Text key={o.value} modifiers={[tag(o.value)]}>
            {o.label}
          </Text>
        ))}
      </Picker>
    </Host>
  );
}
