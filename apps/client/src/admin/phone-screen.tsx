/**
 * iOS / Android: administration needs a wide window (the browser or the desktop app); the button
 * opens the same section of the station's web app in the browser.
 */
import React from 'react';
import { Linking, View } from 'react-native';
import { usePathname } from 'expo-router';
import { Screen } from '../ui/screen';
import { EmptyState } from '../ui/empty';
import { NativeButton } from '../ui/button';
import { useT } from '../lib/i18n';
import { getApiBase } from '../store/stations';
import { useTheme } from '../theme';

/** `path`: the admin address to open (a plugin's section opened as `/p/…`); else this screen's own. */
export default function AdminPhoneScreen({ path }: { path?: string }) {
  const t = useT();
  const { colors: c } = useTheme();
  const here = usePathname();
  const target = path ?? (here.startsWith('/admin') ? here : '/admin');
  const open = () => {
    try {
      void Linking.openURL(new URL(target, getApiBase()).toString());
    } catch {
      /* no station address to open */
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: c.groupedBackground }}>
      <Screen title={t('admin.title')} />
      <EmptyState
        icon="shieldCheck"
        title={t('admin.wideOnly')}
        message={t('admin.wideOnlyHint')}
        action={<NativeButton label={t('admin.openInBrowser')} icon="globe" onPress={open} />}
      />
    </View>
  );
}
