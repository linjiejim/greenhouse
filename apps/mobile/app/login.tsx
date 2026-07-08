/**
 * Login — pick a station (self-hosted server), then internal email + password.
 * Sprouty mascot, hairline fields, primary button. The station row opens the
 * StationSheet; switching to a station with a live saved session skips the
 * credentials entirely (root layout routes home once bootstrap resolves).
 *
 * Keyboard: the form sits in a KeyboardAwareScrollView (keyboard-controller),
 * which scrolls only the minimum needed to keep the focused field visible — no
 * re-centering on keyboard height changes (the old paddingBottom-follow made the
 * page twitch when hopping between fields). Tapping anywhere outside the fields
 * dismisses the keyboard.
 */

import React, { useState } from 'react';
import { Keyboard, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../src/store/auth';
import { StationSheet, useActiveStation } from '../src/stations/station-sheet';
import { KeyboardAwareScrollView } from '../src/lib/keyboard-controller-compat';
import { useT } from '../src/lib/i18n';
import { Button, Field, GreenhouseMark, Icon, Touchable } from '../src/ui';
import { font, makeStyles, radius, useTheme } from '../src/theme';

export default function Login() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const doLogin = useAuth((s) => s.login);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const station = useActiveStation();
  const [stationOpen, setStationOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!station) {
      setError(t('login.noStation'));
      setStationOpen(true);
      return;
    }
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
    <View style={styles.root}>
      <KeyboardAwareScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1 }}
        bottomOffset={72}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
      >
        <Pressable style={styles.inner} onPress={Keyboard.dismiss} accessible={false}>
          <View style={styles.center}>
            <View style={styles.logo}>
              <GreenhouseMark size={72} />
            </View>
            <Text style={styles.title}>Greenhouse</Text>
            <Text style={styles.sub}>{t('login.subtitle')}</Text>
          </View>

          <View style={styles.form}>
            <Touchable
              haptic="light"
              onPress={() => setStationOpen(true)}
              pressedStyle={{ opacity: 0.7 }}
              style={styles.stationRow}
              accessibilityLabel={t('login.station')}
            >
              <Icon name="server" size={17} color={c.fgMuted} />
              <Text numberOfLines={1} style={[styles.stationText, !station && { color: c.fgFaint }]}>
                {station ? station.name : t('station.addFirst')}
              </Text>
              <Icon name="chevD" size={16} color={c.fgFaint} />
            </Touchable>
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
            <Button label={t('login.submit')} onPress={submit} loading={busy} />
          </View>
        </Pressable>
      </KeyboardAwareScrollView>
      <Text style={[styles.foot, { paddingBottom: Math.max(insets.bottom, 16) }]}>{t('login.footer')}</Text>

      <StationSheet visible={stationOpen} onClose={() => setStationOpen(false)} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  inner: { flex: 1, justifyContent: 'center', paddingHorizontal: 28 },
  center: { alignItems: 'center', marginBottom: 32 },
  logo: { alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  title: { fontSize: font.displaySm, fontWeight: '700', color: c.fg },
  sub: { fontSize: font.label, color: c.fgMuted, marginTop: 5 },
  form: { width: '100%', gap: 12 },
  stationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.hairline,
    paddingHorizontal: 14,
    height: 50,
  },
  stationText: { flex: 1, fontSize: font.body, color: c.fg },
  err: { color: c.danger, fontSize: font.small, paddingLeft: 2 },
  foot: { textAlign: 'center', fontSize: font.caption, color: c.fgFaint, paddingTop: 8 },
}));
