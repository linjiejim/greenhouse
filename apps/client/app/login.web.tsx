import '../src/login/entry.css';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useLogin } from '../src/login/use-login';
import { useProviderSignIn } from '../src/login/provider-sign-in.web';
import { useT } from '../src/lib/i18n';
import { GreenhouseMark } from '../src/ui/logo';
import { NativeButton } from '../src/ui/button';
import { space, typo, useTheme } from '../src/theme';
export default function Login() {
  const { hex: c } = useTheme();
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const flow = useLogin({ email: () => email, password: () => password });
  // Feishu and other identity providers, when their plugin is on (src/plugins/identity.ts)
  const providers = useProviderSignIn();
  const error = providers.error ?? flow.error ?? flow.connectionError;
  const busy = flow.busy || providers.busy !== null;
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.brandCanvas,
        justifyContent: 'center',
        alignItems: 'center',
        padding: space.xxl,
      }}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ width: '100%', maxWidth: 380, gap: space.xxl }}>
        <View style={{ alignItems: 'center', gap: space.md }}>
          <GreenhouseMark size={64} />
          <Text accessibilityRole="header" style={{ ...typo.largeTitle, color: c.label }}>
            {flow.productName}
          </Text>
        </View>
        {flow.setupPending ? (
          <Text style={{ ...typo.body, color: c.secondaryLabel }}>{t('login.setupPending')}</Text>
        ) : null}
        <form
          className="gh-entry-form"
          onSubmit={(e) => {
            e.preventDefault();
            void flow.submit();
          }}
          style={{ gap: space.lg }}
        >
          <input
            className="gh-input"
            data-testid="login-email"
            aria-label={t('login.emailPlaceholder')}
            placeholder={t('login.emailPlaceholder')}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              flow.clearError();
              providers.clearError();
            }}
          />
          <input
            className="gh-input"
            data-testid="login-password"
            aria-label={t('login.passwordPlaceholder')}
            placeholder={t('login.passwordPlaceholder')}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              flow.clearError();
              providers.clearError();
            }}
          />
          {error ? (
            <p role="alert" className="gh-error">
              {error}
            </p>
          ) : null}
          <button type="submit" className="gh-primary" data-testid="login-submit" disabled={busy}>
            {flow.busy ? t('common.loading') : t('login.submit')}
          </button>
          {flow.connectionError ? <NativeButton label={t('common.retry')} onPress={() => void flow.retry()} /> : null}
        </form>
        {providers.providers.length ? (
          <div className="gh-entry-form">
            <div className="gh-entry-divider" aria-hidden="true">
              {t('entry.or')}
            </div>
            {providers.providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className="gh-secondary-button"
                data-testid={`login-provider-${provider.id}`}
                disabled={busy}
                onClick={() => void providers.start(provider)}
              >
                {providers.busy === provider.id
                  ? t('entry.signingIn')
                  : t('entry.signInWith', { name: t(provider.title) })}
              </button>
            ))}
          </div>
        ) : null}
      </View>
    </View>
  );
}
