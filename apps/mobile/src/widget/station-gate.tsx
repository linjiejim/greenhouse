/**
 * A screen opened from a widget link shows its item only on the station the link came from
 * (./model.ts `widgetStationGate`): it waits while the stations are read on a cold start, and on
 * any other station says the item is not available here instead of opening it.
 */

import React from 'react';
import { ScrollView, View } from 'react-native';
import { useT } from '../lib/i18n';
import { useStations } from '../store/stations';
import { makeStyles, space, useTheme } from '../theme';
import { EmptyState, LoadingState } from '../ui/empty';
import { ScreenChrome } from '../ui/split';
import { widgetStationGate } from './model';

export function WidgetStationGate({ station, children }: { station: string | undefined; children: React.ReactNode }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const hydrated = useStations((s) => s.hydrated);
  const activeId = useStations((s) => s.activeId);
  const name = useStations((s) => s.stations.find((record) => record.id === station)?.name);
  const gate = widgetStationGate(station, { hydrated, activeId });
  if (gate === 'open') return <>{children}</>;
  return (
    <View style={styles.root}>
      <ScreenChrome title="" />
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        {gate === 'wait' ? (
          <LoadingState style={styles.state} />
        ) : (
          <EmptyState
            icon="alert"
            title={t('common.otherStation')}
            message={name ? t('common.otherStationHint', { name }) : t('common.otherStationUnknown')}
            style={styles.state}
          />
        )}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  state: { paddingTop: space.xxxl },
}));
