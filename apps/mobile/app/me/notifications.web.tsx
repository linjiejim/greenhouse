import React from 'react';
import { Text } from 'react-native';
import { Screen } from '../../src/ui/screen';
import { NativeForm } from '../../src/ui/native-form';
import { useT } from '../../src/lib/i18n';
/** Native push device switches do not apply to a browser. The notification center still works. */
export default function NotificationsSettings() {
  const t = useT();
  return (
    <>
      <Screen title={t('settings.notifications')} />
      <NativeForm>
        <Text>{t('client.browserNotifications')}</Text>
      </NativeForm>
    </>
  );
}
