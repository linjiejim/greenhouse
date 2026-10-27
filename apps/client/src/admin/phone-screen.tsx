/** iOS / Android: administration needs a wide window (the browser or the desktop app). */
import React from 'react';
import { View } from 'react-native';
import { Screen } from '../ui/screen';
import { EmptyState } from '../ui/empty';
import { useT } from '../lib/i18n';
import { useTheme } from '../theme';

export default function AdminPhoneScreen() {
  const t = useT();
  const { colors: c } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: c.groupedBackground }}>
      <Screen title={t('admin.title')} />
      <EmptyState icon="shieldCheck" title={t('admin.wideOnly')} message={t('admin.wideOnlyHint')} />
    </View>
  );
}
