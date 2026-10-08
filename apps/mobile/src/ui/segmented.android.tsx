import { BrandText as Text } from './brand-text.android';
/**
 * Segmented control on Android — a Material 3 single-choice segmented button
 * row (Jetpack Compose). Same API as ./segmented.tsx (iOS: SwiftUI segmented
 * Picker). Give it a width via `style`; it fills that width.
 */

import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { SegmentedButton, SingleChoiceSegmentedButtonRow } from '@expo/ui/jetpack-compose';
import { fillMaxWidth } from '@expo/ui/jetpack-compose/modifiers';
import { selectionTick } from './haptics';
import { M3Host } from './m3';

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
  return (
    <M3Host matchContents={{ vertical: true }} style={style}>
      <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
        {options.map((o) => (
          <SegmentedButton
            key={o.value}
            selected={o.value === value}
            onClick={() => {
              if (o.value === value) return;
              selectionTick();
              onChange(o.value);
            }}
          >
            <SegmentedButton.Label>
              <Text maxLines={1}>{o.label}</Text>
            </SegmentedButton.Label>
          </SegmentedButton>
        ))}
      </SingleChoiceSegmentedButtonRow>
    </M3Host>
  );
}
