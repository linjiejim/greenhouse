/**
 * Home — the AI-first hero and app entry. A clean top bar (☰ burger left; a
 * history / 知识库 / 项目 icon group right), a "今天想做点什么？" headline, and the
 * composer in the thumb zone. The agent-profile picker now lives on the composer
 * (a trigger above the input). Typing + sending starts a new conversation.
 *
 * The ☰ burger — and a left edge-swipe — open the native left drawer (account +
 * navigation directory + 设置 + 退出); its contents live in HomeDrawerContent,
 * wired by the drawer group layout (app/(drawer)/_layout.tsx).
 */

import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../src/store/auth';
import { usePrefs } from '../../src/store/prefs';
import { createSession } from '../../src/api/sessions';
import { Composer } from '../../src/chat/composer';
import { HistorySheet, type OpenConversation } from '../../src/chat/history-sheet';
import { ProfileSheet, useProfileName } from '../../src/chat/profile-sheet';
import { greeting } from '../../src/lib/format';
import { useT } from '../../src/lib/i18n';
import { useBottomPadStyle, useCollapsingInsetStyle } from '../../src/lib/keyboard';
import { Icon, IconName, SproutyFace, Touchable } from '../../src/ui';
import { font, makeStyles, useTheme } from '../../src/theme';

export default function Home() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const user = useAuth((s) => s.user);
  const nickname = user?.nickname ?? t('home.fallbackName');
  const profileId = usePrefs((s) => s.profileId);

  const profileName = useProfileName();
  // Home-screen widget "新对话" deep link (greenhouse://?compose=1) — drop
  // straight into typing.
  const { compose } = useLocalSearchParams<{ compose?: string }>();

  const [input, setInput] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const rootPad = useBottomPadStyle(0);
  const barInset = useCollapsingInsetStyle(Math.max(insets.bottom, 8));

  // The Drawer navigator injects openDrawer() on this screen's navigation.
  const openDrawer = useCallback(
    () => (navigation as unknown as { openDrawer: () => void }).openDrawer(),
    [navigation],
  );

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

  // Top-bar history icon → open a conversation from the popup.
  const openConversation = useCallback(
    (conv: OpenConversation) => {
      setHistoryOpen(false);
      router.push({ pathname: '/chat/[id]', params: { id: conv.id, title: conv.title, ro: conv.readOnly ? '1' : '0' } });
    },
    [router],
  );

  return (
    <Animated.View style={[styles.root, rootPad]}>
      <View style={[styles.inner, { paddingTop: insets.top + 4 }]}>
        {/* top bar: ☰ burger left; history / 知识库 / 项目 icon buttons right */}
        <View style={styles.topBar}>
          <Touchable haptic="none" onPress={openDrawer} style={styles.burger} hitSlop={6}>
            <Icon name="menu" size={24} color={c.fg} sw={2} />
          </Touchable>
          <View style={{ flex: 1 }} />
          <TopIcon icon="clock" label={t('home.history')} onPress={() => setHistoryOpen(true)} />
          <TopIcon icon="book" label={t('home.knowledge')} onPress={() => router.push('/knowledge')} />
          <TopIcon icon="folder" label={t('home.projects')} onPress={() => router.push('/projects')} />
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

        {/* composer — full-width flat bar at the bottom; agent picker above the input */}
        <Composer
          hero
          autoFocus={compose === '1'}
          barStyle={barInset}
          value={input}
          onChangeText={setInput}
          onSend={() => input.trim() && startChat(input.trim())}
          onAttach={() => {}}
          onMic={() => {}}
          profileName={profileName ?? t('profile.title')}
          onPickProfile={() => setProfileOpen(true)}
        />
      </View>

      <ProfileSheet visible={profileOpen} onClose={() => setProfileOpen(false)} />
      <HistorySheet visible={historyOpen} onClose={() => setHistoryOpen(false)} onOpen={openConversation} />
    </Animated.View>
  );
}

/** A round icon button for the Home top bar (comfortable hit area + a11y label). */
function TopIcon({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Touchable onPress={onPress} style={styles.iconBtn} pressedStyle={{ opacity: 0.6 }} hitSlop={6} accessibilityLabel={label}>
      <Icon name={icon} size={22} color={c.fg} sw={1.9} />
    </Touchable>
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
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  hero: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 16 },
  greeting: { fontSize: font.body, color: c.fgSecondary, fontWeight: '500', marginBottom: 10 },
  title: { fontSize: font.display, fontWeight: '700', color: c.fg, lineHeight: 38, letterSpacing: -0.5 },
  sub: { fontSize: font.body, color: c.fgMuted, marginTop: 10, lineHeight: 22 },
}));
