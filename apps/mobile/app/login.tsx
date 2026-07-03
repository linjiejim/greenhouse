/**
 * Login — internal email + password.
 * Sprouty mascot, hairline fields, primary button.
 */

import React, { useState } from 'react';
import { Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../src/store/auth';
import { useBottomPadStyle } from '../src/lib/keyboard';
import { useT } from '../src/lib/i18n';
import { Button, Field, SproutyFace } from '../src/ui';
import { makeStyles, useTheme } from '../src/theme';

export default function Login() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const doLogin = useAuth((s) => s.login);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const rootPad = useBottomPadStyle(0);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!email.trim() || !password) {
      setError(t('login.missingFields'));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await doLogin(email.trim(), password);
    setBusy(false);
    if (res.ok) router.replace('/');
    else setError(res.error || t('login.failed'));
  }

  return (
    <Animated.View style={[styles.root, rootPad]}>
      <View style={styles.inner}>
        <View style={styles.center}>
          <View style={styles.logo}>
            <SproutyFace expr="idle" size={72} />
          </View>
          <Text style={styles.title}>Greenhouse</Text>
          <Text style={styles.sub}>{t('login.subtitle')}</Text>
        </View>

        <View style={styles.form}>
          <Field
            icon="msg"
            placeholder={t('login.emailPlaceholder')}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            value={email}
            onChangeText={(v: string) => {
              setEmail(v);
              setError(null);
            }}
          />
          <Field
            icon="lock"
            placeholder={t('login.passwordPlaceholder')}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={submit}
            returnKeyType="go"
          />
          {error ? <Text style={styles.err}>{error}</Text> : null}
          <View style={{ height: 10 }} />
          <Button label={t('login.submit')} onPress={submit} loading={busy} />
        </View>
      </View>
      <Text style={[styles.foot, { paddingBottom: Math.max(insets.bottom, 16) }]}>{t('login.footer')}</Text>
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  inner: { flex: 1, justifyContent: 'center', paddingHorizontal: 28 },
  center: { alignItems: 'center', marginBottom: 36 },
  logo: { alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  title: { fontSize: 26, fontWeight: '700', color: c.fg },
  sub: { fontSize: 14.5, color: c.fgMuted, marginTop: 5 },
  form: { width: '100%' },
  err: { color: c.danger, fontSize: 13, marginTop: 10, paddingLeft: 2 },
  foot: { textAlign: 'center', fontSize: 12, color: c.fgFaint, paddingTop: 8 },
}));
