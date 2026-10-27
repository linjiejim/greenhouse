import { BrandText as Text } from '../src/ui/brand-text.android';
/**
 * Login on Android — a Material 3 form (iOS: ./login.tsx, SwiftUI; the flow is
 * the shared src/login/use-login.ts): brand header, the server (station) row,
 * outlined email / password fields with autofill hints and IME actions
 * (下一项 → 登录), and the filled sign-in button. A failed sign-in shows its
 * reason as the password field's error text until the user edits a field.
 */

import React, { useCallback, useRef } from 'react';
import { BackHandler, Keyboard, Text as RNText, useWindowDimensions, View } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { Button, CircularProgressIndicator, OutlinedButton, RNHostView, type TextFieldRef } from '@expo/ui/jetpack-compose';
import { fillMaxWidth, padding, size } from '@expo/ui/jetpack-compose/modifiers';
import { useLogin } from '../src/login/use-login';
import { useT } from '../src/lib/i18n';
import { GreenhouseMark } from '../src/ui/logo';
import {
  FormFields,
  FormNavRow,
  FormSection,
  FormTextField,
  NativeForm,
  useNativeState,
} from '../src/ui/native-form.android';
import { makeStyles, space, typo, useTheme } from '../src/theme';

export default function Login() {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { width } = useWindowDimensions();
  const emailState = useNativeState('');
  const passwordState = useNativeState('');
  const passwordRef = useRef<TextFieldRef>(null);
  const emailRef = useRef<TextFieldRef>(null);
  useFocusEffect(
    useCallback(() => {
      const back = BackHandler.addEventListener('hardwareBackPress', () => {
        Keyboard.dismiss();
        void emailRef.current?.blur().catch(() => {});
        void passwordRef.current?.blur().catch(() => {});
        return true;
      });
      return () => back.remove();
    }, []),
  );
  const readEmail = useCallback(() => emailState.get(), [emailState]);
  const readPassword = useCallback(() => passwordState.get(), [passwordState]);
  const { station, productName, error, connectionError, retry, busy, submit, clearError, openStations, feishu, signInWithFeishu } = useLogin({
    email: readEmail,
    password: readPassword,
  });

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <NativeForm background={hex.brandCanvas}>
        <RNHostView matchContents>
          <View style={[styles.brand, { width: width - 32 }]}>
            <GreenhouseMark size={64} />
            <RNText style={styles.title}>{productName}</RNText>
          </View>
        </RNHostView>

        <FormSection>
          <FormNavRow
            label={t('login.station')}
            value={station ? station.name : t('station.addFirst')}
            icon="server"
            onPress={openStations}
          />
        </FormSection>

        {connectionError ? (
          <FormSection footer={connectionError}>
            <Button onClick={() => void retry()}>
              <Text>{t('common.retry')}</Text>
            </Button>
          </FormSection>
        ) : null}

        <FormFields>
          <FormTextField
            fieldRef={emailRef}
            label={t('login.emailPlaceholder')}
            state={emailState}
            onChangeText={clearError}
            keyboard="email"
            autofill="emailAddress"
            imeAction="next"
            onSubmit={() => void passwordRef.current?.focus()}
          />
          <FormTextField
            fieldRef={passwordRef}
            label={t('login.passwordPlaceholder')}
            state={passwordState}
            onChangeText={clearError}
            secure
            autofill="password"
            imeAction="go"
            onSubmit={() => void submit()}
            error={error}
          />
        </FormFields>

        <Button
          onClick={() => void submit()}
          enabled={!busy}
          modifiers={[fillMaxWidth(), padding(0, 8, 0, 0)]}
          contentPadding={{ start: 24, end: 24, top: 14, bottom: 14 }}
        >
          {busy ? (
            <CircularProgressIndicator modifiers={[size(20, 20)]} />
          ) : (
            <Text style={{ typography: 'titleMedium' }}>{t('login.submit')}</Text>
          )}
        </Button>
        {feishu ? (
          <OutlinedButton
            onClick={() => void signInWithFeishu()}
            enabled={!busy}
            modifiers={[fillMaxWidth(), padding(0, 8, 0, 0)]}
            contentPadding={{ start: 24, end: 24, top: 14, bottom: 14 }}
          >
            <Text style={{ typography: 'titleMedium' }}>{t('login.feishu')}</Text>
          </OutlinedButton>
        ) : null}
      </NativeForm>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  brand: { alignItems: 'center', paddingTop: space.xxxl + space.lg, paddingBottom: space.md, gap: space.xs },
  title: { ...typo.largeTitle, color: c.label, marginTop: space.md },
}));
