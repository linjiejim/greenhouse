import { brandFont as font } from '../src/ui/brand-font';
/**
 * Login — a native SwiftUI form (Android: ./login.android.tsx, Material; the
 * flow itself is the shared src/login/use-login.ts): brand header, the server (station) row,
 * email + password with system AutoFill (username / password content types →
 * iCloud Keychain suggestions), and a prominent Liquid Glass sign-in button.
 *
 * The server row opens the stations sheet; switching to a station with a live
 * saved session skips the credentials entirely (the root layout routes home
 * once bootstrap resolves). A failed sign-in shows its reason in red under the
 * fields (in place of the members-only note) until the user edits a field.
 */

import React, { useCallback, useRef } from 'react';
import { Text as RNText, useWindowDimensions, View } from 'react-native';
import { Stack } from 'expo-router';
import {
  Button,
  ProgressView,
  RNHostView,
  Section,
  SecureField,
  Text,
  TextField,
  useNativeState,
  type SecureFieldRef,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  autocorrectionDisabled,
  buttonStyle,
  controlSize,
  disabled,
  foregroundStyle,
  frame,
  keyboardType,
  listRowBackground,
  listRowInsets,
  onSubmit,
  submitLabel,
  textContentType,
  textInputAutocapitalization,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { useLogin } from '../src/login/use-login';
import { useT } from '../src/lib/i18n';
import { GreenhouseMark } from '../src/ui/logo';
import { LIQUID_GLASS } from '../src/ui/glass';
import { FormNavRow, NativeForm } from '../src/ui/native-form';
import { makeStyles, space, typo, useTheme } from '../src/theme';

export default function Login() {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { width } = useWindowDimensions();
  // The native fields own the text (AutoFill writes straight into them);
  // onTextChange is async, so submit reads the native values.
  const emailState = useNativeState('');
  const passwordState = useNativeState('');
  const passwordRef = useRef<SecureFieldRef>(null);
  const readEmail = useCallback(() => emailState.get(), [emailState]);
  const readPassword = useCallback(() => passwordState.get(), [passwordState]);
  const {
    station,
    productName,
    setupPending,
    error,
    connectionError,
    retry,
    busy,
    submit,
    clearError,
    openStations,
    feishu,
    signInWithFeishu,
  } = useLogin({
    email: readEmail,
    password: readPassword,
  });

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <NativeForm background={hex.brandCanvas}>
        <Section
          footer={<Text>{setupPending ? t('login.setupPending') : ''}</Text>}
          header={
            <RNHostView matchContents>
              <View style={[styles.brand, { width: width - 40 }]}>
                <GreenhouseMark size={64} />
                <RNText style={styles.title}>{productName}</RNText>
              </View>
            </RNHostView>
          }
        >
          <FormNavRow
            label={t('login.station')}
            value={station ? station.name : t('station.addFirst')}
            systemImage="server.rack"
            onPress={openStations}
          />
        </Section>

        {connectionError ? (
          <Section footer={<Text modifiers={[foregroundStyle('red')]}>{connectionError}</Text>}>
            <Button label={t('common.retry')} onPress={() => void retry()} />
          </Section>
        ) : null}

        {/* Keep the footer mounted: rebuilding its Section would blur a focused field. */}
        <Section footer={<Text modifiers={error ? [foregroundStyle('red')] : []}>{error ?? ''}</Text>}>
          <TextField
            text={emailState}
            placeholder={t('login.emailPlaceholder')}
            onTextChange={clearError}
            modifiers={[
              accessibilityLabel(t('login.emailPlaceholder')),
              textContentType('username'),
              keyboardType('email-address'),
              textInputAutocapitalization('never'),
              autocorrectionDisabled(),
              submitLabel('next'),
              onSubmit(() => void passwordRef.current?.focus()),
            ]}
          />
          <SecureField
            ref={passwordRef}
            text={passwordState}
            placeholder={t('login.passwordPlaceholder')}
            onTextChange={clearError}
            modifiers={[
              accessibilityLabel(t('login.passwordPlaceholder')),
              textContentType('password'),
              submitLabel('go'),
              onSubmit(() => void submit()),
            ]}
          />
        </Section>

        <Section>
          <Button
            onPress={() => void submit()}
            modifiers={[
              foregroundStyle(hex.onAccent),
              buttonStyle(LIQUID_GLASS ? 'glassProminent' : 'borderedProminent'),
              controlSize('large'),
              disabled(busy),
              listRowBackground('clear'),
              listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 }),
            ]}
          >
            {busy ? (
              <ProgressView modifiers={[tint(hex.onAccent), frame({ maxWidth: 9999 })]} />
            ) : (
              <Text modifiers={[font({ weight: 'semibold' }), frame({ maxWidth: 9999 })]}>{t('login.submit')}</Text>
            )}
          </Button>
        </Section>

        {feishu ? (
          <Section>
            <Button
              onPress={() => void signInWithFeishu()}
              modifiers={[
                buttonStyle('bordered'),
                controlSize('large'),
                disabled(busy),
                listRowBackground('clear'),
                listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 }),
              ]}
            >
              <Text modifiers={[font({ weight: 'semibold' }), frame({ maxWidth: 9999 })]}>{t('login.feishu')}</Text>
            </Button>
          </Section>
        ) : null}
      </NativeForm>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  brand: { alignItems: 'center', paddingTop: space.xxxl, paddingBottom: space.xl, gap: space.xs },
  title: { ...typo.largeTitle, color: c.label, marginTop: space.md },
}));
