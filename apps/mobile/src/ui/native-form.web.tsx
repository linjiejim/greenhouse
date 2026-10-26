import React from 'react';
import { ScrollView, Text, View, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { space, useTheme } from '../theme';
import { Row } from './list';
import { Icon, type IconName } from './core';
export function useLocaleEnv() {
  return undefined;
}
export function NativeForm({
  children,
  style,
  background,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  background?: string;
}) {
  const { hex: c } = useTheme();
  return (
    <ScrollView
      style={[{ flex: 1, backgroundColor: background ?? c.background }, style]}
      contentContainerStyle={{ padding: space.xxl, width: '100%', maxWidth: 680, alignSelf: 'center', gap: space.lg }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}
export function FormLoading() {
  return <Text accessibilityRole="progressbar">…</Text>;
}
export function FormNavRow({
  label,
  value,
  onPress,
}: {
  label: string;
  value?: string;
  systemImage?: string;
  systemImageColor?: string;
  icon?: IconName;
  onPress: () => void;
}) {
  return <Row title={label} value={value} onPress={onPress} accessory="chevron" />;
}
export function FormCheckRow({
  label,
  detail,
  checked,
  choice,
  onPress,
}: {
  label: string;
  detail?: string;
  systemImage?: string;
  systemImageColor?: string;
  checked: boolean;
  choice?: 'single' | 'multiple';
  onPress: () => void;
}) {
  const { hex: c } = useTheme();
  return (
    <Pressable
      accessibilityRole={choice === 'multiple' ? 'checkbox' : choice === 'single' ? 'radio' : 'button'}
      accessibilityState={choice ? { checked } : { selected: checked }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: space.md,
        alignItems: 'center',
        padding: space.sm,
        minHeight: 44,
        backgroundColor: checked ? c.accentFill : pressed ? c.fill : 'transparent',
        borderRadius: 8,
      })}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.label }}>{label}</Text>
        {detail ? <Text style={{ color: c.secondaryLabel }}>{detail}</Text> : null}
      </View>
      {checked ? <Icon name="check" size={16} color={c.accent} /> : null}
    </Pressable>
  );
}
