/**
 * A release's heads-up group (what the reader has to do) as a warning notice on the phone: the
 * warning tint behind, its icon beside the title. The browser draws the shared Callout
 * (./heads-up.web.tsx).
 */
import React from 'react';
import { Text, View } from 'react-native';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Icon } from '../ui/core';

export function HeadsUp({ title, children }: { title: string; children: React.ReactNode }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.box}>
      <View style={styles.titleRow}>
        <Icon name="alert" size={16} color={c.orange} />
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
      </View>
      {children}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  box: { backgroundColor: c.orangeFill, borderRadius: radius.md, ...squircle, padding: space.md, gap: space.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
}));
