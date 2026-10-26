import React from 'react';
import { useWindowDimensions } from 'react-native';
import Preferences from '../../src/settings/preferences-screen.web';
import PhoneSettings from '../../src/settings/account-screen.web';
export default function Settings() {
  const { width } = useWindowDimensions();
  return width < 760 ? <PhoneSettings /> : <Preferences />;
}
