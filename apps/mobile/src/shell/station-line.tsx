import React, { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useStationsForm } from '../stations/use-stations-form';
import { hostLabel, useStations, type StationRecord } from '../store/stations';
import { makeStyles, space, typo, useTheme } from '../theme';
import { useT } from '../lib/i18n';
import { useFontScaleKey } from '../ui/font-scale';
import { Icon } from '../ui/core';
import { NativeMenu, menuSections } from '../ui/menu';
/** The menu item that opens the stations sheet. */
const MANAGE = '__manage';

const stationName = (station: StationRecord) => station.name || hostLabel(station.baseUrl);

/**
 * The station under the product name, quiet: a tap lists the saved stations to switch to (probed
 * first, src/stations/use-stations-form.ts) and 管理工作站… (the stations sheet); with one station
 * the tap opens the sheet straight away.
 */
export function StationLine({ onClose }: { onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const fontKey = useFontScaleKey();
  const stations = useStations((s) => s.stations);
  const activeId = useStations((s) => s.activeId);
  const active = stations.find((station) => station.id === activeId);
  // a switch reroutes from the root: nothing may stay presented over it
  const leave = useCallback(() => {
    onClose();
    if (router.canDismiss()) router.dismissAll();
  }, [onClose, router]);
  const form = useStationsForm({ onDone: onClose, onLeave: leave });
  if (!active) return null;
  const manage = () => {
    onClose();
    router.push('/sheets/stations');
  };
  const line = (
    <View key={fontKey} style={styles.stationRow}>
      <Text style={styles.station} numberOfLines={1}>
        {stationName(active)}
      </Text>
      <Icon name="chevUpDown" size={11} color={c.secondaryLabel} />
    </View>
  );
  const label = `${t('station.title')}${t('common.listSep')}${stationName(active)}`;
  if (stations.length <= 1) {
    return (
      <Pressable onPress={manage} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}>
        {line}
      </Pressable>
    );
  }
  return (
    <NativeMenu
      fill
      title={t('station.title')}
      items={menuSections([
        stations.map((station) => ({
          id: station.id,
          title: stationName(station),
          icon: 'server',
          checked: station.id === activeId,
        })),
        [{ id: MANAGE, title: t('station.manage'), icon: 'gear' }],
      ])}
      onSelect={(id) => {
        if (id === MANAGE) return manage();
        const station = stations.find((item) => item.id === id);
        if (station) void form.select(station);
      }}
    >
      <View accessible accessibilityRole="button" accessibilityLabel={label}>
        {line}
      </View>
    </NativeMenu>
  );
}

const useStyles = makeStyles((c) => ({
  stationRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: space.xxs, maxWidth: '100%' },
  station: { ...typo.caption1, color: c.secondaryLabel, flexShrink: 1 },
}));
