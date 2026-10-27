import React from 'react';
import { Switch, Text, View } from 'react-native';
import { typo, useTheme } from '../theme';
export function NativeToggle({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const { hex: c } = useTheme();
  return (
    <View
      style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 32, gap: 12 }}
    >
      <Text style={{ ...typo.body, color: c.label }}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: c.accent }}
      />
    </View>
  );
}
