import React, { useContext } from 'react';
import { ScrollView, Text, View, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { space, typo, useTheme } from '../theme';
import { Icon, type IconName } from './core';
import { DialogFrameContext } from './dialog-frame';
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
  if (useContext(DialogFrameContext))
    // a desktop dialog's body: the shared .gh-form stack (20 inset, 16 between groups) on the panel
    return (
      <ScrollView
        style={[{ flex: 1, backgroundColor: c.secondaryGroupedBackground }, style]}
        keyboardShouldPersistTaps="handled"
      >
        <div className="gh-form">{children}</div>
      </ScrollView>
    );
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
  const { hex: c } = useTheme();
  // Inside a Section card: same inset and type as LabeledContent / Picker rows, not a list row.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        minHeight: 28,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ ...typo.body, color: c.label, flex: 1 }}>{label}</Text>
      {value ? <Text style={{ ...typo.body, color: c.secondaryLabel }}>{value}</Text> : null}
      <Icon name="chevR" size={16} color={c.tertiaryLabel} />
    </Pressable>
  );
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
