import React from 'react';
import { Screen } from '../../src/ui/screen';
import { NativeForm } from '../../src/ui/native-form';
import { Section, Text } from '../../src/ui/form-controls.web';
import { useT } from '../../src/lib/i18n';
/** Native push device switches do not apply to a browser. The notification center still works. */
export default function NotificationsSettings() {
  const t = useT();
  return (
    <>
      <Screen title={t('settings.notifications')} />
      <NativeForm>
        <Section>
          <Text>{t('client.browserNotifications')}</Text>
        </Section>
      </NativeForm>
    </>
  );
}
