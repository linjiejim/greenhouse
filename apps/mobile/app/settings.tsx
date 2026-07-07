/**
 * Settings — pushed from the Home drawer. Back + title, account card, appearance
 * (theme / language), usage limits, about, and sign out (with a confirm sheet).
 * Flat groups on the sunken bg; only the account card is a raised cluster.
 */

import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { useAuth } from '../src/store/auth';
import { usePrefs } from '../src/store/prefs';
import { StationSheet, useActiveStation } from '../src/stations/station-sheet';
import { useT } from '../src/lib/i18n';
import { Icon, ScreenHeader, Segmented, Sheet, Toast, Touchable, UserAvatar } from '../src/ui';
import { font, makeStyles, radius, shadow, useTheme } from '../src/theme';

export default function Settings() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const lang = usePrefs((s) => s.lang);
  const setLang = usePrefs((s) => s.setLang);
  const station = useActiveStation();
  const [stationOpen, setStationOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const version = Constants.expoConfig?.version ?? '1.0.0';
  const nickname = user?.nickname || t('settings.fallbackName');

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }

  function doLogout() {
    setConfirm(false);
    logout();
    router.replace('/login');
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + 2 }]}>
      <ScreenHeader variant="large" title={t('settings.title')} onLeading={() => router.back()} />

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }} showsVerticalScrollIndicator={false}>
        {/* account card */}
        <View style={styles.account}>
          <UserAvatar size={50} label={nickname[0]} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.name}>{nickname}</Text>
            <Text numberOfLines={1} style={styles.email}>
              {user?.email || '—'}
            </Text>
          </View>
          <View style={styles.chevBox}>
            <Icon name="chevR" size={17} color={c.fgFaint} />
          </View>
        </View>

        {/* station */}
        <Group label={t('station.title')}>
          <Touchable
            haptic="none"
            onPress={() => setStationOpen(true)}
            style={styles.infoRow}
            pressedStyle={{ opacity: 0.6 }}
            accessibilityLabel={t('station.current')}
          >
            <Text style={styles.settingLabel}>{t('station.current')}</Text>
            <View style={styles.stationValue}>
              <Text numberOfLines={1} style={styles.infoValue}>
                {station?.name ?? '—'}
              </Text>
              <Icon name="chevR" size={16} color={c.fgFaint} />
            </View>
          </Touchable>
        </Group>

        {/* appearance */}
        <Group label={t('settings.appearance')}>
          <SettingRow label={t('settings.theme')} first>
            <Segmented
              items={[
                { id: 'system', label: t('settings.themeSystem') },
                { id: 'light', label: t('settings.themeLight') },
                { id: 'dark', label: t('settings.themeDark') },
              ]}
              value={theme}
              onChange={setTheme}
            />
          </SettingRow>
          <SettingRow label={t('settings.language')}>
            <Segmented items={[{ id: 'zh', label: '中文' }, { id: 'en', label: 'EN' }]} value={lang} onChange={setLang} />
          </SettingRow>
        </Group>

        {/* usage */}
        {user?.daily_message_limit || user?.monthly_token_limit ? (
          <Group label={t('settings.usage')}>
            {user?.daily_message_limit ? <InfoRow label={t('settings.dailyLimit')} value={String(user.daily_message_limit)} first /> : null}
            {user?.monthly_token_limit ? (
              <InfoRow label={t('settings.monthlyLimit')} value={`${Math.round(user.monthly_token_limit / 1000)}K`} first={!user?.daily_message_limit} />
            ) : null}
          </Group>
        ) : null}

        {/* about */}
        <Group label={t('settings.about')}>
          <InfoRow label={t('settings.version')} value={version} first />
          <LinkRow label={t('settings.privacy')} onPress={() => flash(t('common.comingSoon'))} />
          <LinkRow label={t('settings.terms')} onPress={() => flash(t('common.comingSoon'))} />
        </Group>

        <Touchable onPress={() => setConfirm(true)} style={styles.logout} pressedStyle={{ opacity: 0.85 }}>
          <Text style={styles.logoutText}>{t('settings.logout')}</Text>
        </Touchable>
        <Text style={styles.foot}>{t('settings.footer')}</Text>
      </ScrollView>

      <StationSheet visible={stationOpen} onClose={() => setStationOpen(false)} />

      <Sheet visible={confirm} onClose={() => setConfirm(false)} title={t('settings.logout')} heightPct={30}>
        <View style={{ padding: 18, paddingBottom: insets.bottom + 16 }}>
          <Text style={styles.confirmText}>{t('settings.logoutConfirm')}</Text>
          <Touchable onPress={doLogout} style={styles.confirmBtn} pressedStyle={{ opacity: 0.85 }}>
            <Text style={styles.confirmBtnText}>{t('settings.logout')}</Text>
          </Touchable>
          <Touchable onPress={() => setConfirm(false)} style={styles.cancelBtn} pressedStyle={{ opacity: 0.6 }}>
            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
          </Touchable>
        </View>
      </Sheet>

      {toast ? (
        <View style={styles.toastWrap} pointerEvents="none">
          <Toast message={toast} />
        </View>
      ) : null}
    </View>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={{ marginTop: 22 }}>
      <Text style={styles.groupLabel}>{label}</Text>
      <View style={styles.groupCard}>{children}</View>
    </View>
  );
}
function SettingRow({ label, children, first }: { label: string; children: React.ReactNode; first?: boolean }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={[styles.settingRow, !first && styles.rowDivider]}>
      <Text style={styles.settingLabel}>{label}</Text>
      <View style={{ flex: 1, maxWidth: 230 }}>{children}</View>
    </View>
  );
}
function InfoRow({ label, value, first }: { label: string; value: string; first?: boolean }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={[styles.infoRow, !first && styles.rowDivider]}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}
function LinkRow({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Touchable haptic="none" onPress={onPress} style={[styles.infoRow, styles.rowDivider]} pressedStyle={{ opacity: 0.6 }}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Icon name="chevR" size={16} color={c.fgFaint} />
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginLeft: -8 },
  title: { fontSize: font.displaySm, fontWeight: '700', color: c.fg, letterSpacing: -0.5 },

  account: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.hairline,
    padding: 14,
    marginTop: 4,
    ...shadow.card,
  },
  name: { fontSize: font.heading, fontWeight: '600', color: c.fg },
  email: { fontSize: font.small, color: c.fgMuted, marginTop: 2 },
  chevBox: { width: 28, height: 28, borderRadius: 14, backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center' },

  groupLabel: { fontSize: font.caption, fontWeight: '600', color: c.fgMuted, textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 2, paddingBottom: 8 },
  groupCard: { backgroundColor: c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: c.hairline, paddingHorizontal: 14 },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12, minHeight: 46 },
  infoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 13 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.hairline },
  settingLabel: { fontSize: font.body, color: c.fg },
  infoValue: { fontSize: font.label, color: c.fgMuted },
  stationValue: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minWidth: 0 },

  logout: { marginTop: 18, backgroundColor: c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: c.hairline, paddingVertical: 14, alignItems: 'center' },
  logoutText: { fontSize: font.body, fontWeight: '600', color: c.danger },
  foot: { textAlign: 'center', fontSize: font.caption, color: c.fgFaint, marginTop: 14 },

  confirmText: { fontSize: font.body, color: c.fgSecondary, lineHeight: 24, marginBottom: 18 },
  confirmBtn: { backgroundColor: c.danger, borderRadius: radius.lg, paddingVertical: 14, alignItems: 'center' },
  confirmBtnText: { fontSize: font.body, fontWeight: '600', color: '#fff' },
  cancelBtn: { paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  cancelText: { fontSize: font.body, fontWeight: '600', color: c.fgSecondary },

  toastWrap: { position: 'absolute', left: 0, right: 0, bottom: 24, alignItems: 'center' },
}));
