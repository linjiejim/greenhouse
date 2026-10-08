import { brandFont as font } from './brand-font';
/**
 * `NativeButton` — the one in-content action button: a real SwiftUI `Button`
 * (system press / disabled / Dynamic Type / VoiceOver), accent-tinted. Use it
 * for actions that live in the content rather than the navigation bar: 重试
 * under a failed load, 恢复此版本, 就此提问, 新建项目 in an empty state, the
 * login submit. Navigation-bar actions stay `Stack.Toolbar.Button`; actions
 * inside a SwiftUI `Form` are plain SwiftUI `Button`s in a `Section`.
 *
 * Variants (HIG: one prominent action per view):
 *  - `tinted` (default) — `.bordered`: a tinted capsule for secondary actions.
 *  - `prominent` — the view's primary action: Liquid Glass `.glassProminent`
 *    on iOS 26, `.borderedProminent` (filled accent) before.
 *  - `glass` — a secondary action floating over content: `.glass` on iOS 26,
 *    `.bordered` before.
 *
 * Sized to its label unless `fullWidth` (then it fills the width given by
 * `style` — the label is centered). `loading` swaps the label for the system
 * spinner and disables the button.
 */

import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Button, Host, Label, ProgressView, Text } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled as disabledMod, frame, tint } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../theme';
import { sfSymbol, type IconName } from './core';
import { LIQUID_GLASS } from './glass';
import { useLocaleEnv } from './native-form';

export type NativeButtonVariant = 'tinted' | 'prominent' | 'glass';

function styleFor(variant: NativeButtonVariant) {
  if (variant === 'prominent') return buttonStyle(LIQUID_GLASS ? 'glassProminent' : 'borderedProminent');
  if (variant === 'glass') return buttonStyle(LIQUID_GLASS ? 'glass' : 'bordered');
  return buttonStyle('bordered');
}

export function NativeButton({
  label,
  icon,
  onPress,
  variant = 'tinted',
  size = 'regular',
  fullWidth = false,
  destructive = false,
  disabled = false,
  loading = false,
  style,
  testID,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  variant?: NativeButtonVariant;
  size?: 'small' | 'regular' | 'large';
  /** Stretch to the width of `style` (label centered) instead of hugging the label. */
  fullWidth?: boolean;
  /** Red tint + the destructive role (VoiceOver). */
  destructive?: boolean;
  disabled?: boolean;
  /** Shows the system spinner in place of the label and disables the button. */
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const { hex, isDark } = useTheme();
  const locale = useLocaleEnv();
  const stretch = fullWidth ? [frame({ maxWidth: 10000 })] : [];
  return (
    <Host
      matchContents={fullWidth ? { vertical: true } : true}
      // inline content, never a screen: a button mounted under the nav bar (a card near the top of a
      // long thread opened at its end) would otherwise draw its label pushed down by the bar's inset
      ignoreSafeArea="all"
      style={style}
      colorScheme={isDark ? 'dark' : 'light'}
      modifiers={[font({ weight: variant === 'prominent' ? 'semibold' : 'regular' }), locale]}
      testID={testID}
    >
      <Button
        onPress={onPress}
        role={destructive ? 'destructive' : undefined}
        modifiers={[
          styleFor(variant),
          controlSize(size),
          tint(destructive ? hex.red : hex.accent),
          disabledMod(disabled || loading),
        ]}
      >
        {loading ? (
          <ProgressView modifiers={stretch} />
        ) : icon ? (
          <Label title={label} systemImage={sfSymbol(icon)} modifiers={stretch} />
        ) : (
          <Text modifiers={variant === 'prominent' ? [font({ weight: 'semibold' }), ...stretch] : stretch}>
            {label}
          </Text>
        )}
      </Button>
    </Host>
  );
}
