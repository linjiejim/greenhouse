/**
 * Liquid Glass primitives (iOS 26+), with graceful fallbacks.
 *
 * Glass is the *control layer* material: it floats above content (the
 * composer, floating action pills, overlays on media). Per the HIG, never put
 * glass on content itself (messages, cards, list rows) and never stack glass on
 * glass — group neighbouring glass elements in a `GlassGroup` so they blend and
 * morph as one surface instead.
 *
 * Native navigation chrome (headers, toolbars, sheets, menus, the drawer's
 * system controls) is already glass on iOS 26 — these components are only for
 * custom floating controls.
 *
 * Fallback (iOS < 26, Android, web): an opaque elevated surface with a hairline
 * border — same geometry, no blur, so layouts never depend on glass.
 */

import React from 'react';
import { StyleSheet, View, type ColorValue, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { GlassContainer, GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { HIT, makeStyles, shadow, squircle, useTheme } from '../theme';
import { Icon, type IconName, Touchable } from './core';

/** True when the device renders real Liquid Glass (iOS 26+). */
export const LIQUID_GLASS = isLiquidGlassAvailable();

export function Glass({
  children,
  style,
  interactive = false,
  tint,
  variant = 'regular',
  pointerEvents,
}: {
  children?: React.ReactNode;
  /** Shape comes from `borderRadius` here (use `squircle` + a radius token). */
  style?: StyleProp<ViewStyle>;
  /** Interactive glass reacts to touch (shimmer + flex). Use for tappable glass. */
  interactive?: boolean;
  /** Tinted glass (e.g. the accent for a primary action). */
  tint?: ColorValue;
  /** `regular` (default) or `clear` (more transparent, for media backdrops). */
  variant?: 'regular' | 'clear';
  pointerEvents?: ViewProps['pointerEvents'];
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  if (LIQUID_GLASS) {
    return (
      <GlassView
        glassEffectStyle={variant}
        isInteractive={interactive}
        tintColor={tint}
        style={[squircle, style]}
        pointerEvents={pointerEvents}
      >
        {children}
      </GlassView>
    );
  }
  return (
    <View style={[styles.fallback, tint ? { backgroundColor: tint } : null, squircle, style]} pointerEvents={pointerEvents}>
      {children}
    </View>
  );
}

/**
 * Groups neighbouring glass shapes so they render as one material and merge /
 * split fluidly when they come within `spacing` of each other.
 */
export function GlassGroup({
  children,
  spacing = 12,
  style,
}: {
  children: React.ReactNode;
  spacing?: number;
  style?: StyleProp<ViewStyle>;
}) {
  if (LIQUID_GLASS) {
    return (
      <GlassContainer spacing={spacing} style={style}>
        {children}
      </GlassContainer>
    );
  }
  return <View style={style}>{children}</View>;
}

/**
 * A circular glass icon button (floating controls: attach, send, scroll-to-end).
 * `prominent` tints it with the accent for the primary action.
 */
export function GlassIconButton({
  icon,
  onPress,
  size = HIT,
  iconSize,
  prominent = false,
  disabled = false,
  accessibilityLabel,
  style,
}: {
  icon: IconName;
  onPress?: () => void;
  size?: number;
  iconSize?: number;
  prominent?: boolean;
  disabled?: boolean;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors: c } = useTheme();
  return (
    <Touchable
      onPress={onPress}
      disabled={disabled}
      haptic={prominent ? 'light' : 'none'}
      pressedStyle={LIQUID_GLASS ? {} : { opacity: 0.6 }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={style}
    >
      <Glass
        interactive
        tint={prominent && !disabled ? c.accent : undefined}
        style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}
      >
        <Icon
          name={icon}
          size={iconSize ?? Math.round(size * 0.42)}
          weight="semibold"
          color={prominent && !disabled ? c.onAccent : c.label}
        />
      </Glass>
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  fallback: {
    backgroundColor: c.tertiaryBackground,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    ...shadow.float,
  },
}));
