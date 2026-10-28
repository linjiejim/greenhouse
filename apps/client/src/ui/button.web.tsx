import React, { useState } from 'react';
import { ActivityIndicator, Pressable, Text, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { radius, space, typo, useTheme } from '../theme';
import { Icon, type IconName } from './core';
import { webColors } from '../theme/web-colors.generated';
import { WIDE_MIN } from '../shell/wide-model';
export type NativeButtonVariant = 'tinted' | 'prominent' | 'glass';
export function NativeButton({
  label,
  icon,
  onPress,
  variant = 'tinted',
  size = 'regular',
  fullWidth,
  destructive,
  disabled,
  loading,
  selected,
  style,
  testID,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  variant?: NativeButtonVariant;
  size?: 'small' | 'regular' | 'large';
  fullWidth?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  loading?: boolean;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const { hex: c, isDark } = useTheme();
  const semantic = webColors[isDark ? 'dark' : 'light'];
  const { width } = useWindowDimensions();
  const [hover, setHover] = useState(false);
  const fg = destructive ? c.red : variant === 'prominent' ? c.onAccent : c.accentText;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, selected }}
      // the web reads these, not accessibilityState
      aria-busy={loading || undefined}
      {...(selected === undefined ? null : { 'aria-pressed': selected })}
      disabled={disabled || loading}
      onPress={onPress}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={({ pressed }) => [
        {
          minHeight: width < WIDE_MIN ? 44 : size === 'small' ? 28 : 32,
          flexDirection: 'row',
          gap: space.sm,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: space.md,
          borderRadius: radius.sm,
          borderWidth: variant === 'prominent' ? 0 : 1,
          borderColor: c.separator,
          backgroundColor:
            variant === 'prominent'
              ? pressed
                ? semantic.accentPressed
                : hover
                  ? semantic.accentHover
                  : c.accent
              : hover || pressed
                ? c.fill
                : c.secondaryGroupedBackground,
          opacity: disabled || loading ? 0.5 : 1,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Icon name={icon} size={16} color={fg} /> : null}
      <Text style={{ ...typo.subheadline, fontWeight: '600', color: fg }}>{label}</Text>
    </Pressable>
  );
}
