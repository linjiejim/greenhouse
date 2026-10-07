/**
 * `NativeButton` on Android — Material 3 buttons (Jetpack Compose): ripple,
 * state layers, disabled styling and TalkBack are native. Same API as
 * ./button.tsx (iOS: SwiftUI buttons). Variants map to the M3 emphasis ladder:
 *  - `prominent` → filled `Button` (the view's primary action),
 *  - `tinted` (default) → `FilledTonalButton` (secondary actions),
 *  - `glass` → `ElevatedButton` (a control floating over content).
 * `destructive` swaps in the error colors; `loading` shows the circular
 * indicator in place of the label and disables the button.
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import {
  Button,
  CircularProgressIndicator,
  ElevatedButton,
  FilledTonalButton,
  Icon,
  Row,
  Text,
} from '@expo/ui/jetpack-compose';
import { fillMaxWidth, size as sizeMod } from '@expo/ui/jetpack-compose/modifiers';
import type { IconName } from './core';
import { M3Host, useM3 } from './m3';
// the Android table explicitly: TypeScript resolves the bare path to the iOS one (SF names)
import { toolbarIcon } from './toolbar-icon.android';

export type NativeButtonVariant = 'tinted' | 'prominent' | 'glass';

const PAD = {
  small: { start: 12, end: 12, top: 4, bottom: 4 },
  regular: { start: 20, end: 20, top: 8, bottom: 8 },
  large: { start: 24, end: 24, top: 14, bottom: 14 },
};

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
  /** Error colors (sign out, delete). */
  destructive?: boolean;
  disabled?: boolean;
  /** Shows the progress indicator in place of the label and disables the button. */
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const m = useM3();
  const Variant = variant === 'prominent' ? Button : variant === 'glass' ? ElevatedButton : FilledTonalButton;
  const colors = destructive
    ? variant === 'prominent'
      ? { containerColor: m.error, contentColor: m.onError }
      : { containerColor: m.errorContainer, contentColor: m.onErrorContainer }
    : undefined;
  const iconSize = size === 'small' ? 16 : 18;
  const button = (
    <M3Host matchContents={fullWidth ? { vertical: true } : true} style={testID ? undefined : style}>
      <Variant
        onClick={onPress}
        enabled={!disabled && !loading}
        colors={colors}
        contentPadding={PAD[size]}
        modifiers={fullWidth ? [fillMaxWidth()] : undefined}
      >
        {loading ? (
          <CircularProgressIndicator modifiers={[sizeMod(iconSize, iconSize)]} />
        ) : (
          <Row horizontalArrangement={{ spacedBy: 8 }} verticalAlignment="center">
            {icon ? <Icon source={toolbarIcon(icon)} size={iconSize} /> : null}
            <Text style={{ typography: size === 'large' ? 'titleMedium' : 'labelLarge' }}>{label}</Text>
          </Row>
        )}
      </Variant>
    </M3Host>
  );
  return testID ? (
    <View testID={testID} style={style}>
      {button}
    </View>
  ) : (
    button
  );
}
