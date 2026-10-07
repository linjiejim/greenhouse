/**
 * The standard loading placeholder: a native spinner centered in the space
 * it's given (page, list or sheet body). Use it instead of hand-placing an
 * ActivityIndicator so first loads look the same everywhere. Re-exported by
 * ./empty (both platforms).
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Spinner } from './core';

export function LoadingState({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 48 }, style]}>
      <Spinner />
    </View>
  );
}
