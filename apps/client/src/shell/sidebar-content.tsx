import { nativeVisible, pluginHref } from '../plugins/navigation';
import { pluginIcon } from '../plugins/icons';
import { StationLine } from './station-line';
/**
 * The sidebar: the product's mark and name with search beside them (under the name, quietly, the
 * station it is on: a menu switches to another saved station or opens the stations sheet; with
 * one station a tap opens the sheet), the hub's places — 首页,
 * 知识库, 云盘, 项目, 定时任务 — and, at its foot, 「我」 (account, station, text size, My Agents, settings).
 * Choosing a place swaps the content beside it (each place keeps its own stack); search is a tool,
 * not a place: the round button in the header opens home's search page; 「我」 is its page sheet.
 *
 * On a phone it lies under the place (an edge swipe or the bar button slides the place aside;
 * choosing closes it), on a deeper surface than home's; reaching fully open taps once. On an iPad
 * at regular width it stays on screen as the split view's first column.
 */

import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useDrawerProgress, type DrawerContentComponentProps } from 'expo-router/drawer';
import { runOnJS, useAnimatedReaction, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT, type TranslationKey } from '../lib/i18n';

import { useAuth } from '../store/auth';

import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { useStationManifest } from '../plugins/store';
import { pluginNavigation } from '../plugins/manifest';
import { localize } from '../shared/plugins';
import { usePrefs } from '../store/prefs';
import { Avatar } from '../ui/avatar';
import { Icon, type IconName } from '../ui/core';
import { useFontScaleKey } from '../ui/font-scale';
import { GlassIconButton } from '../ui/glass';
import { selectionTick, tapLight } from '../ui/haptics';
import { GreenhouseMark } from '../ui/logo';

import { usePersistentSidebar } from '../ui/sidebar';

/** The places, in order; `route` is the drawer screen they swap in. */
const PLACES: { id: string; route: string; icon: IconName; title: TranslationKey }[] = [
  { id: 'home', route: '(home)', icon: 'home', title: 'nav.home' },
  { id: 'knowledge', route: 'knowledge', icon: 'book', title: 'nav.knowledge' },
  { id: 'drive', route: 'drive', icon: 'cloud', title: 'nav.files' },
  { id: 'projects', route: 'projects', icon: 'checklist', title: 'nav.projects' },
  { id: 'automations', route: 'automations', icon: 'clock', title: 'nav.automations' },
];

/**
 * One light tap when the drawer reaches fully open, by a swipe or the bar button: once per
 * opening (it re-arms only when the drawer is shut again), never for the permanent column.
 */
function useOpenedTap(persistent: boolean) {
  const progress = useDrawerProgress();
  const armed = useSharedValue(false);
  useAnimatedReaction(
    () => progress.value,
    (now, before) => {
      if (before === null || persistent) {
        armed.value = !persistent && now < 0.5;
        return;
      }
      if (now <= 0.02) armed.value = true;
      else if (now >= 0.98 && armed.value) {
        armed.value = false;
        runOnJS(tapLight)();
      }
    },
    [persistent],
  );
}

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
  const manifest = useStationManifest((s) => s.data);
  const lang = usePrefs((s) => s.lang);
  const current = state.routes[state.index]?.name;

  useOpenedTap(persistent);

  const close = () => {
    if (!persistent) navigation.closeDrawer();
  };
  const open = (place: (typeof PLACES)[number]) => {
    selectionTick();
    close();
    navigation.navigate(place.route);
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + space.sm }]}>
      <View style={styles.header}>
        {/* as tall as the name and the station line beside it */}
        <GreenhouseMark size={46} />
        <View style={styles.names}>
          <Text key={`brand:${fontKey}`} style={styles.brand} accessibilityRole="header" numberOfLines={1}>
            {productName}
          </Text>
          <StationLine onClose={close} />
        </View>
        <GlassIconButton
          icon="search"
          size={HIT - space.xs}
          iconSize={18}
          accessibilityLabel={t('common.search')}
          onPress={() => {
            close();
            router.push('/search');
          }}
        />
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {PLACES.filter(
          (place) => !['knowledge', 'projects'].includes(place.id) || nativeVisible(manifest, place.id),
        ).map((place) => (
          <Place
            key={place.id}
            icon={place.icon}
            label={t(place.title)}
            current={place.route === current}
            onPress={() => open(place)}
          />
        ))}
        {pluginNavigation(manifest, 'primary')
          .filter((item) => !['knowledge', 'projects', 'tables'].includes(item.plugin.id))
          .map((item) => (
            <Place
              key={`${item.plugin.id}:${item.nav.id}`}
              icon={pluginIcon(item.nav, item.page)}
              label={localize(item.nav.label, lang)}
              current={false}
              onPress={() => {
                close();
                router.push(pluginHref(item.plugin.id, item.page) as never);
              }}
            />
          ))}
        {pluginNavigation(manifest, 'more').length ? <Text style={styles.note}>{t('client.apps')}</Text> : null}
        {pluginNavigation(manifest, 'more').map((item) => (
          <Place
            key={`${item.plugin.id}:${item.nav.id}`}
            icon={pluginIcon(item.nav, item.page)}
            label={localize(item.nav.label, lang)}
            current={false}
            onPress={() => {
              close();
              router.push(pluginHref(item.plugin.id, item.page) as never);
            }}
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

function Place({
  icon,
  label,
  current,
  onPress,
}: {
  icon: IconName;
  label: string;
  current: boolean;
  onPress: () => void;
}) {
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
  root: { flex: 1, backgroundColor: c.sidebarBackground },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.margin + space.xs,
    paddingRight: space.margin,
    paddingTop: space.xs,
    paddingBottom: space.md,
  },
  names: { flex: 1, minWidth: 0 },
  brand: { ...typo.title2, fontWeight: weight.bold, color: c.label },
  stationRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: space.xxs, maxWidth: '100%' },
  station: { ...typo.caption1, color: c.secondaryLabel, flexShrink: 1 },
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
  current: { backgroundColor: c.sidebarSelection },
  texts: { flex: 1, minWidth: 0 },
  label: { ...typo.body, color: c.label, flexShrink: 1 },
  labelCurrent: { fontWeight: weight.semibold, color: c.accentText },
  note: { ...typo.caption1, color: c.secondaryLabel },
  footer: { paddingTop: space.sm },
}));
