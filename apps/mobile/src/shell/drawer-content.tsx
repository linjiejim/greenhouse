/**
 * The drawer: the team hub's places (src/shell/modules.ts) — Home (动态/通知, with the unread
 * count), Knowledge, Files, Projects, Tables, My Agents, Assistant — and, pinned to the bottom, the active station (tap:
 * switch or add one) and Settings.
 *
 * Home is the drawer's own screen: choosing it closes the drawer. Every other place is a page
 * pushed by the root stack over home, so the system back gesture returns here.
 */

import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { DrawerContentComponentProps } from 'expo-router/drawer';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '../lib/i18n';
import { useActiveStation } from '../stations/use-active-station';
import { useAuth } from '../store/auth';
import { useNotifications } from '../store/notifications';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Icon, type IconName } from '../ui/core';
import { useFontScaleKey } from '../ui/font-scale';
import { selectionTick } from '../ui/haptics';
import { visibleModules, type HubModule } from './modules';

export function DrawerContent({ navigation }: DrawerContentComponentProps) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const fontKey = useFontScaleKey();
  const station = useActiveStation();
  const productName = useAuth((s) => s.station?.product_name) || 'Greenhouse';
  const unread = useNotifications((s) => s.unread);
  const user = useAuth((s) => s.user);

  const open = (module: HubModule) => {
    selectionTick();
    navigation.closeDrawer();
    if (module.href !== '/') router.push(module.href);
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + space.sm }]}>
      <Text key={`brand:${fontKey}`} style={styles.brand} accessibilityRole="header" numberOfLines={1}>
        {productName}
      </Text>
      <ScrollView style={styles.list}>
        {visibleModules(user).map((module) => (
          <Row
            key={module.id}
            icon={module.icon}
            label={t(module.title)}
            current={module.id === 'home'}
            badge={module.id === 'home' && unread > 0 ? unread : 0}
            onPress={() => open(module)}
          />
        ))}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
        <Row
          icon="server"
          label={station?.name ?? t('station.addFirst')}
          note={t('station.title')}
          onPress={() => {
            navigation.closeDrawer();
            router.push('/settings/stations');
          }}
        />
        <Row
          icon="gear"
          label={t('nav.settings')}
          onPress={() => {
            navigation.closeDrawer();
            router.push('/settings');
          }}
        />
      </View>
    </View>
  );
}

function Row({
  icon,
  label,
  note,
  badge = 0,
  current,
  onPress,
}: {
  icon: IconName;
  label: string;
  /** A second, quieter line (a place that is not here yet, what the row is). */
  note?: string;
  badge?: number;
  current?: boolean;
  onPress: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const fontKey = useFontScaleKey();
  const accessibilityLabel = [label, note, badge ? `${badge}` : ''].filter(Boolean).join(', ');
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: !!current }}
      style={({ pressed }) => [styles.row, current && styles.current, pressed && { backgroundColor: c.fill }]}
    >
      <Icon name={icon} size={20} color={current ? c.accent : c.label} />
      <View key={fontKey} style={styles.texts}>
        <Text style={[styles.label, current && styles.labelCurrent]} numberOfLines={1}>
          {label}
        </Text>
        {note ? (
          <Text style={styles.note} numberOfLines={1}>
            {note}
          </Text>
        ) : null}
      </View>
      {badge > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  brand: {
    ...typo.title2,
    fontWeight: weight.bold,
    color: c.label,
    paddingHorizontal: space.lg + 2,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: HIT + 4,
    marginHorizontal: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.md,
    ...squircle,
  },
  current: { backgroundColor: c.accentFill },
  texts: { flex: 1, minWidth: 0 },
  label: { ...typo.body, color: c.label },
  labelCurrent: { fontWeight: weight.semibold, color: c.accentText },
  note: { ...typo.caption1, color: c.secondaryLabel },
  badge: {
    minWidth: 22,
    minHeight: 22,
    paddingHorizontal: space.xs + 2,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accent,
  },
  badgeText: { ...typo.caption1, fontWeight: weight.semibold, color: c.onAccent, fontVariant: ['tabular-nums'] },
  footer: {
    borderTopWidth: 0.5,
    borderTopColor: c.separator,
    paddingTop: space.sm,
  },
}));
