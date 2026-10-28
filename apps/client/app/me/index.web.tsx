import React from 'react';
import { useWindowDimensions } from 'react-native';
import Preferences from '../../src/settings/preferences-screen.web';
import PhoneSettings from '../../src/settings/account-screen.web';
import { WIDE_MIN } from '../../src/shell/wide-model';
export default function Settings() {
  const { width } = useWindowDimensions();
  return width < WIDE_MIN ? <PhoneSettings /> : <Preferences />;
}
