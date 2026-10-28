/**
 * Static row skeletons preserve the list/sheet layout without a decorative loop.
 * A slow load also names the wait. Re-exported by ./empty on both platforms.
 */

import React, { useEffect, useState } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useT } from '../lib/i18n';
import { makeStyles, radius, space, typo, useTheme } from '../theme';

export function LoadingState({ style }: { style?: StyleProp<ViewStyle> }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View
      style={[styles.root, style]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('common.loading')}
      accessibilityState={{ busy: true }}
    >
      <View accessibilityElementsHidden aria-hidden importantForAccessibility="no-hide-descendants" style={styles.rows}>
        {[0, 1, 2].map((row) => (
          <View key={row} style={styles.row}>
            <View style={styles.icon} />
            <View style={styles.lines}>
              <View style={[styles.line, { width: row === 1 ? '55%' : '72%' }]} />
              <View style={[styles.line, styles.detail]} />
            </View>
          </View>
        ))}
      </View>
      {slow ? (
        <Text style={styles.label} accessibilityLiveRegion="polite">
          {t('common.loading')}
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flexGrow: 1, alignSelf: 'stretch', padding: space.margin, gap: space.lg },
  rows: {
    borderRadius: radius.lg,
    backgroundColor: c.secondaryGroupedBackground,
    padding: space.margin,
    gap: space.xxl,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon: { width: 32, height: 32, borderRadius: radius.sm, backgroundColor: c.tertiaryFill },
  lines: { flex: 1, gap: space.sm },
  line: { height: 16, borderRadius: radius.xs, backgroundColor: c.tertiaryFill },
  detail: { width: '40%', height: 12 },
  label: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center' },
}));
