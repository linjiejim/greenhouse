/**
 * The entry routes on the phone (app/activate, app/oauth-consent, app/connectors/oauth-finish,
 * app/bindings): their pages are browser pages (`*.web.tsx`). Nothing here reads a link's
 * parameters; the phone's own sign-in and connector returns go through the system auth session.
 */

import React from 'react';
import { View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useT } from '../lib/i18n';
import { goHome } from '../shell/nav';
import { useTheme } from '../theme';
import { NativeButton } from '../ui/button';
import { EmptyState } from '../ui/empty';

export function WebOnlyEntry() {
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: c.background }}>
        <EmptyState
          icon="globe"
          title={t('entry.webOnly')}
          message={t('entry.webOnlyHint')}
          action={<NativeButton label={t('entry.back')} onPress={() => goHome(router)} />}
        />
      </View>
    </>
  );
}
