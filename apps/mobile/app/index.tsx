/**
 * Home — the AI-first hero and app entry. A clean top bar (☰ burger left; 知识库
 * pill right), a "今天想做点什么？" headline, and the composer in the thumb zone.
 * Typing + sending starts a new conversation (no "+ new").
 *
 * History lives in the ☰ left drawer now: the drawer embeds a paginated,
 * infinite-scroll history list (compact rows) with a "查看更多" that opens the
 * full searchable HistorySheet; 设置 sits at the drawer bottom above 退出登录.
 */

import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../src/store/auth';
import { usePrefs } from '../src/store/prefs';
import { createSession } from '../src/api/sessions';
import type { Session } from '../src/shared/greenhouse-types';
import { Composer } from '../src/chat/composer';
import { ProfileSheet, useProfileName } from '../src/chat/profile-sheet';
import { HistorySheet, type OpenConversation } from '../src/chat/history-sheet';
import { DrawerHistory } from '../src/chat/history-list';
import { greeting } from '../src/lib/format';
import { useT } from '../src/lib/i18n';
import { useBottomPadStyle, useCollapsingInsetStyle } from '../src/lib/keyboard';
import { DrawerRow, Icon, MenuDrawer, SproutyFace, Touchable } from '../src/ui';
import { font, makeStyles, radius, shadow, useTheme } from '../src/theme';

export default function Home() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const nickname = user?.nickname ?? t('home.fallbackName');
  const profileId = usePrefs((s) => s.profileId);

  const profileName = useProfileName();

  const [input, setInput] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const rootPad = useBottomPadStyle(0);
  const barInset = useCollapsingInsetStyle(Math.max(insets.bottom, 8));

  const version = Constants.expoConfig?.version ?? '1.0.0';

  const startChat = useCallback(
    async (text: string) => {
      if (creating) return;
      setCreating(true);
      const s = await createSession(profileId, text.slice(0, 40));
      setCreating(false);
      if (!s) return; // keep the text so the user can retry
      setInput('');
      router.push({ pathname: '/chat/[id]', params: { id: s.id, initial: text } });
    },
    [creating, router, profileId],
  );

  const openConversation = useCallback(
    (c: OpenConversation) => {
      setHistoryOpen(false);
      router.push({ pathname: '/chat/[id]', params: { id: c.id, title: c.title, ro: c.readOnly ? '1' : '0' } });
    },
    [router],
  );

  // Drawer → open a conversation: close the drawer, then push (the drawer fades
  // out over the incoming screen).
  const openFromDrawer = useCallback(
    (s: Session) => {
      setDrawerOpen(false);
      router.push({
        pathname: '/chat/[id]',
        params: { id: s.id, title: s.title || t('chat.newConversation'), ro: s.is_owner === false ? '1' : '0' },
      });
    },
    [router, t],
  );

  // Drawer "查看更多" opens the full search sheet — wait for the drawer to clear
  // first so the two overlays don't fight.
  const openAllHistory = useCallback(() => {
    setDrawerOpen(false);
    setTimeout(() => setHistoryOpen(true), 180);
  }, []);

  const openSettings = useCallback(() => {
    setDrawerOpen(false);
    setTimeout(() => router.push('/settings'), 120);
  }, [router]);

  const onDrawerLogout = useCallback(() => {
    setDrawerOpen(false);
    setTimeout(() => {
      logout();
      router.replace('/login');
    }, 140);
  }, [logout, router]);

  return (
    <Animated.View style={[styles.root, rootPad]}>
      <View style={[styles.inner, { paddingTop: insets.top + 4 }]}>
        {/* top bar: ☰ burger left; agent + 知识库 pills right */}
        <View style={styles.topBar}>
          <Touchable haptic="none" onPress={() => setDrawerOpen(true)} style={styles.burger} hitSlop={6}>
            <Icon name="menu" size={24} color={c.fg} sw={2} />
          </Touchable>
          <View style={{ flex: 1 }} />
          <Touchable onPress={() => setProfileOpen(true)} style={styles.pill} pressedStyle={{ opacity: 0.7 }}>
            <Icon name="sparkle" size={15} color={c.accent} />
            <Text numberOfLines={1} style={[styles.pillLabel, { maxWidth: 120 }]}>
              {profileName ?? t('profile.title')}
            </Text>
          </Touchable>
          <Touchable onPress={() => router.push('/knowledge')} style={styles.pill} pressedStyle={{ opacity: 0.7 }}>
            <Icon name="book" size={15} color={c.accent} />
            <Text style={styles.pillLabel}>{t('home.knowledge')}</Text>
          </Touchable>
        </View>

        {/* hero */}
        <ScrollView contentContainerStyle={styles.hero} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={{ marginBottom: 14 }}>
            <SproutyFace expr="idle" size={84} />
          </View>
          <Text style={styles.greeting}>
            {greeting()}，{nickname}
          </Text>
          <Text style={styles.title}>{t('home.title')}</Text>
          <Text style={styles.sub}>{t('home.subtitle')}</Text>
        </ScrollView>

        {/* composer — full-width flat bar at the bottom */}
        <Composer
          hero
          barStyle={barInset}
          value={input}
          onChangeText={setInput}
          onSend={() => input.trim() && startChat(input.trim())}
          onAttach={() => {}}
          onMic={() => {}}
        />
      </View>

      <MenuDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        name={nickname}
        email={user?.email}
        version={version}
        onLogout={onDrawerLogout}
        footer={<DrawerRow icon="gear" label={t('drawer.settings')} onPress={openSettings} />}
      >
        <DrawerHistory onOpen={openFromDrawer} onViewAll={openAllHistory} />
      </MenuDrawer>

      <HistorySheet visible={historyOpen} onClose={() => setHistoryOpen(false)} onOpen={openConversation} />
      <ProfileSheet visible={profileOpen} onClose={() => setProfileOpen(false)} />
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  inner: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minHeight: 44,
  },
  burger: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingLeft: 11,
    paddingRight: 13,
    borderRadius: radius.full,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.hairline,
    ...shadow.card,
  },
  pillLabel: { fontSize: 13, fontWeight: '600', color: c.fgSecondary },
  hero: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 16 },
  greeting: { fontSize: 15, color: c.fgSecondary, fontWeight: '500', marginBottom: 10 },
  title: { fontSize: font.display, fontWeight: '700', color: c.fg, lineHeight: 38, letterSpacing: -0.5 },
  sub: { fontSize: 15, color: c.fgMuted, marginTop: 10, lineHeight: 22 },
}));
