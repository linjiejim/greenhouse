/**
 * What the app shows instead of itself when the active station speaks another API (PRD §8.5,
 * AUTH-07; src/api/compat.ts): a newer server asks for a newer app; a v1 server cannot be used
 * by this app. Never a white screen: the station's name, why, and the way out — retry (after
 * updating), or another station.
 */

import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ApiMismatch } from '../api/compat';
import { useT } from '../lib/i18n';
import { useActiveStation } from '../stations/use-active-station';
import { useAuth } from '../store/auth';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { NativeButton } from '../ui/button';
import { Icon } from '../ui/core';
import { StationsForm } from '../stations/stations-form';
import { useFontScaleKey } from '../ui/font-scale';

export function MismatchScreen({ mismatch }: { mismatch: ApiMismatch }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const insets = useSafeAreaInsets();
  const station = useActiveStation();
  const fontKey = useFontScaleKey();
  const appOutdated = mismatch === 'app_outdated';
  return (
    <View style={[styles.root, { paddingTop: insets.top + space.xxl }]}>
      <ScrollView style={styles.messageScroll} contentContainerStyle={styles.message}>
        <Icon name={appOutdated ? 'download' : 'server'} size={40} color={c.accent} />
        <Text key={`title:${fontKey}`} style={styles.title} accessibilityRole="header">
          {t(appOutdated ? 'mismatch.appTitle' : 'mismatch.serverTitle')}
        </Text>
        <Text key={`body:${fontKey}`} style={styles.body}>
          {t(appOutdated ? 'mismatch.appBody' : 'mismatch.serverBody', { station: station?.name ?? '' })}
        </Text>
        <NativeButton
          label={t('common.retry')}
          variant="prominent"
          onPress={() => void useAuth.getState().bootstrap()}
        />
      </ScrollView>
      <View style={styles.stations}>
        <StationsForm onDone={() => undefined} onLeave={() => undefined} />
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  messageScroll: { flexGrow: 0, flexShrink: 1, maxHeight: '50%' },
  message: { alignItems: 'center', gap: space.md, paddingHorizontal: space.xxl, paddingBottom: space.lg },
  title: { ...typo.title2, fontWeight: weight.semibold, color: c.label, textAlign: 'center' },
  body: { ...typo.body, color: c.secondaryLabel, textAlign: 'center' },
  stations: { flex: 1 },
}));
