/**
 * The sidebar: the hub's places — 首页, 搜索, 知识库, 云盘, 项目 — and, at its foot, 「我」 (account,
 * station, text size, My Agents, settings). Choosing a place swaps the content beside it (each
 * place keeps its own stack); search is a page of home's stack; 「我」 is its page sheet.
 *
 * On a phone it is a drawer over home (an edge swipe or the bar button slides it out; choosing
 * closes it). On an iPad at regular width it stays on screen as the split view's first column.
 */

import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { DrawerContentComponentProps } from 'expo-router/drawer';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT, type TranslationKey } from '../lib/i18n';
import { useAuth } from '../store/auth';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Avatar } from '../ui/avatar';
import { Icon, type IconName } from '../ui/core';
import { useFontScaleKey } from '../ui/font-scale';
import { selectionTick } from '../ui/haptics';
import { usePersistentSidebar } from '../ui/sidebar';

/** The places, in order; `route` is the drawer screen they swap in. */
const PLACES: { id: string; route: string | null; icon: IconName; title: TranslationKey }[] = [
  { id: 'home', route: '(home)', icon: 'home', title: 'nav.home' },
  { id: 'search', route: null, icon: 'search', title: 'common.search' },
  { id: 'knowledge', route: 'knowledge', icon: 'book', title: 'nav.knowledge' },
  { id: 'drive', route: 'drive', icon: 'cloud', title: 'nav.files' },
  { id: 'projects', route: 'projects', icon: 'checklist', title: 'nav.projects' },
];

export function SidebarContent({ state, navigation }: DrawerContentComponentProps) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const fontKey = useFontScaleKey();
  const persistent = usePersistentSidebar();
  const productName = useAuth((s) => s.station?.product_name) || 'Greenhouse';
  const user = useAuth((s) => s.user);
  const current = state.routes[state.index]?.name;

  const close = () => {
    if (!persistent) navigation.closeDrawer();
  };
  const open = (place: (typeof PLACES)[number]) => {
    selectionTick();
    close();
    if (place.route) navigation.navigate(place.route);
    else router.push('/search');
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + space.sm }]}>
      <Text key={`brand:${fontKey}`} style={styles.brand} accessibilityRole="header" numberOfLines={1}>
        {productName}
      </Text>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {PLACES.map((place) => (
          <Place
            key={place.id}
            icon={place.icon}
            label={t(place.title)}
            current={place.route !== null && place.route === current}
            onPress={() => open(place)}
          />
        ))}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
        <Pressable
          onPress={() => {
            close();
            router.push('/me');
          }}
          accessibilityRole="button"
          accessibilityLabel={[user?.nickname, t('nav.settings')].filter(Boolean).join(t('common.listSep'))}
          style={({ pressed }) => [styles.place, pressed && { backgroundColor: c.fill }]}
        >
          <Avatar name={user?.nickname || '?'} size={28} />
          <View key={fontKey} style={styles.texts}>
            <Text style={styles.label} numberOfLines={1}>
              {user?.nickname || t('me.title')}
            </Text>
            <Text style={styles.note} numberOfLines={1}>
              {t('nav.settings')}
            </Text>
          </View>
          <Icon name="gear" size={18} color={c.secondaryLabel} />
        </Pressable>
      </View>
    </View>
  );
}

function Place({ icon, label, current, onPress }: { icon: IconName; label: string; current: boolean; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const fontKey = useFontScaleKey();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: current }}
      style={({ pressed }) => [styles.place, current && styles.current, pressed && { backgroundColor: c.fill }]}
    >
      <Icon name={icon} size={20} color={current ? c.accentText : c.label} />
      <Text key={fontKey} style={[styles.label, current && styles.labelCurrent]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  brand: {
    ...typo.title2,
    fontWeight: weight.bold,
    color: c.label,
    paddingHorizontal: space.margin + space.xs,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
  list: { flex: 1 },
  listContent: { gap: space.xxs },
  place: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: HIT,
    marginHorizontal: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.md,
    ...squircle,
  },
  current: { backgroundColor: c.accentFill },
  texts: { flex: 1, minWidth: 0 },
  label: { ...typo.body, color: c.label, flexShrink: 1 },
  labelCurrent: { fontWeight: weight.semibold, color: c.accentText },
  note: { ...typo.caption1, color: c.secondaryLabel },
  footer: { paddingTop: space.sm },
}));
