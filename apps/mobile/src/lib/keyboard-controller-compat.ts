/**
 * Expo Go compatibility shim for react-native-keyboard-controller.
 *
 * keyboard-controller ships a native module that is NOT bundled into the Expo Go
 * host app, so importing/using it there crashes at startup. When running under
 * Expo Go (executionEnvironment === 'storeClient') we fall back to no-op stubs:
 * the keyboard-follow animations go inert, but the app boots and everything else
 * works. Real dev-client / standalone builds get the real module untouched.
 */

import React from 'react';
import Constants from 'expo-constants';
import { useSharedValue } from 'react-native-reanimated';

const isExpoGo = Constants.executionEnvironment === 'storeClient';

type KeyboardAnim = { height: { value: number }; progress: { value: number } };

let KeyboardProvider: React.ComponentType<{ children?: React.ReactNode }>;
let useReanimatedKeyboardAnimation: () => KeyboardAnim;

if (isExpoGo) {
  KeyboardProvider = ({ children }) => children as React.ReactElement;
  useReanimatedKeyboardAnimation = () => {
    const height = useSharedValue(0);
    const progress = useSharedValue(0);
    return { height, progress };
  };
} else {
  // Lazy require so Expo Go never loads the native module (a static import would).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const kc = require('react-native-keyboard-controller');
  KeyboardProvider = kc.KeyboardProvider;
  useReanimatedKeyboardAnimation = kc.useReanimatedKeyboardAnimation;
}

export { KeyboardProvider, useReanimatedKeyboardAnimation };
