/**
 * The hub's places that are not on the phone yet (src/shell/modules.ts `ready: false`):
 * Knowledge, Files, Projects, Tables — a large-title page with the system "coming soon" state,
 * so the drawer already shows the whole hub. Each becomes its own route as its phase lands.
 */

import React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useT } from '../../src/lib/i18n';
import { moduleOf } from '../../src/shell/modules';
import { makeStyles, space, useTheme } from '../../src/theme';
import { EmptyState } from '../../src/ui/empty';

export default function ModulePlaceholder() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const module = moduleOf(id);
  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: module ? t(module.title) : '' }} />
      <EmptyState
        icon={module?.icon ?? 'alert'}
        title={t('common.comingSoon')}
        message={t('common.comingSoonHint')}
        style={styles.state}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  state: { paddingTop: space.xxxl * 2 },
}));
